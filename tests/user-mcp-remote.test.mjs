import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

// The normal Node runner may not match the Electron-rebuilt native binding.
// The Electron Node runner executes the same integration tests without skips.
let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

async function makeDb(t, { legacy = false } = {}) {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return undefined;
  }
  const db = new Database(":memory:");
  const { setDbForTest, migrate } = await import("../dist-electron/cli/db.js");
  setDbForTest(db);
  t.after(() => {
    setDbForTest(null);
    db.close();
  });
  if (!legacy) migrate(db);
  return db;
}

async function api() {
  return import("../dist-electron/cli/mcpServers.js");
}

function storedHeaders(db, id) {
  return JSON.parse(
    db.prepare("SELECT headers FROM user_mcp_servers WHERE id = ?").get(id).headers
  );
}

function bridgeConfig(server) {
  assert.equal(server.command, process.execPath);
  assert.ok(
    server.args.some((arg) => path.basename(arg) === "remoteMcpBridge.js"),
    "Remote MCP servers should run through the local stdio bridge"
  );
  const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]));
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  return JSON.parse(env.FREEBUDDY_REMOTE_MCP_CONFIG);
}

function assertMaskedHeaders(server, secrets, ciphertexts = []) {
  for (const header of server.headers) {
    assert.equal(header.secret, true);
    assert.equal(header.hasValue, true);
    assert.equal(header.value, undefined);
    assert.equal(header.valueEncrypted, undefined);
  }
  const serialized = JSON.stringify(server);
  for (const value of [...secrets, ...ciphertexts]) {
    assert.equal(serialized.includes(value), false, "Renderer results must not expose header values");
  }
}

async function remoteHttpFixture(t, { unauthorized = false, responseSecret = "" } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, authorization: request.headers.authorization });
    if (unauthorized) {
      response.writeHead(401, {
        "Content-Type": "text/plain",
        "WWW-Authenticate": `Bearer realm="fixture", error_description="${responseSecret}"`,
      });
      response.end(responseSecret);
      return;
    }
    if (request.method === "GET") {
      // Streamable HTTP servers may omit a standalone server event stream.
      response.writeHead(405).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(202).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "database-self-check-fixture", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = { tools: [{ name: "fixture-echo", inputSchema: { type: "object" } }] };
    }
    if (result === undefined) {
      response.writeHead(202).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, requests };
}

test("MCP transport defaults to stdio and remote servers roundtrip without a command", async (t) => {
  if (!(await makeDb(t))) return;
  const { createUserMcpServer, getUserMcpServer, listUserMcpServers } = await api();

  const stdio = createUserMcpServer({ name: "local-default", command: process.execPath });
  assert.equal(stdio.transport, "stdio");
  assert.equal(stdio.command, process.execPath);
  assert.deepEqual(stdio.headers, []);

  for (const transport of ["http", "sse"]) {
    const server = createUserMcpServer({
      name: `remote-${transport}`,
      transport,
      url: `https://mcp.example.com/${transport}?version=1`,
    });
    assert.equal(server.transport, transport);
    assert.equal(server.command, "");
    assert.equal(server.url, `https://mcp.example.com/${transport}?version=1`);
    assert.deepEqual(server.headers, []);
    assert.deepEqual(getUserMcpServer(server.id), server);
    assert.ok(listUserMcpServers().some((entry) => entry.id === server.id && entry.transport === transport));
  }
});

test("MCP updates switch between local, HTTP, and SSE transports", async (t) => {
  if (!(await makeDb(t))) return;
  const { createUserMcpServer, updateUserMcpServer, getEnabledUserMcpServersByIds } = await api();
  const created = createUserMcpServer({
    name: "transport-switch",
    command: "definitely-not-a-command-remote-test",
    args: ["${cwd}"],
  });
  const remote = updateUserMcpServer(created.id, {
    transport: "http",
    url: "https://mcp.example.com/mcp",
    headers: [{ name: "Authorization", value: "Bearer switch-secret", secret: true }],
  });
  assert.equal(remote.transport, "http");
  assert.equal(remote.command, "");
  const resolved = await getEnabledUserMcpServersByIds([created.id]);
  assert.deepEqual(resolved.skipped, [], "Remote servers must not resolve old commands or require a workspace");
  assert.equal(resolved.servers.length, 1);
  assert.deepEqual(bridgeConfig(resolved.servers[0]), {
    transport: "http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer switch-secret" },
  });

  const sse = updateUserMcpServer(created.id, { transport: "sse" });
  assert.equal(sse.transport, "sse");
  assert.equal(sse.url, remote.url);
  assert.throws(() => updateUserMcpServer(created.id, { transport: "stdio" }), /\[mcp:/);

  const local = updateUserMcpServer(created.id, {
    transport: "stdio",
    command: process.execPath,
    args: ["--version"],
  });
  assert.equal(local.transport, "stdio");
  assert.equal(local.command, process.execPath);
  const localResolved = await getEnabledUserMcpServersByIds([created.id]);
  assert.deepEqual(localResolved.skipped, []);
  assert.equal(localResolved.servers[0].command, process.execPath);
  assert.deepEqual(localResolved.servers[0].args, ["--version"]);
  assert.equal(localResolved.servers[0].env.some((entry) => entry.name === "FREEBUDDY_REMOTE_MCP_CONFIG"), false);
});

test("MCP validates transport and remote URLs on both create and update", async (t) => {
  if (!(await makeDb(t))) return;
  const { createUserMcpServer, updateUserMcpServer, getUserMcpServer } = await api();
  const valid = { transport: "http", url: "https://mcp.example.com/mcp" };
  const existing = createUserMcpServer({ name: "url-validation", ...valid });
  const invalid = [
    { transport: "websocket" },
    { transport: 42 },
    { url: "" },
    { url: "not-a-url" },
    { url: 42 },
    { url: "ftp://mcp.example.com/mcp" },
    { url: "file:///tmp/mcp" },
    { url: "javascript:alert(1)" },
    { url: "https://user:password@mcp.example.com/mcp" },
    { url: "https://user@mcp.example.com/mcp" },
    { url: "https://mcp.example.com/mcp#fragment" },
  ];
  for (const [index, patch] of invalid.entries()) {
    assert.throws(
      () => createUserMcpServer({ name: `invalid-url-${index}`, ...valid, ...patch }),
      /\[mcp:/,
      `Create should reject ${JSON.stringify(patch)}`
    );
    assert.throws(
      () => updateUserMcpServer(existing.id, patch),
      /\[mcp:/,
      `Update should reject ${JSON.stringify(patch)}`
    );
    assert.equal(getUserMcpServer(existing.id).url, valid.url);
    assert.equal(getUserMcpServer(existing.id).transport, "http");
  }
  assert.throws(() => createUserMcpServer({ name: "missing-url", transport: "sse" }), /\[mcp:/);
  const localhost = createUserMcpServer({ name: "localhost-http", transport: "http", url: "http://127.0.0.1:8765/mcp" });
  assert.equal(localhost.url, "http://127.0.0.1:8765/mcp");
});

test("MCP remote headers reject invalid tokens, case-insensitive duplicates, and line injection", async (t) => {
  if (!(await makeDb(t))) return;
  const { createUserMcpServer, updateUserMcpServer } = await api();
  const valid = { transport: "http", url: "https://mcp.example.com/mcp" };
  const existing = createUserMcpServer({ name: "header-validation", ...valid });
  const invalid = [
    [{ name: "Bad Header", value: "value" }],
    [{ name: "Bad:Header", value: "value" }],
    [{ name: "Bad\r\nHeader", value: "value" }],
    [{ name: "", value: "value" }],
    [{ name: "授权", value: "value" }],
    [{ name: "X-Test", value: "good\r\nInjected: bad" }],
    [{ name: "X-Test", value: "good\nbad" }],
    [{ name: "X-Test", value: "good\rbad" }],
    [{ name: "Authorization", value: "a" }, { name: "authorization", value: "b" }],
    [{ name: "X-Test", value: 42 }],
    [{ name: 42, value: "value" }],
    { Authorization: "value" },
  ];
  for (const [index, headers] of invalid.entries()) {
    assert.throws(
      () => createUserMcpServer({ name: `bad-header-${index}`, ...valid, headers }),
      /\[mcp:/,
      `Create should reject ${JSON.stringify(headers)}`
    );
    assert.throws(
      () => updateUserMcpServer(existing.id, { headers }),
      /\[mcp:/,
      `Update should reject ${JSON.stringify(headers)}`
    );
  }
});

test("MCP encrypts every remote header and preserves stored values through editor updates", async (t) => {
  const db = await makeDb(t);
  if (!db) return;
  const { createUserMcpServer, updateUserMcpServer, getUserMcpServer, listUserMcpServers, getEnabledUserMcpServersByIds } = await api();
  const { decryptSecret } = await import("../dist-electron/cli/store.js");
  const secrets = ["Bearer private-auth-value-12345", "private-project-value-67890"];
  const created = createUserMcpServer({
    name: "encrypted-headers",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    headers: [
      { name: "Authorization", value: secrets[0], secret: true },
      { name: "X-Project", value: secrets[1], secret: false },
    ],
  });
  const stored = storedHeaders(db, created.id);
  assert.equal(stored.length, 2);
  for (const [index, header] of stored.entries()) {
    assert.equal(header.secret, true);
    assert.equal(header.value, undefined);
    assert.equal(typeof header.valueEncrypted, "string");
    assert.equal(decryptSecret(header.valueEncrypted), secrets[index]);
  }
  const ciphertexts = stored.map((header) => header.valueEncrypted);
  assertMaskedHeaders(created, secrets, ciphertexts);
  assertMaskedHeaders(getUserMcpServer(created.id), secrets, ciphertexts);
  assertMaskedHeaders(listUserMcpServers()[0], secrets, ciphertexts);

  const renamed = updateUserMcpServer(created.id, {
    name: "renamed-remote",
    headers: [
      { name: "Authorization", secret: true },
      { name: "X-Workspace", previousName: "X-Project", secret: true },
    ],
  });
  assertMaskedHeaders(renamed, secrets, ciphertexts);
  const after = storedHeaders(db, created.id);
  assert.equal(after[0].valueEncrypted, stored[0].valueEncrypted);
  assert.equal(after[1].name, "X-Workspace");
  assert.equal(after[1].valueEncrypted, stored[1].valueEncrypted);

  const resolved = await getEnabledUserMcpServersByIds([created.id]);
  assert.equal(resolved.servers.length, 1);
  assert.deepEqual(bridgeConfig(resolved.servers[0]).headers, {
    Authorization: secrets[0],
    "X-Workspace": secrets[1],
  });
  for (const secret of secrets) assert.ok(resolved.secretValues.includes(secret));

  updateUserMcpServer(created.id, { headers: [] });
  assert.deepEqual(getUserMcpServer(created.id).headers, []);
  assert.deepEqual(storedHeaders(db, created.id), []);
});

test("MCP bridge runtime and request logs redact remote configuration secrets", async (t) => {
  if (!(await makeDb(t))) return;
  const { createUserMcpServer, getEnabledUserMcpServersByIds, collectLogSecrets, redactSecrets } = await api();
  const secret = 'Bearer remote-quoted-"value\\path-12345';
  const created = createUserMcpServer({
    name: "remote-log-secrets",
    transport: "sse",
    url: "https://mcp.example.com/sse",
    headers: [{ name: "X-Custom", value: secret, secret: false }],
  });
  const resolved = await getEnabledUserMcpServersByIds([created.id]);
  const config = bridgeConfig(resolved.servers[0]);
  assert.equal(config.transport, "sse");
  assert.equal(config.headers["X-Custom"], secret);
  const payload = JSON.stringify({ method: "session/new", params: { mcpServers: resolved.servers } });
  const redacted = redactSecrets(payload, collectLogSecrets(resolved.servers));
  const escaped = JSON.stringify(secret).slice(1, -1);
  const doubleEscaped = JSON.stringify(escaped).slice(1, -1);
  assert.equal(redacted.includes(secret), false);
  assert.equal(redacted.includes(escaped), false);
  assert.equal(redacted.includes(doubleEscaped), false);
  assert.match(redacted, /<redacted>/);
  assert.match(redacted, /session\/new/);
});

test("MCP headers preserve explicit empty values and never preview an entire short secret", async (t) => {
  const db = await makeDb(t);
  if (!db) return;
  const { createUserMcpServer, updateUserMcpServer, getEnabledUserMcpServersByIds } = await api();
  const { decryptSecret } = await import("../dist-electron/cli/store.js");
  const created = createUserMcpServer({
    name: "empty-short-headers",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    headers: [
      { name: "X-Short", value: "abc" },
      { name: "X-Empty", value: "" },
      { name: "X-Spaced", value: "  keep spacing  " },
    ],
  });
  assertMaskedHeaders(created, ["abc", "  keep spacing  "]);
  const stored = storedHeaders(db, created.id);
  assert.deepEqual(stored.map((header) => decryptSecret(header.valueEncrypted)), ["abc", "", "  keep spacing  "]);
  let resolved = await getEnabledUserMcpServersByIds([created.id]);
  assert.deepEqual(bridgeConfig(resolved.servers[0]).headers, {
    "X-Short": "abc",
    "X-Empty": "",
    "X-Spaced": "  keep spacing  ",
  });

  updateUserMcpServer(created.id, {
    headers: [
      { name: "X-Short", value: "" },
      { name: "X-Empty" },
      { name: "X-Spaced" },
    ],
  });
  resolved = await getEnabledUserMcpServersByIds([created.id]);
  assert.deepEqual(bridgeConfig(resolved.servers[0]).headers, {
    "X-Short": "",
    "X-Empty": "",
    "X-Spaced": "  keep spacing  ",
  });
});

test("remote user MCP self-check persists an authenticated HTTP tool list", { timeout: 5000 }, async (t) => {
  const db = await makeDb(t);
  if (!db) return;
  const remote = await remoteHttpFixture(t);
  const authorization = "Bearer local-database-check-token";
  const { createUserMcpServer, selfCheckUserMcpServer, getUserMcpServer } = await api();
  const created = createUserMcpServer({
    name: "http-check-success",
    transport: "http",
    url: remote.url,
    headers: [{ name: "Authorization", value: authorization }],
  });
  const result = await selfCheckUserMcpServer(created.id);
  assert.equal(result.status, "ok", result.error);
  assert.deepEqual(result.tools, ["fixture-echo"]);
  assert.ok(remote.requests.some((request) => request.method === "POST"));
  for (const request of remote.requests) assert.equal(request.authorization, authorization);

  const row = db.prepare(`
    SELECT last_check_status, last_check_error, last_check_tools, last_checked_at
    FROM user_mcp_servers WHERE id = ?
  `).get(created.id);
  assert.equal(row.last_check_status, "ok");
  assert.equal(row.last_check_error, null);
  assert.deepEqual(JSON.parse(row.last_check_tools), ["fixture-echo"]);
  assert.ok(Number.isFinite(Date.parse(row.last_checked_at)));
  const stored = getUserMcpServer(created.id);
  assert.equal(stored.lastCheckStatus, "ok");
  assert.deepEqual(stored.lastCheckTools, ["fixture-echo"]);
  assert.equal(stored.lastCheckedAt, row.last_checked_at);
});

test("remote user MCP self-check persists safe authentication failure without response secrets", { timeout: 5000 }, async (t) => {
  const db = await makeDb(t);
  if (!db) return;
  const responseSecret = "private-http-error-response-secret-98765";
  const remote = await remoteHttpFixture(t, { unauthorized: true, responseSecret });
  const authorization = "Bearer private-db-authentication-token-12345";
  const { createUserMcpServer, selfCheckUserMcpServer, getUserMcpServer } = await api();
  const created = createUserMcpServer({
    name: "http-check-auth-failure",
    transport: "http",
    url: remote.url,
    headers: [{ name: "Authorization", value: authorization }],
  });
  const result = await selfCheckUserMcpServer(created.id);
  assert.equal(result.status, "error");
  assert.equal(result.code, "remote_auth_failed");
  assert.match(result.error, /401/);
  for (const secret of [responseSecret, authorization, remote.url]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.ok(remote.requests.length > 0);
  for (const request of remote.requests) assert.equal(request.authorization, authorization);

  const row = db.prepare("SELECT * FROM user_mcp_servers WHERE id = ?").get(created.id);
  assert.equal(row.last_check_status, "error");
  assert.equal(row.last_check_error, result.error);
  assert.equal(row.last_check_tools, null);
  assert.ok(Number.isFinite(Date.parse(row.last_checked_at)));
  assert.equal(JSON.stringify(row).includes(responseSecret), false);
  assert.equal(JSON.stringify(row).includes(authorization), false);
  const stored = getUserMcpServer(created.id);
  assert.equal(stored.lastCheckStatus, "error");
  assert.equal(stored.lastCheckError, result.error);
});

test("editing remote URL or headers and local commands clears previous MCP checks without network access", async (t) => {
  const db = await makeDb(t);
  if (!db) return;
  const { createUserMcpServer, updateUserMcpServer, getUserMcpServer } = await api();
  const remote = createUserMcpServer({
    name: "stale-remote-check",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    headers: [{ name: "Authorization", value: "Bearer original-header" }],
  });
  const local = createUserMcpServer({ name: "stale-local-check", command: process.execPath });
  const changes = [
    [remote.id, { url: "https://mcp.example.com/changed" }],
    [remote.id, { headers: [{ name: "Authorization", value: "Bearer changed-header" }] }],
    [local.id, { args: ["--version"] }],
  ];
  for (const [id, patch] of changes) {
    db.prepare(`
      UPDATE user_mcp_servers SET last_check_status = 'ok', last_check_error = 'old detail',
        last_check_tools = '["old-tool"]', last_checked_at = '2025-01-02T03:04:05.000Z'
      WHERE id = ?
    `).run(id);
    updateUserMcpServer(id, patch);
    const row = db.prepare(`
      SELECT last_check_status, last_check_error, last_check_tools, last_checked_at
      FROM user_mcp_servers WHERE id = ?
    `).get(id);
    assert.deepEqual(row, {
      last_check_status: null,
      last_check_error: null,
      last_check_tools: null,
      last_checked_at: null,
    });
    const stored = getUserMcpServer(id);
    assert.equal(stored.lastCheckStatus, undefined);
    assert.equal(stored.lastCheckError, undefined);
    assert.equal(stored.lastCheckTools, undefined);
    assert.equal(stored.lastCheckedAt, undefined);
  }
});

test("MCP warm fingerprint changes with remote transport, URL, and header values", async (t) => {
  if (!(await makeDb(t))) return;
  const { createUserMcpServer, updateUserMcpServer, mcpConfigFingerprint } = await api();
  const created = createUserMcpServer({
    name: "remote-fingerprint",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    headers: [{ name: "Authorization", value: "Bearer original-fingerprint-secret" }],
  });
  let previous = mcpConfigFingerprint([created.id]);
  for (const patch of [
    { transport: "sse" },
    { url: "https://mcp.example.com/other" },
    { headers: [{ name: "Authorization", value: "Bearer changed-fingerprint-secret" }] },
    { headers: [{ name: "X-Api-Key", previousName: "Authorization", secret: true }] },
  ]) {
    updateUserMcpServer(created.id, patch);
    const current = mcpConfigFingerprint([created.id]);
    assert.notEqual(current, previous, `Fingerprint must change for ${Object.keys(patch).join(", ")}`);
    previous = current;
  }
});

test("MCP schema migration is idempotent and preserves existing stdio rows", async (t) => {
  const db = await makeDb(t, { legacy: true });
  if (!db) return;
  db.exec(`
    CREATE TABLE user_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      env TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_check_status TEXT,
      last_check_error TEXT,
      last_check_tools TEXT,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const args = JSON.stringify(["--project", "${cwd}"]);
  const env = JSON.stringify([{ name: "MODE", value: "legacy" }]);
  const timestamp = "2025-01-02T03:04:05.000Z";
  db.prepare(`
    INSERT INTO user_mcp_servers
      (id, name, command, args, env, enabled, last_check_status, last_check_tools,
       last_checked_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("mcp-legacy", "legacy-stdio", process.execPath, args, env, 0, "ok", '["ping"]', timestamp, timestamp, timestamp);
  const { migrate } = await import("../dist-electron/cli/db.js");
  migrate(db);
  migrate(db);
  const columns = db.prepare("PRAGMA table_info(user_mcp_servers)").all().map((column) => column.name);
  for (const column of ["transport", "url", "headers"]) assert.ok(columns.includes(column));
  const { getUserMcpServer } = await api();
  const legacy = getUserMcpServer("mcp-legacy");
  assert.equal(legacy.transport, "stdio");
  assert.equal(legacy.command, process.execPath);
  assert.deepEqual(legacy.args, ["--project", "${cwd}"]);
  assert.deepEqual(legacy.env, [{ name: "MODE", value: "legacy" }]);
  assert.deepEqual(legacy.headers, []);
  assert.equal(legacy.enabled, false);
  assert.equal(legacy.lastCheckStatus, "ok");
  assert.deepEqual(legacy.lastCheckTools, ["ping"]);
  assert.equal(legacy.lastCheckedAt, timestamp);
  assert.equal(legacy.createdAt, timestamp);
  assert.equal(legacy.updatedAt, timestamp);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_mcp_servers").get().count, 1);
});
