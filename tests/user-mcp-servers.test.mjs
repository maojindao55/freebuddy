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

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // Create required tables for MCP servers
  db.exec(`
    CREATE TABLE user_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      env TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_check_status TEXT,
      last_check_error TEXT,
      last_check_tools TEXT,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      adapter TEXT NOT NULL,
      cwd TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
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

// Test 2: MCP servers DB CRUD operations (via dist-electron)
test("MCP servers DB CRUD roundtrip", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  const db = makeDb();
  const {
    setDbForTest,
    listUserMcpServers,
    createUserMcpServer,
    getUserMcpServer,
    updateUserMcpServer,
    deleteUserMcpServer,
    setUserMcpServerEnabled,
  } = await import("../dist-electron/cli/mcpServers.js");
  setDbForTest(db);

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

// Test 3: Server name validation (reserved prefix)
test("MCP server name cannot start with 'freebuddy'", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  const db = makeDb();
  const { setDbForTest, createUserMcpServer } = await import(
    "../dist-electron/cli/mcpServers.js"
  );
  setDbForTest(db);

  assert.throws(
    () => {
      createUserMcpServer({
        name: "freebuddy-custom",
        command: "npx",
      });
    },
    /reserved prefix/i,
    "Should reject names starting with 'freebuddy'"
  );

  assert.throws(
    () => {
      createUserMcpServer({
        name: "FREEBUDDY-test",
        command: "npx",
      });
    },
    /reserved prefix/i,
    "Should reject names with case-insensitive match"
  );
});

// Test 4: Conversation MCP server IDs storage
test("Conversation MCP server IDs CRUD", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  const db = makeDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO conversations (id, title, agent_id, agent_name, adapter, created_at, updated_at)
     VALUES ('conv-1', 'Test Conv', 'agent-1', 'TestAgent', 'codex', ?, ?)`
  ).run(now, now);

  const {
    setDbForTest,
    getConversationMcpServerIds,
    setConversationMcpServerIds,
  } = await import("../dist-electron/cli/conversations.js");
  setDbForTest(db);

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

// Test 5: isRemoteMcpAllowed function
test("isRemoteMcpAllowed returns false for non-admin remote users", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  // This test verifies the behavior by checking the source code pattern
  const mcpServersSource = fs.readFileSync(
    new URL("cli/mcpServers.ts", electronDir),
    "utf8"
  );
  
  // isRemoteMcpAllowed should check isCallerAdmin() and getCallerUserId()
  assert.match(
    mcpServersSource,
    /isRemoteMcpAllowed.*isCallerAdmin/s,
    "isRemoteMcpAllowed should check admin status"
  );
});

// Test 6: userMcpServerToAcpFormat conversion
test("userMcpServerToAcpFormat converts server config correctly", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  const db = makeDb();
  const {
    setDbForTest,
    createUserMcpServer,
    userMcpServerToAcpFormat,
  } = await import("../dist-electron/cli/mcpServers.js");
  setDbForTest(db);

  const server = createUserMcpServer({
    name: "test-filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "${cwd}"],
    env: [{ name: "NODE_ENV", value: "production" }],
    enabled: true,
  });

  const acpFormat = userMcpServerToAcpFormat(server, "/test/project");
  assert.equal(acpFormat.name, "test-filesystem");
  assert.ok(acpFormat.command.includes("npx") || acpFormat.command === "npx");
  // ${cwd} should be substituted
  assert.ok(
    acpFormat.args.some((arg) => arg.includes("/test/project")),
    "Should substitute ${cwd} in args"
  );
  assert.deepEqual(acpFormat.env, [{ name: "NODE_ENV", value: "production" }]);
});

// Test 7: getEnabledUserMcpServersByIds filters disabled servers
test("getEnabledUserMcpServersByIds only returns enabled servers", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  const db = makeDb();
  const {
    setDbForTest,
    createUserMcpServer,
    setUserMcpServerEnabled,
    getEnabledUserMcpServersByIds,
  } = await import("../dist-electron/cli/mcpServers.js");
  setDbForTest(db);

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

// Test 8: Delegation does not inherit MCP server IDs
test("delegation runtime does not pass mcpServerIds to child agents", () => {
  const delegationRuntimeSource = fs.readFileSync(
    new URL("cli/delegationRuntime.ts", electronDir),
    "utf8"
  );

  // The delegation runtime's runAgentTurn should NOT include mcpServerIds
  // Search for the runAgent call and verify mcpServerIds is not in the args
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

// Test 9: Handoff carries MCP selection by default
test("handoff transfers MCP server IDs from source conversation", () => {
  const ipcSource = fs.readFileSync(
    new URL("cli/ipc.ts", electronDir),
    "utf8"
  );

  // The transferConversation handler should read source MCP server IDs
  assert.match(
    ipcSource,
    /getConversationMcpServerIds.*source\.id/s,
    "Should read source conversation's MCP server IDs"
  );

  // Should write to transfer metadata
  assert.match(
    ipcSource,
    /transferMetadata\.mcpServerIds/,
    "Should include mcpServerIds in transfer metadata"
  );
});

// Test 10: TransferConversationInput accepts mcpServerIds override
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

// Test 11: ACP runtime merges user MCP servers
test("ACP runtime merges user MCP servers after built-in servers", () => {
  const acpRuntimeSource = fs.readFileSync(
    new URL("cli/acpRuntime.ts", electronDir),
    "utf8"
  );

  // Should check args.mcpServerIds
  assert.match(
    acpRuntimeSource,
    /args\.mcpServerIds\?\.length/,
    "Should check for mcpServerIds in args"
  );

  // Should call getEnabledUserMcpServersByIds
  assert.match(
    acpRuntimeSource,
    /getEnabledUserMcpServersByIds/,
    "Should fetch user MCP servers by IDs"
  );

  // Should check isRemoteMcpAllowed
  assert.match(
    acpRuntimeSource,
    /isRemoteMcpAllowed\(\)/,
    "Should check if remote MCP is allowed"
  );
});

// Test 12: Secret env values are encrypted
test("MCP server secret env values are encrypted", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  const mcpServersSource = fs.readFileSync(
    new URL("cli/mcpServers.ts", electronDir),
    "utf8"
  );

  // Should use encryptSecret for secret values
  assert.match(
    mcpServersSource,
    /encryptSecret\(/,
    "Should encrypt secret values"
  );

  // Should use decryptSecret when resolving for runtime
  assert.match(
    mcpServersSource,
    /decryptSecret\(/,
    "Should decrypt secrets when resolving for runtime"
  );
});
