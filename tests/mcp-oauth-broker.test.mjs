import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createMcpOAuthBroker, isMcpOAuthBrokerEndpoint } from "../dist-electron/cli/mcpOAuthBroker.js";

function request(binding, { token = binding.token, method = "POST", headers = {}, body = "{}", endpoint = binding.endpoint } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(endpoint, {
      method,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${token}`, ...headers }
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("OAuth broker binds capabilities to server routes and revokes changed URLs", async (t) => {
  const calls = [];
  const broker = createMcpOAuthBroker({ getAccessToken: async (...args) => { calls.push(args); return "short-access-token"; } });
  t.after(() => broker.dispose());
  const first = await broker.bind("one", "https://mcp.example.com/mcp");
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(isMcpOAuthBrokerEndpoint(first.endpoint), true);
  assert.deepEqual(await broker.bind("one", "https://mcp.example.com/mcp"), first);
  const second = await broker.bind("two", "https://mcp.example.com/mcp");
  assert.notEqual(first.endpoint, second.endpoint);
  assert.notEqual(first.token, second.token);
  assert.equal((await request(first, { token: second.token })).status, 403);
  assert.equal((await request(second, { token: first.token })).status, 403);
  assert.deepEqual(calls, []);

  const result = await request(first, { body: JSON.stringify({ forceRefresh: true, rejectedToken: "rejected-access" }) });
  assert.equal(result.status, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.deepEqual(result.json, { accessToken: "short-access-token" });
  assert.deepEqual(calls, [["one", true, "rejected-access"]]);
  const changed = await broker.bind("one", "https://mcp.example.com/changed");
  assert.notEqual(changed.token, first.token);
  assert.equal((await request(first)).status, 403);
  assert.equal((await request(changed)).status, 200);
  broker.revoke("one");
  assert.equal((await request(changed)).status, 403);
  assert.equal((await request(second)).status, 200);
});

test("OAuth broker refuses browsers, forged Host, unsupported methods and invalid capabilities", async (t) => {
  let calls = 0;
  const broker = createMcpOAuthBroker({ getAccessToken: async () => { calls += 1; return "access-token"; } });
  t.after(() => broker.dispose());
  const binding = await broker.bind("one", "https://mcp.example.com/mcp");
  for (const options of [
    { token: "invalid" },
    { token: "" },
    { method: "GET" },
    { method: "OPTIONS" },
    { headers: { Origin: "http://127.0.0.1" } },
    { headers: { Origin: "null" } },
    { headers: { Host: "attacker.example.com" } },
    { headers: { Host: "localhost" } },
    { endpoint: `${binding.endpoint}?serverId=two` },
    { endpoint: binding.endpoint.replace(/[^/]+$/, "not-a-route") },
  ]) {
    const result = await request(binding, options);
    assert.equal(result.status, 403);
    assert.deepEqual(result.json, { code: "broker_forbidden" });
    assert.equal(result.headers["cache-control"], "no-store");
  }
  assert.equal(calls, 0);
});

test("OAuth broker bounds and validates its JSON body without echoing rejected data", async (t) => {
  let calls = 0;
  const broker = createMcpOAuthBroker({ getAccessToken: async () => { calls += 1; return "access-token"; } });
  t.after(() => broker.dispose());
  const binding = await broker.bind("one", "https://mcp.example.com/mcp");
  const secret = "private-invalid-input";
  for (const body of [
    secret,
    JSON.stringify({ unknown: secret }),
    JSON.stringify({ forceRefresh: secret }),
    JSON.stringify({ rejectedToken: 42 }),
    "null", "[]", "true"
  ]) {
    const result = await request(binding, { body });
    assert.equal(result.status, 400);
    assert.equal(result.text.includes(secret), false);
    assert.deepEqual(result.json, { code: "broker_forbidden" });
  }
  const tooLarge = await request(binding, { body: JSON.stringify({ rejectedToken: "x".repeat(9 * 1024) }) });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(tooLarge.json, { code: "broker_forbidden" });
  assert.equal((await request(binding, { headers: { "Content-Type": "text/plain" } })).status, 400);
  assert.equal(calls, 0);
});

test("OAuth broker returns safe service failures and honors authorization changes", async (t) => {
  let allowed = true;
  let mode = "login";
  const secret = "private-service-refresh-token";
  const broker = createMcpOAuthBroker({
    isAllowed: () => allowed,
    getAccessToken: async () => {
      if (mode === "login") throw Object.assign(new Error(secret), { code: "oauth_required" });
      if (mode === "temporary") throw Object.assign(new Error(secret), { code: "oauth_refresh_failed" });
      throw new Error(secret);
    }
  });
  t.after(() => broker.dispose());
  const binding = await broker.bind("one", "https://mcp.example.com/mcp");
  let result = await request(binding);
  assert.equal(result.status, 401);
  assert.deepEqual(result.json, { code: "oauth_required" });
  assert.equal(result.text.includes(secret), false);
  mode = "failure";
  result = await request(binding);
  assert.equal(result.status, 503);
  assert.deepEqual(result.json, { code: "failed" });
  assert.equal(result.text.includes(secret), false);
  mode = "temporary";
  result = await request(binding);
  assert.equal(result.status, 503);
  assert.deepEqual(result.json, { code: "oauth_unavailable" });
  assert.equal(result.text.includes(secret), false);
  allowed = false;
  assert.equal((await request(binding)).status, 403);
  await assert.rejects(broker.bind("one", "https://mcp.example.com/mcp"), { code: "broker_forbidden" });
});

test("OAuth broker watch routes enforce capability and browser restrictions", async (t) => {
  let calls = 0;
  const broker = createMcpOAuthBroker({ getAccessToken: async () => { calls += 1; return "private-access-token"; } });
  t.after(() => broker.dispose());
  const binding = await broker.bind("watch", "https://mcp.example.com/mcp");
  const endpoint = `${binding.endpoint}/watch`;
  for (const options of [
    { token: "invalid" }, { token: "" }, { method: "POST" }, { method: "OPTIONS" },
    { headers: { Origin: "null" } }, { headers: { Origin: "https://attacker.example.com" } },
    { headers: { Host: "localhost" } }, { headers: { Host: "attacker.example.com" } },
    { endpoint: `${endpoint}?query` }, { endpoint: `${endpoint}/watch` }
  ]) {
    const result = await request(binding, { method: "GET", endpoint, ...options });
    assert.equal(result.status, 403);
    assert.deepEqual(result.json, { code: "broker_forbidden" });
  }
  assert.equal(calls, 0);
});

async function watch(binding) {
  const controller = new AbortController();
  const response = await fetch(`${binding.endpoint}/watch`, {
    headers: { Authorization: `Bearer ${binding.token}` }, signal: controller.signal
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  const ready = new TextDecoder().decode((await reader.read()).value);
  assert.equal(ready, "event: ready\ndata: {}\n\n");
  return {
    async revoked() {
      let text = ready;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      assert.equal(text, "event: ready\ndata: {}\n\nevent: revoked\ndata: {}\n\n");
      assert.equal(text.includes(binding.token), false);
      assert.equal(text.includes("private-access-token"), false);
    },
    async cancel() { controller.abort(); await reader.cancel().catch(() => {}); }
  };
}

test("OAuth broker closes watchers on revocation, URL replacement, and disposal and cleans up disconnected watchers", async (t) => {
  let calls = 0;
  const broker = createMcpOAuthBroker({ getAccessToken: async () => { calls += 1; return "private-access-token"; } });
  t.after(() => broker.dispose());
  const binding = await broker.bind("watch", "https://mcp.example.com/mcp");
  const disconnected = await watch(binding);
  await disconnected.cancel();
  const first = await watch(binding);
  const second = await watch(binding);
  broker.revoke("watch");
  await Promise.all([first.revoked(), second.revoked()]);
  const replacement = await broker.bind("watch", "https://mcp.example.com/mcp");
  const changed = await watch(replacement);
  const current = await broker.bind("watch", "https://mcp.example.com/new");
  await changed.revoked();
  const disposed = await watch(current);
  const end = disposed.revoked();
  await broker.dispose();
  await end;
  assert.equal(calls, 0, "Lifecycle watches must not retrieve OAuth credentials");
});

test("OAuth broker revocation prevents delivery of an in-flight refreshed token", async (t) => {
  let finish;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { finish = resolve; });
  const broker = createMcpOAuthBroker({ getAccessToken: async () => { started(); await gate; return "never-delivered-token"; } });
  t.after(() => broker.dispose());
  const binding = await broker.bind("one", "https://mcp.example.com/mcp");
  const pending = request(binding);
  await entered;
  broker.revoke("one");
  finish();
  const result = await pending;
  assert.equal(result.status, 403);
  assert.deepEqual(result.json, { code: "broker_forbidden" });
  assert.equal(result.text.includes("never-delivered-token"), false);
});

test("OAuth broker disposal closes its listener and only strict local endpoints are accepted", async () => {
  const broker = createMcpOAuthBroker({ getAccessToken: async () => "access-token" });
  const binding = await broker.bind("one", "https://mcp.example.com/mcp");
  for (const endpoint of [
    binding.endpoint.replace("127.0.0.1", "localhost"),
    binding.endpoint.replace("127.0.0.1", "127.0.0.2"),
    binding.endpoint.replace("http:", "https:"),
    binding.endpoint.replace("127.0.0.1", "user@127.0.0.1"),
    `${binding.endpoint}?query`, `${binding.endpoint}#fragment`, `${binding.endpoint}/extra`,
  ]) assert.equal(isMcpOAuthBrokerEndpoint(endpoint), false);
  await broker.dispose();
  await broker.dispose();
  await assert.rejects(request(binding));
  await assert.rejects(broker.bind("two", "https://mcp.example.com/mcp"), { code: "failed" });
});
