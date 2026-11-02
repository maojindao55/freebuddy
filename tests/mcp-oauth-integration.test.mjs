import "./fixtures/electron-stub.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";

let Database;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { Database = undefined; }

async function setup(t, encrypted = true) {
  if (!Database) { t.skip("Run with Electron's Node runner for the native database binding"); return; }
  const db = new Database(":memory:");
  const database = await import("../dist-electron/cli/db.js");
  database.setDbForTest(db);
  database.migrate(db);
  globalThis.__freebuddyElectronSafeStorage = {
    isEncryptionAvailable: () => encrypted,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => Buffer.from(`test-encrypted:${value}`),
    decryptString: (value) => value.toString().slice("test-encrypted:".length)
  };
  const api = await import("../dist-electron/cli/mcpServers.js");
  const oauth = await import("../dist-electron/cli/mcpOAuth.js");
  t.after(async () => {
    for (const server of api.listUserMcpServers()) await oauth.disconnectUserMcpServer(server.id);
    delete globalThis.__freebuddyElectronSafeStorage;
    delete globalThis.__freebuddyElectronOpenExternal;
    database.setDbForTest(null);
    db.close();
  });
  return { db, api, oauth };
}

after(async () => {
  if (Database) await (await import("../dist-electron/cli/mcpOAuth.js")).shutdownMcpOAuth();
});

async function fixture(t) {
  const sockets = new Set();
  let base;
  let registration;
  let authorization;
  let grants = 0;
  let refreshes = 0;
  let accessToken;
  const refreshToken = "private-fixture-refresh-token";
  const server = http.createServer(async (request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/.well-known/oauth-protected-resource/mcp") return send(200, {
      resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["tools:read", "admin:all"]
    });
    if (request.url === "/.well-known/oauth-authorization-server") return send(200, {
      issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`, response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true
    });
    let body = "";
    if (request.method === "POST") for await (const chunk of request) body += chunk;
    if (request.url === "/register") {
      registration = JSON.parse(body);
      return send(201, { ...registration, client_id: "freebuddy-fixture-client" });
    }
    if (request.url === "/token") {
      const params = new URLSearchParams(body);
      assert.equal(params.get("client_id"), "freebuddy-fixture-client");
      assert.equal(params.get("resource"), `${base}/mcp`);
      if (params.get("grant_type") === "authorization_code") {
        assert.equal(params.get("code"), "fixture-code");
        assert.equal(params.get("redirect_uri"), registration.redirect_uris[0]);
        assert.equal(createHash("sha256").update(params.get("code_verifier")).digest("base64url"), authorization.searchParams.get("code_challenge"));
        grants++;
      } else {
        assert.equal(params.get("grant_type"), "refresh_token");
        assert.equal(params.get("refresh_token"), refreshToken);
        refreshes++;
      }
      accessToken = `private-fixture-access-token-${grants}-${refreshes}`;
      return send(200, { access_token: accessToken, token_type: "Bearer", refresh_token: refreshToken, expires_in: 3600 });
    }
    if (request.url !== "/mcp") return send(404, {});
    if (!accessToken || request.headers.authorization !== `Bearer ${accessToken}`) return send(401, { error: "invalid_token" }, {
      "WWW-Authenticate": `Bearer scope="tools:read", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
    });
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "oauth-integration-fixture", version: "1" } }
      : { tools: [{ name: "read_design", inputSchema: { type: "object" } }] };
    return send(200, { jsonrpc: "2.0", id: message.id, result });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  globalThis.__freebuddyElectronOpenExternal = async (value) => {
    authorization = new URL(value);
    assert.equal(authorization.origin, base);
    assert.equal(authorization.searchParams.get("scope"), "tools:read");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    const callback = new URL(authorization.searchParams.get("redirect_uri"));
    callback.searchParams.set("code", "fixture-code");
    callback.searchParams.set("state", authorization.searchParams.get("state"));
    callback.searchParams.set("iss", base);
    assert.equal((await fetch(callback)).status, 200);
  };
  return { url: `${base}/mcp`, refreshToken, get accessToken() { return accessToken; }, get refreshes() { return refreshes; } };
}

test("MCP OAuth schema and configuration preserve legacy defaults and expose only status", async (t) => {
  const context = await setup(t);
  if (!context) return;
  const { db, api, oauth } = context;
  const local = api.createUserMcpServer({ name: "legacy-local", command: process.execPath });
  assert.equal(local.authType, "headers");
  const remote = api.createUserMcpServer({ name: "oauth-config", transport: "http", url: "https://example.com/mcp", authType: "oauth", headers: [{ name: "Authorization", value: "do-not-reuse" }] });
  assert.deepEqual(remote.headers, []);
  assert.equal(remote.oauthStatus.state, "disconnected");
  assert.equal(oauth.getUserMcpOAuthStatus(remote.id).state, "disconnected");
  assert.equal(db.prepare("SELECT oauth_state_encrypted FROM user_mcp_servers WHERE id = ?").get(remote.id).oauth_state_encrypted, null);
  assert.throws(() => api.updateUserMcpServer(remote.id, { authType: "unsupported" }), /\[mcp:invalid_auth_type\]/);
  assert.throws(() => api.updateUserMcpServer(remote.id, { oauthClientId: "line\nbreak" }), /\[mcp:invalid_oauth_config\]/);
  const missing = await api.selfCheckUserMcpServer(remote.id);
  assert.equal(missing.code, "oauth_required");
});

test("MCP OAuth browser callback, encrypted storage, runtime broker, self-check and disconnect work together", async (t) => {
  const context = await setup(t);
  if (!context) return;
  const remote = await fixture(t);
  const { db, api, oauth } = context;
  const server = api.createUserMcpServer({ name: "authorized-remote", transport: "http", url: remote.url, authType: "oauth" });
  const before = api.mcpConfigFingerprint([server.id]);
  assert.equal((await oauth.authorizeUserMcpServer(server.id)).state, "connected");
  assert.notEqual(api.mcpConfigFingerprint([server.id]), before);
  const stored = db.prepare("SELECT oauth_state_encrypted FROM user_mcp_servers WHERE id = ?").get(server.id).oauth_state_encrypted;
  assert.ok(stored.startsWith("safe:"));
  assert.equal(stored.includes(remote.refreshToken), false);
  for (const rendered of [api.getUserMcpServer(server.id), ...api.listUserMcpServers()]) {
    const value = JSON.stringify(rendered);
    assert.equal(value.includes(remote.refreshToken), false);
    assert.equal(value.includes(remote.accessToken), false);
    assert.equal(value.includes(stored), false);
  }
  const resolved = await api.getEnabledUserMcpServersByIds([server.id]);
  assert.deepEqual(resolved.skipped, []);
  const config = JSON.parse(resolved.servers[0].env.find((entry) => entry.name === "FREEBUDDY_REMOTE_MCP_CONFIG").value);
  assert.ok(config.oauth.endpoint.startsWith("http://127.0.0.1:"));
  assert.equal(JSON.stringify(config).includes(remote.refreshToken), false);
  assert.equal(JSON.stringify(config).includes(remote.accessToken), false);
  const result = await api.selfCheckUserMcpServer(server.id);
  assert.equal(result.status, "ok", result.error);
  assert.deepEqual(result.tools, ["read_design"]);
  const brokerToken = await fetch(config.oauth.endpoint, { method: "POST", headers: { Authorization: `Bearer ${config.oauth.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ forceRefresh: true, rejectedToken: remote.accessToken }) });
  assert.equal(brokerToken.status, 200);
  assert.equal(remote.refreshes, 1);
  const connectedFingerprint = api.mcpConfigFingerprint([server.id]);
  assert.equal((await oauth.disconnectUserMcpServer(server.id)).state, "disconnected");
  assert.notEqual(api.mcpConfigFingerprint([server.id]), connectedFingerprint);
  assert.equal(db.prepare("SELECT oauth_state_encrypted FROM user_mcp_servers WHERE id = ?").get(server.id).oauth_state_encrypted, null);
  const revoked = await fetch(config.oauth.endpoint, { method: "POST", headers: { Authorization: `Bearer ${config.oauth.token}`, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(revoked.status, 403);
  assert.equal((await api.selfCheckUserMcpServer(server.id)).code, "oauth_required");
});

test("MCP OAuth uses session-only credentials without a secure key store and changing URL invalidates them", async (t) => {
  const context = await setup(t, false);
  if (!context) return;
  const remote = await fixture(t);
  const { db, api, oauth } = context;
  const server = api.createUserMcpServer({ name: "session-only", transport: "http", url: remote.url, authType: "oauth" });
  assert.equal((await oauth.authorizeUserMcpServer(server.id)).state, "connected");
  assert.equal(oauth.getUserMcpOAuthStatus(server.id).sessionOnly, true);
  assert.equal(db.prepare("SELECT oauth_state_encrypted FROM user_mcp_servers WHERE id = ?").get(server.id).oauth_state_encrypted, null);
  assert.equal((await api.selfCheckUserMcpServer(server.id)).status, "ok");
  api.updateUserMcpServer(server.id, { url: remote.url.replace("/mcp", "/other") });
  assert.equal(oauth.getUserMcpOAuthStatus(server.id).state, "disconnected");
  assert.equal((await api.selfCheckUserMcpServer(server.id)).code, "oauth_required");
});
