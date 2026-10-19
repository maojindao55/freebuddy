import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { McpOAuthService } from "../dist-electron/cli/mcpOAuthService.js";

const privateText = "private-fixture-server-secret";

async function fixture(t, settings = {}) {
  let base;
  let authorization;
  let refreshCount = 0;
  const registrations = [];
  const grants = [];
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const json = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/mcp" || req.url === "/other") {
      res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"${settings.hintScope === false ? "" : ', scope="read"'}` });
      res.end(); return;
    }
    if (req.url === "/.well-known/oauth-protected-resource/mcp") {
      json({ resource: `${base}/mcp`, authorization_servers: [settings.issuer ?? base], scopes_supported: ["read", "write", "admin"] }); return;
    }
    if (req.url.startsWith("/.well-known/oauth-authorization-server")) {
      json({
        issuer: settings.metadataIssuer ?? base,
        authorization_endpoint: settings.authorizationEndpoint ?? `${base}/authorize`,
        token_endpoint: settings.tokenEndpoint ?? `${base}/token`,
        registration_endpoint: settings.registration === false ? undefined : `${base}/register`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: settings.pkce ?? ["S256"]
        , authorization_response_iss_parameter_supported: settings.requireIssuer
      }); return;
    }
    if (req.url === "/register") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const metadata = JSON.parse(raw);
      registrations.push(metadata);
      json({ ...metadata, client_id: "fixture-client", client_id_issued_at: 0 }); return;
    }
    if (req.url === "/token") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const params = new URLSearchParams(raw);
      grants.push(Object.fromEntries(params));
      if (params.get("grant_type") === "authorization_code") {
        assert.ok(authorization, "authorization URL is available before exchange");
        const verifier = params.get("code_verifier");
        assert.equal(createHash("sha256").update(verifier).digest("base64url"), authorization.searchParams.get("code_challenge"));
        assert.equal(params.get("redirect_uri"), authorization.searchParams.get("redirect_uri"));
        assert.equal(params.get("client_id"), authorization.searchParams.get("client_id"));
        assert.equal(params.get("resource"), `${settings.resourceBase ?? base}/mcp`);
      } else if (params.get("grant_type") === "refresh_token") {
        refreshCount += 1;
        if (settings.refreshGate) await settings.refreshGate;
        if (settings.refreshError) {
          json({ error: settings.refreshError, error_description: privateText }, settings.refreshStatus ?? 400);
          return;
        }
      }
      if (settings.failToken) { res.writeHead(400).end(privateText); return; }
      json({
        token_type: "Bearer", access_token: settings.sameAccessToken ? "access-0" : `access-${refreshCount}`,
        refresh_token: settings.omitRefresh && refreshCount ? undefined : `refresh-${refreshCount}`,
        expires_in: settings.expiresIn ?? 3600
      }); return;
    }
    res.writeHead(404).end();
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  return {
    base, registrations, grants, requests, settings,
    server: { id: "fixture", url: `${base}/mcp` },
    get refreshCount() { return refreshCount; },
    get authorization() { return authorization; },
    async browser(value, overrides = {}) {
      authorization = new URL(value);
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set("iss", base);
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) callback.searchParams.delete(key);
        else callback.searchParams.set(key, value);
      }
      return fetch(callback);
    }
  };
}

function service(t, remote, overrides = {}) {
  const records = overrides.records ?? new Map();
  const opens = [];
  const writes = [];
  const client = new McpOAuthService({
    read: (id) => records.get(id),
    write: (id, value) => { writes.push(value); if (value === undefined) records.delete(id); else records.set(id, structuredClone(value)); },
    openExternal: async (value) => { opens.push(value); await remote.browser(value); },
    timeoutMs: 3000,
    ...overrides
  });
  t.after(() => client.dispose());
  return { client, records, opens, writes };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("OAuth discovers a challenged resource, dynamically registers, validates PKCE and stores bound credentials", async (t) => {
  const remote = await fixture(t);
  const { client, records, opens } = service(t, remote);
  assert.deepEqual(client.status(remote.server), { state: "disconnected" });
  const result = await client.authorize(remote.server);
  assert.equal(result.state, "connected");
  assert.equal(await client.accessToken(remote.server), "access-0");
  assert.equal(opens.length, 1);
  const url = new URL(opens[0]);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("state").length >= 32);
  assert.equal(url.searchParams.get("scope"), "read");
  assert.equal(url.searchParams.get("resource"), remote.server.url);
  const callback = new URL(url.searchParams.get("redirect_uri"));
  assert.equal(callback.hostname, "127.0.0.1");
  assert.ok(Number(callback.port) > 0);
  assert.equal(remote.registrations.length, 1);
  assert.equal(remote.registrations[0].token_endpoint_auth_method, "none");
  assert.equal(remote.registrations[0].scope, "read");
  const record = records.get(remote.server.id);
  assert.equal(record.serverUrl, remote.server.url);
  assert.equal(record.issuer, remote.base);
  assert.equal(record.discovery.resourceMetadataUrl, `${remote.base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(record.tokens.refresh_token, "refresh-0");
  assert.ok(!JSON.stringify(record).includes("code_verifier"));
  await assert.rejects(fetch(callback), /fetch failed/);
});

test("configured scope overrides suggested scope; absent requested scope never requests all supported scopes", async (t) => {
  const remote = await fixture(t, { hintScope: false });
  const { client, opens } = service(t, remote);
  assert.equal((await client.authorize(remote.server)).state, "connected");
  assert.equal(new URL(opens[0]).searchParams.has("scope"), false);
  assert.equal(remote.registrations[0].scope, undefined);
  const configured = { ...remote.server, scope: "write" };
  assert.equal((await client.authorize(configured)).state, "connected");
  assert.equal(new URL(opens[1]).searchParams.get("scope"), "write");
});

test("pre-registered public client works without dynamic registration", async (t) => {
  const remote = await fixture(t, { registration: false });
  const { client, opens } = service(t, remote);
  assert.equal((await client.authorize({ ...remote.server, clientId: "public-client" })).state, "connected");
  assert.equal(remote.registrations.length, 0);
  assert.equal(new URL(opens[0]).searchParams.get("client_id"), "public-client");
});

test("bad state does not consume a valid authorization and concurrent authorize opens one browser", async (t) => {
  const remote = await fixture(t);
  let browserUrl;
  const { client } = service(t, remote, { openExternal: async (value) => { browserUrl = value; } });
  const first = client.authorize(remote.server);
  const second = client.authorize(remote.server);
  assert.equal(first, second);
  await waitUntil(() => browserUrl);
  assert.equal(client.status(remote.server).state, "authorizing");
  const bad = await remote.browser(browserUrl, { state: "attacker-state", code: privateText });
  assert.equal(bad.status, 400);
  assert.ok(!(await bad.text()).includes(privateText));
  assert.equal(remote.grants.length, 0);
  assert.equal(client.status(remote.server).state, "authorizing");
  assert.equal((await remote.browser(browserUrl)).status, 200);
  assert.equal((await first).state, "connected");
});

test("callback issuer mismatch and denied authorization produce fixed safe errors", async (t) => {
  for (const overrides of [
    { iss: "https://attacker.invalid", code: privateText },
    { error: "access_denied", error_description: privateText }
  ]) {
    const remote = await fixture(t);
    const { client, records } = service(t, remote, { openExternal: async (value) => {
      const response = await remote.browser(value, overrides);
      assert.equal(response.status, 400);
      assert.ok(!(await response.text()).includes(privateText));
    } });
    const status = await client.authorize(remote.server);
    assert.equal(status.state, "error");
    assert.ok(!status.error.includes(privateText));
    assert.ok(!status.error.includes("attacker.invalid"));
    assert.equal(records.size, 0);
    assert.equal(remote.grants.length, 0);
  }
});

test("issuer response support requires iss, while older servers may omit it", async (t) => {
  for (const requireIssuer of [true, false]) {
    const remote = await fixture(t, { requireIssuer });
    const { client, records } = service(t, remote, { openExternal: async (value) => {
      const response = await remote.browser(value, { iss: undefined });
      assert.equal(response.status, requireIssuer ? 400 : 200);
    } });
    const result = await client.authorize(remote.server);
    assert.equal(result.state, requireIssuer ? "error" : "connected");
    assert.equal(records.size, requireIssuer ? 0 : 1);
  }
});

test("refresh is single-flight, retains refresh tokens and deduplicates a rejected token across children", async (t) => {
  const remote = await fixture(t, { omitRefresh: true, sameAccessToken: true });
  const { client, opens, records } = service(t, remote);
  await client.authorize(remote.server);
  const refreshed = await Promise.all(Array.from({ length: 8 }, () => client.accessToken(remote.server, true, "access-0")));
  assert.deepEqual([...new Set(refreshed)], ["access-0"]);
  assert.equal(remote.refreshCount, 1);
  assert.equal(await client.accessToken(remote.server, true, "access-0"), "access-0");
  assert.equal(remote.refreshCount, 1);
  assert.equal(records.get(remote.server.id).tokens.refresh_token, "refresh-0");
  assert.equal(opens.length, 1);
});

test("stored grants survive service restart and refresh thirty seconds before expiry without opening a browser", async (t) => {
  const remote = await fixture(t, { expiresIn: 60 });
  let clock = 1_000_000;
  const { client, records } = service(t, remote, { now: () => clock });
  await client.authorize(remote.server);
  await client.dispose();
  let opened = false;
  const restarted = new McpOAuthService({
    read: (id) => records.get(id), write: (id, value) => { if (value) records.set(id, value); else records.delete(id); },
    openExternal: async () => { opened = true; }, now: () => clock, timeoutMs: 3000
  });
  t.after(() => restarted.dispose());
  assert.equal(restarted.status(remote.server).state, "connected");
  assert.equal(await restarted.accessToken(remote.server), "access-0");
  clock += 31_000;
  assert.equal(await restarted.accessToken(remote.server), "access-1");
  assert.equal(opened, false);
  assert.equal(remote.registrations.length, 1);
});

test("temporary network failures and timeouts retain refresh credentials and recover without authorization", async (t) => {
  for (const failure of ["offline", "timeout"]) {
    const remote = await fixture(t);
    let mode = "online";
    const { client, records, opens } = service(t, remote, {
      timeoutMs: 500,
      fetch: async (input, init) => {
        if (String(input) === `${remote.base}/token` && mode !== "online") {
          if (mode === "offline") throw new TypeError(`${privateText}: ${remote.base}/token`);
          return new Promise(() => {});
        }
        return fetch(input, init);
      }
    });
    assert.equal((await client.authorize(remote.server)).state, "connected");
    const original = structuredClone(records.get(remote.server.id));
    mode = failure;
    await assert.rejects(client.accessToken(remote.server, true, "access-0"), (error) => {
      assert.equal(error.code, "oauth_refresh_failed");
      assert.ok(!error.message.includes(privateText));
      assert.ok(!error.message.includes(remote.base));
      assert.ok(!error.message.includes("refresh-0"));
      return true;
    });
    assert.deepEqual(records.get(remote.server.id), original);
    assert.equal(client.status(remote.server).state, "connected");
    mode = "online";
    assert.equal(await client.accessToken(remote.server, true, "access-0"), "access-1");
    assert.equal(opens.length, 1);
  }
});

test("503 refresh failures retain credentials even when a proxy sends an invalid grant body", async (t) => {
  for (const refreshError of ["server_error", "invalid_grant"]) {
    const remote = await fixture(t, { refreshError, refreshStatus: 503 });
    const { client, records, opens } = service(t, remote);
    assert.equal((await client.authorize(remote.server)).state, "connected");
    const original = structuredClone(records.get(remote.server.id));
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => client.accessToken(remote.server, true, "access-0")));
    assert.equal(remote.refreshCount, 1);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason.code, "oauth_refresh_failed");
      assert.ok(!result.reason.message.includes(privateText));
    }
    assert.deepEqual(records.get(remote.server.id), original);
    assert.equal(client.status(remote.server).state, "connected");
    remote.settings.refreshError = undefined;
    assert.equal(await client.accessToken(remote.server, true, "access-0"), "access-2");
    assert.equal(opens.length, 1);
  }
});

test("confirmed grant and client failures clear credentials and require explicit authorization", async (t) => {
  for (const refreshError of ["invalid_grant", "invalid_client", "unauthorized_client"]) {
    const remote = await fixture(t, { refreshError });
    const { client, records, opens } = service(t, remote);
    assert.equal((await client.authorize(remote.server)).state, "connected");
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => client.accessToken(remote.server, true, "access-0")));
    assert.equal(remote.refreshCount, 1);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason.code, "oauth_required");
      assert.ok(!result.reason.message.includes(privateText));
    }
    assert.equal(records.size, 0);
    await assert.rejects(client.accessToken(remote.server), (error) => error.code === "oauth_required");
    assert.equal(opens.length, 1);
  }
});

test("URL, client ID and scope changes invalidate stored grants and never reuse credentials", async (t) => {
  const remote = await fixture(t);
  const { client, records } = service(t, remote);
  for (const change of [{ url: `${remote.base}/other` }, { clientId: "other-client" }, { scope: "other-scope" }]) {
    await client.authorize(remote.server);
    const changed = { ...remote.server, ...change };
    assert.equal(client.status(changed).state, "disconnected");
    assert.equal(records.size, 0);
    await assert.rejects(client.accessToken(changed), (error) => error.code === "oauth_required");
  }
});

test("disconnect cancels authorization, closes callback listener and cannot resurrect a grant", async (t) => {
  const remote = await fixture(t);
  let opened;
  const { client, records } = service(t, remote, { openExternal: async (value) => { opened = value; } });
  const pending = client.authorize(remote.server);
  await waitUntil(() => opened);
  const callback = new URL(new URL(opened).searchParams.get("redirect_uri"));
  const disconnected = client.disconnect(remote.server);
  assert.equal(records.size, 0, "clear credentials before the first await");
  assert.equal((await disconnected).state, "disconnected");
  assert.equal((await pending).state, "disconnected");
  await assert.rejects(fetch(callback), /fetch failed/);
  assert.equal(client.status(remote.server).state, "disconnected");
});

test("authorization timeout closes callback listener and returns a safe status", async (t) => {
  const remote = await fixture(t);
  let opened;
  const { client } = service(t, remote, { timeoutMs: 120, openExternal: async (value) => { opened = value; } });
  const result = await client.authorize(remote.server);
  assert.equal(result.state, "error");
  assert.match(result.error, /timed out/);
  assert.ok(opened);
  await assert.rejects(fetch(new URL(opened).searchParams.get("redirect_uri")), /fetch failed/);
});

test("disconnect while refresh is in flight prevents credential resurrection", async (t) => {
  let release;
  const remote = await fixture(t, { refreshGate: new Promise((resolve) => { release = resolve; }) });
  const { client, records } = service(t, remote);
  await client.authorize(remote.server);
  const refresh = client.accessToken(remote.server, true, "access-0");
  void refresh.catch(() => {});
  await waitUntil(() => remote.refreshCount === 1);
  await client.disconnect(remote.server);
  release();
  await assert.rejects(refresh, (error) => error.code === "oauth_required");
  assert.equal(records.size, 0);
  assert.equal(client.status(remote.server).state, "disconnected");
});

test("a cancelled old refresh failure cannot remove a new authorization grant", async (t) => {
  let release;
  const remote = await fixture(t, { refreshError: "invalid_grant", refreshGate: new Promise((resolve) => { release = resolve; }) });
  const { client, records } = service(t, remote);
  await client.authorize(remote.server);
  const oldRefreshes = Promise.allSettled(Array.from({ length: 4 }, () => client.accessToken(remote.server, true, "access-0")));
  await waitUntil(() => remote.refreshCount === 1);
  assert.equal((await client.authorize(remote.server)).state, "connected");
  const currentGrant = structuredClone(records.get(remote.server.id));
  release();
  for (const result of await oldRefreshes) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.code, "oauth_required");
  }
  assert.deepEqual(records.get(remote.server.id), currentGrant);
  assert.equal(client.status(remote.server).state, "connected");
  assert.equal(await client.accessToken(remote.server), "access-1");
});

test("OAuth JSON response limits reject oversized lengths and streamed bodies without exposing content", async (t) => {
  for (const declaredLength of [true, false]) {
    const remote = await fixture(t);
    let cancelled = false;
    let chunks = 0;
    const { client, records } = service(t, remote, {
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname === "/.well-known/oauth-authorization-server") {
          return new Response(new ReadableStream({
            pull(controller) { chunks++; controller.enqueue(new Uint8Array(512 * 1024)); },
            cancel() { cancelled = true; }
          }, { highWaterMark: 0 }), {
            headers: declaredLength ? { "Content-Length": String(1024 * 1024 + 1) } : {}
          });
        }
        return fetch(input, init);
      }
    });
    const status = await client.authorize(remote.server);
    assert.equal(status.state, "error");
    assert.ok(!status.error.includes(privateText));
    assert.ok(!status.error.includes(remote.base));
    assert.equal(cancelled, true);
    assert.equal(chunks, declaredLength ? 0 : 3);
    assert.equal(records.size, 0);
  }
});

test("invalid metadata, unsafe endpoints and token response bodies never expose secrets", async (t) => {
  for (const settings of [
    { metadataIssuer: "https://attacker.invalid" },
    { tokenEndpoint: "http://non-loopback.invalid/token" },
    { pkce: ["plain"] }, { failToken: true }
  ]) {
    const remote = await fixture(t, settings);
    const { client, records } = service(t, remote);
    const status = await client.authorize(remote.server);
    assert.equal(status.state, "error");
    assert.ok(!status.error.includes(privateText));
    assert.ok(!status.error.includes(remote.base));
    assert.ok(!status.error.includes("attacker.invalid"));
    assert.equal(records.size, 0);
  }
});

test("declared HTTPS issuer may have a different origin while insecure discovery and credential redirects are rejected", async (t) => {
  const remote = await fixture(t);
  let browserUrl;
  const requests = [];
  const injectedFetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url: url.href, redirect: init.redirect });
    if (url.href === remote.server.url) return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${remote.base}/.well-known/oauth-protected-resource/mcp"` } });
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: remote.server.url, authorization_servers: ["https://issuer.example"] });
    if (url.href === "https://issuer.example/.well-known/oauth-authorization-server") return Response.json({
      issuer: "https://issuer.example", authorization_endpoint: "https://login.example/authorize",
      token_endpoint: "https://issuer.example/token", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"]
    });
    throw new Error(privateText);
  };
  const { client } = service(t, remote, { fetch: injectedFetch, openExternal: async (value) => { browserUrl = value; } });
  const server = { ...remote.server, clientId: "public" };
  const pending = client.authorize(server);
  await waitUntil(() => browserUrl);
  assert.equal(new URL(browserUrl).origin, "https://login.example");
  assert.ok(requests.every((request) => request.redirect === "error"));
  await client.disconnect(server);
  assert.equal((await pending).state, "disconnected");
});
