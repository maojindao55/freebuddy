import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
    name: "MyServer",
    command: "npx",
  });

  assert.throws(
    () => {
      createUserMcpServer({
        name: "myserver",
        command: "npx",
      });
    },
    /already exists/i,
    "Should reject duplicate names case-insensitively"
  );

  assert.throws(
    () => {
      createUserMcpServer({
        name: "MYSERVER",
        command: "npx",
      });
    },
    /already exists/i,
    "Should reject duplicate names with different case"
  );

  assert.throws(
    () => createUserMcpServer({ name: "has space", command: "npx" }),
    /must match/i
  );
  assert.throws(
    () => createUserMcpServer({ name: "", command: "npx" }),
    /must match/i
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
    command: process.execPath,
    enabled: true,
  });
  const server2 = createUserMcpServer({
    name: "disabled-server",
    command: process.execPath,
    enabled: true,
  });
  setUserMcpServerEnabled(server2.id, false);

  const result = await getEnabledUserMcpServersByIds([server1.id, server2.id]);
  assert.equal(result.servers.length, 1);
  assert.equal(result.servers[0].name, "enabled-server");
  assert.equal(path.isAbsolute(result.servers[0].command), true);
  assert.equal(result.skipped.length, 0);
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

test("delegated and workflow runs do not inherit conversation user MCP servers", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  await makeDbWithMigration();
  const { createConversation, setConversationMcpServerIds } = await import(
    "../dist-electron/cli/conversations.js"
  );
  const { createUserMcpServer, resolveConversationUserMcpServers } = await import(
    "../dist-electron/cli/mcpServers.js"
  );

  const server = createUserMcpServer({
    name: "parent-only",
    command: process.execPath,
    enabled: true,
  });
  createConversation({
    id: "conv-inherit",
    title: "Parent",
    agentId: "agent-1",
    agentName: "Parent",
    adapter: "codex",
  });
  setConversationMcpServerIds("conv-inherit", [server.id]);

  const normal = await resolveConversationUserMcpServers({
    conversationId: "conv-inherit",
    toolSessionScope: "task-cwd",
  });
  assert.equal(normal.servers.length, 1);
  assert.equal(normal.servers[0].name, "parent-only");
  assert.equal(normal.skipped.length, 0);

  const delegated = await resolveConversationUserMcpServers({
    conversationId: "conv-inherit",
    delegation: { runId: "run-1", parentEventId: "ev", depth: 1, selfAgentId: "child", selfLabel: "Child" },
    toolSessionScope: "delegate:run-1",
  });
  assert.deepEqual(delegated.servers, []);
  assert.deepEqual(delegated.skipped, []);

  const workflow = await resolveConversationUserMcpServers({
    conversationId: "conv-inherit",
    toolSessionScope: "workflow:run-1:step-1:agent-1",
  });
  assert.deepEqual(workflow.servers, []);
  assert.deepEqual(workflow.skipped, []);
});

test("ACP runtime resolves user MCP through the inheritance gate", () => {
  const acpRuntimeSource = fs.readFileSync(
    new URL("cli/acpRuntime.ts", electronDir),
    "utf8"
  );
  assert.match(
    acpRuntimeSource,
    /resolveConversationUserMcpServers\s*\(/,
    "Should resolve user MCP through the shared gate"
  );
  assert.match(
    acpRuntimeSource,
    /delegation:\s*args\.delegation/,
    "Should pass delegation into the gate"
  );
  assert.match(
    acpRuntimeSource,
    /toolSessionScope:\s*args\.toolSessionScope/,
    "Should pass the tool session scope into the gate"
  );
  assert.doesNotMatch(
    acpRuntimeSource,
    /args\.mcpServerIds/,
    "Should not trust renderer-supplied MCP ids"
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
  assert.match(
    runtimeSource,
    /mcpConfig:\s*mcpConfigFingerprint\(mcpServerIds\)/,
    "Should include MCP config in the warm fingerprint"
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

// Test 16: Async command resolution with error handling
test("resolveCommandPath handles command_not_found and relative paths", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  const { resolveCommandPath } = await import(
    "../dist-electron/cli/mcpServers.js"
  );

  // Test command_not_found for non-existent command
  const nonExistent = await resolveCommandPath("definitely-not-a-command-12345");
  assert.equal(nonExistent.error, "command_not_found");

  // Test relative path rejection without cwd
  const relativeNoCwd = await resolveCommandPath("./my-script");
  assert.equal(relativeNoCwd.error, "relative_path_rejected");

  // Test valid command (npx should exist in PATH)
  const npx = await resolveCommandPath("npx");
  if (npx.error) {
    t.skip("npx not found in PATH");
    return;
  }
  assert.ok(npx.command.includes("npx") || npx.command.includes("npm"));
});

// Test 17: Log redaction in acpRuntime
test("acpRuntime redacts secrets from log messages", () => {
  const acpRuntimeSource = fs.readFileSync(
    new URL("cli/acpRuntime.ts", electronDir),
    "utf8"
  );

  // Should import redactSecrets
  assert.match(
    acpRuntimeSource,
    /redactSecrets[\s\S]*from ["']\.\/mcpServers/,
    "Should import redactSecrets"
  );

  // Should track MCP secret values
  assert.match(
    acpRuntimeSource,
    /let mcpSecretValues: string\[\]/,
    "Should track MCP secret values"
  );

  assert.match(
    acpRuntimeSource,
    /redactSecrets\(text, mcpSecretValues\)/,
    "Should redact tracked MCP secret values"
  );
  assert.match(
    acpRuntimeSource,
    /appendLog\(logStream, "stdin", redactMcpLog\(logContent\)\)/,
    "Should redact stdin session logs"
  );
  assert.match(
    acpRuntimeSource,
    /appendLog\(logStream, "stdout", safeLine\)/,
    "Should redact non-JSON stdout logs"
  );
  assert.match(
    acpRuntimeSource,
    /appendLog\(logStream, "stdout", redactMcpLog\(compactAcpStdoutLine\(line\)\)\)/,
    "Should redact ACP stdout logs"
  );
  assert.match(
    acpRuntimeSource,
    /appendLog\(logStream, "stderr", safeLine\)/,
    "Should redact stderr logs"
  );
});

// Test 18: Args editor uses per-line format
test("MCP editor uses per-line args format", () => {
  const editorSource = fs.readFileSync(
    new URL("../src/components/Settings/McpServersTab.tsx", import.meta.url),
    "utf8"
  );

  // Should use textarea for args
  assert.match(
    editorSource,
    /<textarea[\s\S]*?argsLines/,
    "Should use textarea for args"
  );

  // Should parse args from lines
  assert.match(
    editorSource,
    /parseArgsFromLines/,
    "Should have parseArgsFromLines function"
  );

  // Should split by newlines
  assert.match(
    editorSource,
    /split\("\\n"\)/,
    "Should split args by newlines"
  );
});

// Test 19: Secret env var handling preserves stored secrets
test("MCP editor preserves stored secrets on rename", () => {
  const editorSource = fs.readFileSync(
    new URL("../src/components/Settings/McpServersTab.tsx", import.meta.url),
    "utf8"
  );

  // Should track original name
  assert.match(
    editorSource,
    /originalName.*e\.name/,
    "Should track original env var name"
  );

  // Should track hasStoredSecret
  assert.match(
    editorSource,
    /hasStoredSecret/,
    "Should track hasStoredSecret flag"
  );

  // Should preserve secret when name unchanged
  assert.match(
    editorSource,
    /previousName: e\.originalName/,
    "Should keep the stored secret when the env name changes"
  );

  // Should have clear secret button
  assert.match(
    editorSource,
    /handleClearSecretValue/,
    "Should have clear secret function"
  );
});

test("session request logs redact decrypted env values and secret-looking args", async () => {
  const { collectLogSecrets, redactSecrets } = await import(
    "../dist-electron/cli/mcpServers.js"
  );
  const servers = [
    {
      name: "db",
      command: "/usr/bin/npx",
      args: ["--token=abcdefgh12345", "serve"],
      env: [
        { name: "DATABASE_URL", value: "postgres://u:hunter2@h/db" },
        { name: "GH_PAT", value: "ghp_supersecretvalue" },
        { name: "API_KEY", value: "sk-live-secret" }
      ]
    }
  ];
  const secrets = collectLogSecrets(servers);
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/new",
    params: { mcpServers: servers }
  });
  const redacted = redactSecrets(payload, secrets);
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("ghp_supersecretvalue"), false);
  assert.equal(redacted.includes("abcdefgh12345"), false);
  assert.equal(redacted.includes("sk-live-secret"), false);
  assert.match(redacted, /<redacted>/);
  assert.match(redacted, /DATABASE_URL/);
  assert.match(redacted, /session\/new/);
});

test("redactSecrets replaces JSON-escaped quotes and backslashes", async () => {
  const { redactSecrets } = await import("../dist-electron/cli/mcpServers.js");
  const secret = 'pa"ss\\word\\path';
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/new",
    params: { mcpServers: [{ env: [{ name: "TOKEN", value: secret }] }] },
  });
  const escaped = JSON.stringify(secret).slice(1, -1);
  assert.notEqual(escaped, secret);
  const combined = `${payload}\nraw ${secret}`;
  assert.equal(combined.includes(secret), true);
  assert.equal(combined.includes(escaped), true);
  const redacted = redactSecrets(combined, [secret]);
  assert.equal(redacted.includes(secret), false);
  assert.equal(redacted.includes(escaped), false);
  assert.match(redacted, /<redacted>/);
  assert.match(redacted, /session\/new/);
});

test("user MCP name collisions keep going until the name is unique", async () => {
  const { uniqueUserMcpServerName } = await import("../dist-electron/cli/mcpServers.js");
  const taken = new Set(["office-engine", "db", "db-user", "db-user-2"]);
  assert.equal(uniqueUserMcpServerName("office-engine", taken), "office-engine-user");
  assert.equal(uniqueUserMcpServerName("db", taken), "db-user-3");
  assert.equal(uniqueUserMcpServerName("fresh", taken), "fresh");
  const crowded = new Set(["tool", "tool-user"]);
  assert.equal(uniqueUserMcpServerName("Tool", crowded), "Tool-user-2");
});

test("self-check keeps the true stderr tail and still parses a flooded stdout", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  await makeDbWithMigration();
  const { createUserMcpServer, selfCheckUserMcpServer } = await import(
    "../dist-electron/cli/mcpServers.js"
  );
  const script = `
let b = "";
process.stderr.write("A".repeat(20 * 1024) + "TAILMARKER");
process.stdout.write("Y".repeat(200 * 1024) + "\\n");
process.stdin.on("data", (c) => {
  b += c;
  let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const l = b.slice(0, i);
    b = b.slice(i + 1);
    if (!l.trim()) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    if (m.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "t", version: "0" } } }) + "\\n");
    } else if (m.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ping" }] } }) + "\\n");
      setTimeout(() => process.exit(0), 30);
    }
  }
});
`;
  const server = createUserMcpServer({
    name: "stdio-cap",
    command: process.execPath,
    args: ["-e", script],
    enabled: true,
  });
  const result = await selfCheckUserMcpServer(server.id);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.tools, ["ping"]);
  assert.equal(typeof result.stderr, "string");
  assert.ok(result.stderr.endsWith("TAILMARKER"));
  assert.ok(result.stderr.length <= 8 * 1024);
  assert.equal(result.stderr.includes("A".repeat(9 * 1024)), false);
});

test("self-check parses a tools/list response larger than 8KB", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  await makeDbWithMigration();
  const { createUserMcpServer, selfCheckUserMcpServer } = await import(
    "../dist-electron/cli/mcpServers.js"
  );
  const script = `
let b = "";
process.stdin.on("data", (c) => {
  b += c;
  let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const l = b.slice(0, i);
    b = b.slice(i + 1);
    if (!l.trim()) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    if (m.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "t", version: "0" } } }) + "\\n");
    } else if (m.method === "tools/list") {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: m.id,
        result: { tools: [{ name: "big-tool", description: "d".repeat(50 * 1024) }] }
      }) + "\\n";
      if (payload.length <= 8 * 1024) {
        process.stderr.write("payload smaller than 8KB");
        process.exit(1);
      }
      const size = 4096;
      let offset = 0;
      const writeMore = () => {
        if (offset >= payload.length) {
          setTimeout(() => process.exit(0), 30);
          return;
        }
        const ok = process.stdout.write(payload.slice(offset, offset + size));
        offset += size;
        if (ok) writeMore();
        else process.stdout.once("drain", writeMore);
      };
      writeMore();
    }
  }
});
`;
  const server = createUserMcpServer({
    name: "large-tools-list",
    command: process.execPath,
    args: ["-e", script],
    enabled: true,
  });
  const result = await selfCheckUserMcpServer(server.id);
  assert.equal(result.status, "ok", result.error);
  assert.deepEqual(result.tools, ["big-tool"]);
});

test("a send waits until the in-flight MCP selection write settles", async () => {
  const source = fs.readFileSync(
    new URL("../src/services/cli/pendingMcpSelection.ts", import.meta.url),
    "utf8"
  );
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
  );
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const order = [];
  const first = mod.trackMcpSelectionWrite("conv-race", () =>
    firstGate.then(() => {
      order.push("first");
    })
  );
  let secondStarted = false;
  const second = mod.trackMcpSelectionWrite("conv-race", () => {
    secondStarted = true;
    order.push("second");
    return Promise.resolve();
  });
  await Promise.resolve();
  assert.equal(secondStarted, false);
  let sent = false;
  const send = mod.awaitPendingMcpSelection("conv-race").then(() => {
    sent = true;
  });
  await Promise.resolve();
  assert.equal(sent, false);
  releaseFirst();
  await first;
  await second;
  await send;
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(sent, true);

  mod.trackMcpSelectionWrite("conv-fail", () => Promise.reject(new Error("ipc failed")));
  await mod.awaitPendingMcpSelection("conv-fail");
});

test("renaming a secret env var keeps the stored ciphertext", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  await makeDbWithMigration();
  const { createUserMcpServer, updateUserMcpServer, getUserMcpServer } =
    await import("../dist-electron/cli/mcpServers.js");
  const { decryptSecret } = await import("../dist-electron/cli/store.js");
  const created = createUserMcpServer({
    name: "secret-rename",
    command: "npx",
    env: [{ name: "API_KEY", value: "s3cr3t-value-XYZ", secret: true }]
  });
  const stored = getUserMcpServer(created.id);
  assert.equal(stored.env[0].value, undefined);
  assert.equal(stored.env[0].hasValue, true);
  const updated = updateUserMcpServer(created.id, {
    env: [{ name: "API_TOKEN", secret: true, previousName: "API_KEY" }]
  });
  assert.equal(updated.env[0].name, "API_TOKEN");
  assert.equal(updated.env[0].hasValue, true);
  const row = (await import("../dist-electron/cli/db.js")).getDb()
    .prepare("SELECT env FROM user_mcp_servers WHERE id = ?")
    .get(created.id);
  const env = JSON.parse(row.env);
  assert.equal(decryptSecret(env[0].valueEncrypted), "s3cr3t-value-XYZ");
});

test("runtime skips unresolved commands and literal cwd placeholders", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  await makeDbWithMigration();
  const { createUserMcpServer, getEnabledUserMcpServersByIds } = await import(
    "../dist-electron/cli/mcpServers.js"
  );
  const missing = createUserMcpServer({
    name: "missing-bin",
    command: "definitely-not-a-command-12345"
  });
  const needsCwd = createUserMcpServer({
    name: "needs-cwd",
    command: process.execPath,
    args: ["${cwd}"]
  });
  const resolved = await getEnabledUserMcpServersByIds([missing.id, needsCwd.id]);
  assert.equal(resolved.servers.length, 0);
  assert.deepEqual(
    resolved.skipped.map((item) => item.reason).sort(),
    ["command_not_found", "cwd_required"]
  );
});

test("remote guard strips mcpServerIds from run and transfer", () => {
  const guard = fs.readFileSync(
    new URL("cli/remoteInvokeGuard.ts", electronDir),
    "utf8"
  );
  assert.match(guard, /channel === "cli:run"\) delete next\.mcpServerIds/);
  assert.match(guard, /channel === "cli:transferConversation"/);
  assert.match(guard, /delete next\.mcpServerIds/);
  const ipc = fs.readFileSync(new URL("cli/ipc.ts", electronDir), "utf8");
  assert.match(ipc, /!isRemoteMcpAllowed\(\)/);
});
