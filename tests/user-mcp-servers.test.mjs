import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

// better-sqlite3 is a native binding compiled for either Electron or Node.
// When postinstall runs electron-rebuild, the binding targets Electron's
// NODE_MODULE_VERSION and CLI Node can't load it. Skip these DB integration
// tests in that case (CI environments where the binding matches will run them).
let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  // The native .node file loads lazily on first instantiation; probe it.
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

const electronDir = new URL("../electron/", import.meta.url);

async function transpileAndImport(relativePath) {
  const source = fs.readFileSync(new URL(relativePath, electronDir), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
  );
}

async function makeDbWithMigration() {
  const db = new Database(":memory:");
  const { setDbForTest, migrate } = await import("../dist-electron/cli/db.js");
  setDbForTest(db);
  migrate(db);
  return db;
}

// Test 1: Remote channel policy for MCP server channels
test("MCP server IPC channels are admin-only (not accessible to remote users)", async () => {
  const { classifyRemoteChannel, isRemoteChannelCallable } =
    await transpileAndImport("shared/remoteChannelPolicy.ts");

  const mcpChannels = [
    "mcpServers:list",
    "mcpServers:get",
    "mcpServers:create",
    "mcpServers:update",
    "mcpServers:delete",
    "mcpServers:setEnabled",
    "mcpServers:selfCheck",
    "cli:getConversationMcpServerIds",
    "cli:setConversationMcpServerIds",
  ];

  for (const channel of mcpChannels) {
    assert.equal(
      classifyRemoteChannel(channel),
      "adminOnly",
      `${channel} should be admin-only`
    );
    assert.equal(
      isRemoteChannelCallable(channel, false),
      false,
      `${channel} should not be callable by remote non-admin users`
    );
    assert.equal(
      isRemoteChannelCallable(channel, true),
      true,
      `${channel} should be callable by admin users`
    );
  }
});

// Test 2: MCP servers DB CRUD operations
test("MCP servers DB CRUD roundtrip", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  await makeDbWithMigration();
  const {
    listUserMcpServers,
    createUserMcpServer,
    getUserMcpServer,
    updateUserMcpServer,
    deleteUserMcpServer,
    setUserMcpServerEnabled,
  } = await import("../dist-electron/cli/mcpServers.js");

  // Create
  const server = createUserMcpServer({
    name: "test-server",
    command: "npx",
    args: ["-y", "@test/server"],
    env: [{ name: "API_KEY", value: "secret", secret: true }],
    enabled: true,
  });
  assert.ok(server.id.startsWith("mcp-"));
  assert.equal(server.name, "test-server");
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", "@test/server"]);
  assert.equal(server.enabled, true);

  // List
  const list = listUserMcpServers();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "test-server");

  // Get
  const fetched = getUserMcpServer(server.id);
  assert.equal(fetched?.name, "test-server");

  // Update
  const updated = updateUserMcpServer(server.id, {
    name: "updated-server",
    args: ["--new-arg"],
  });
  assert.equal(updated?.name, "updated-server");
  assert.deepEqual(updated?.args, ["--new-arg"]);

  // Toggle enabled
  const toggled = setUserMcpServerEnabled(server.id, false);
  assert.equal(toggled, true);
  const afterToggle = getUserMcpServer(server.id);
  assert.equal(afterToggle?.enabled, false);

  // Delete
  const deleted = deleteUserMcpServer(server.id);
  assert.equal(deleted, true);
  const afterDelete = getUserMcpServer(server.id);
  assert.equal(afterDelete, undefined);
});

// Test 3: Server name validation (reserved prefix and builtin names)
test("MCP server name validation rejects reserved names", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  await makeDbWithMigration();
  const { createUserMcpServer } = await import(
    "../dist-electron/cli/mcpServers.js"
  );

  assert.throws(
    () => {
      createUserMcpServer({
        name: "freebuddy-custom",
        command: "npx",
      });
    },
    /reserved/i,
    "Should reject names starting with 'freebuddy'"
  );

  assert.throws(
    () => {
      createUserMcpServer({
        name: "FREEBUDDY-test",
        command: "npx",
      });
    },
    /reserved/i,
    "Should reject names with case-insensitive match"
  );

  assert.throws(
    () => {
      createUserMcpServer({
        name: "office-engine",
        command: "npx",
      });
    },
    /reserved/i,
    "Should reject builtin name 'office-engine'"
  );

  assert.throws(
    () => {
      createUserMcpServer({
        name: "Office-Engine",
        command: "npx",
      });
    },
    /reserved/i,
    "Should reject builtin name case-insensitively"
  );
});

// Test 3b: Case-insensitive uniqueness check
test("MCP server name must be unique (case-insensitive)", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  await makeDbWithMigration();
  const { createUserMcpServer } = await import(
    "../dist-electron/cli/mcpServers.js"
  );

  createUserMcpServer({
    name: "My Server",
    command: "npx",
  });

  assert.throws(
    () => {
      createUserMcpServer({
        name: "my server",
        command: "npx",
      });
    },
    /already exists/i,
    "Should reject duplicate names case-insensitively"
  );

  assert.throws(
    () => {
      createUserMcpServer({
        name: "MY SERVER",
        command: "npx",
      });
    },
    /already exists/i,
    "Should reject duplicate names with different case"
  );
});

// Test 4: Conversation MCP server IDs storage
test("Conversation MCP server IDs CRUD", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  await makeDbWithMigration();
  const { createConversation } = await import("../dist-electron/cli/conversations.js");
  const {
    getConversationMcpServerIds,
    setConversationMcpServerIds,
  } = await import("../dist-electron/cli/conversations.js");

  // Create a conversation
  createConversation({
    id: "conv-1",
    title: "Test Conv",
    agentId: "agent-1",
    agentName: "TestAgent",
    adapter: "codex",
  });

  // Initially empty
  const initial = getConversationMcpServerIds("conv-1");
  assert.deepEqual(initial, []);

  // Set MCP server IDs
  setConversationMcpServerIds("conv-1", ["mcp-1", "mcp-2"]);
  const after = getConversationMcpServerIds("conv-1");
  assert.deepEqual(after, ["mcp-1", "mcp-2"]);

  // Update to different IDs
  setConversationMcpServerIds("conv-1", ["mcp-3"]);
  const afterUpdate = getConversationMcpServerIds("conv-1");
  assert.deepEqual(afterUpdate, ["mcp-3"]);

  // Clear
  setConversationMcpServerIds("conv-1", []);
  const afterClear = getConversationMcpServerIds("conv-1");
  assert.deepEqual(afterClear, []);
});

// Test 5: getEnabledUserMcpServersByIds filters disabled servers
test("getEnabledUserMcpServersByIds only returns enabled servers", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  await makeDbWithMigration();
  const {
    createUserMcpServer,
    setUserMcpServerEnabled,
    getEnabledUserMcpServersByIds,
  } = await import("../dist-electron/cli/mcpServers.js");

  const server1 = createUserMcpServer({
    name: "enabled-server",
    command: "npx",
    enabled: true,
  });
  const server2 = createUserMcpServer({
    name: "disabled-server",
    command: "npx",
    enabled: true,
  });
  setUserMcpServerEnabled(server2.id, false);

  const result = getEnabledUserMcpServersByIds([server1.id, server2.id]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "enabled-server");
});

// Test 6: Secret env value redaction
test("collectSecretValues and redactSecrets work correctly", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  await makeDbWithMigration();
  const { collectSecretValues, redactSecrets } = await import(
    "../dist-electron/cli/mcpServers.js"
  );

  // Test collecting secrets
  const env = [
    { name: "API_KEY", value: "my-secret-key-12345", secret: true },
    { name: "PUBLIC_VAR", value: "public-value", secret: false },
    { name: "DB_PASSWORD", value: "hunter2", secret: true },
  ];
  const secrets = collectSecretValues(env);
  assert.ok(secrets.includes("my-secret-key-12345"));
  assert.ok(secrets.includes("hunter2"));
  assert.ok(!secrets.includes("public-value"));

  // Test redacting
  const text = "Error: connection failed with password hunter2 to server";
  const redacted = redactSecrets(text, secrets);
  assert.ok(!redacted.includes("hunter2"));
  assert.ok(redacted.includes("<redacted>"));
});

// Test 7: Delegation runtime does not pass mcpServerIds to child agents
test("delegation runtime does not pass mcpServerIds to child agents", () => {
  const delegationRuntimeSource = fs.readFileSync(
    new URL("cli/delegationRuntime.ts", electronDir),
    "utf8"
  );

  // The delegation runtime's runAgentTurn should NOT include mcpServerIds
  const runAgentMatch = delegationRuntimeSource.match(
    /this\.deps\.runAgent\(\{[\s\S]*?\}\)/
  );
  assert.ok(runAgentMatch, "Should find runAgent call in delegationRuntime");
  assert.doesNotMatch(
    runAgentMatch[0],
    /mcpServerIds/,
    "runAgent call should not include mcpServerIds - delegation should not inherit MCP selection"
  );
});

// Test 8: ACP runtime reads MCP server IDs from database
test("ACP runtime reads MCP server IDs from database (not from args)", () => {
  const acpRuntimeSource = fs.readFileSync(
    new URL("cli/acpRuntime.ts", electronDir),
    "utf8"
  );

  // Should import getConversationMcpServerIds
  assert.match(
    acpRuntimeSource,
    /import.*getConversationMcpServerIds.*from.*conversations/,
    "Should import getConversationMcpServerIds from conversations"
  );

  // Should call getConversationMcpServerIds with conversationId
  assert.match(
    acpRuntimeSource,
    /getConversationMcpServerIds\s*\(\s*args\.conversationId\s*\)/,
    "Should read MCP server IDs from database using conversation ID"
  );
});

// Test 9: Handoff carries MCP selection by default and supports override
test("handoff transfers MCP server IDs and supports override", () => {
  const ipcSource = fs.readFileSync(
    new URL("cli/ipc.ts", electronDir),
    "utf8"
  );

  // Check that transferConversation checks for input.mcpServerIds override
  assert.match(
    ipcSource,
    /input\.mcpServerIds/,
    "Should check for mcpServerIds in transfer input"
  );

  // Check that it falls back to source conversation
  assert.match(
    ipcSource,
    /getConversationMcpServerIds.*source\.id/s,
    "Should read source conversation's MCP server IDs as fallback"
  );
});

// Test 10: TransferConversationInput allows mcpServerIds override
test("TransferConversationInput allows mcpServerIds override", () => {
  const handoffTypesSource = fs.readFileSync(
    new URL("shared/handoffTypes.ts", electronDir),
    "utf8"
  );

  assert.match(
    handoffTypesSource,
    /interface TransferConversationInput[\s\S]*?mcpServerIds\?: string\[\]/,
    "TransferConversationInput should have optional mcpServerIds field"
  );
});

// Test 11: MCP server secret env values are encrypted
test("MCP server secret env values are encrypted", () => {
  const mcpServersSource = fs.readFileSync(
    new URL("cli/mcpServers.ts", electronDir),
    "utf8"
  );

  assert.match(
    mcpServersSource,
    /encryptSecret\(/,
    "Should encrypt secret values"
  );

  assert.match(
    mcpServersSource,
    /decryptSecret\(/,
    "Should decrypt secrets when resolving for runtime"
  );
});

// Test 12: Self-check always settles (handles exit code 0 without response)
test("Self-check handles exit code 0 without response", () => {
  const mcpServersSource = fs.readFileSync(
    new URL("cli/mcpServers.ts", electronDir),
    "utf8"
  );

  // Should handle the case where process exits with code 0 but no response
  assert.match(
    mcpServersSource,
    /Process exited without completing MCP handshake/,
    "Should handle exit code 0 without response"
  );
});

// Test 13: Duplicate env vars are deduplicated by name
test("Duplicate env vars are deduplicated by name", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  await makeDbWithMigration();
  const { createUserMcpServer, getUserMcpServer } = await import(
    "../dist-electron/cli/mcpServers.js"
  );

  const server = createUserMcpServer({
    name: "dedupe-test",
    command: "npx",
    env: [
      { name: "API_KEY", value: "first", secret: false },
      { name: "API_KEY", value: "second", secret: false },
      { name: "OTHER", value: "value", secret: false },
    ],
  });

  const fetched = getUserMcpServer(server.id);
  assert.equal(fetched?.env.length, 2, "Should dedupe to 2 unique env vars");
  const apiKeyVar = fetched?.env.find((e) => e.name === "API_KEY");
  assert.equal(apiKeyVar?.value, "first", "Should keep first occurrence");
});

// Test 14: MCP config is included in warm fingerprint
test("MCP config is included in warm fingerprint", () => {
  const runtimeSource = fs.readFileSync(
    new URL("cli/runtime.ts", electronDir),
    "utf8"
  );

  assert.match(
    runtimeSource,
    /mcpServerIds.*getConversationMcpServerIds/,
    "Should retrieve MCP server IDs for fingerprint"
  );

  assert.match(
    runtimeSource,
    /mcpServerIds:.*\.sort\(\)/,
    "Should include sorted MCP server IDs in fingerprint"
  );
});

// Test 15: MCP tab is hidden for non-owner remote users
test("MCP tab is hidden for non-owner remote users", () => {
  const settingsModalSource = fs.readFileSync(
    new URL("../src/components/Settings/SettingsModal.tsx", import.meta.url),
    "utf8"
  );

  assert.match(
    settingsModalSource,
    /currentUser && !currentUser\.isOwner/,
    "Should check for non-owner remote users"
  );

  assert.match(
    settingsModalSource,
    /hidden\.push\("mcp"\)/,
    "Should hide MCP tab for non-owner users"
  );

  assert.match(
    settingsModalSource,
    /hiddenTabs.*SettingsTab/,
    "Should have hiddenTabs prop"
  );
});
