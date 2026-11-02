import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createRemoteMcpTransport,
  selfCheckRemoteMcpServer
} from "../dist-electron/cli/remoteMcpTransport.js";
import { runRemoteMcpBridge } from "../dist-electron/mcp/remoteMcpBridge.js";
import { createMcpOAuthBroker } from "../dist-electron/cli/mcpOAuthBroker.js";

const authorization = "Bearer private-fixture-token";
const secret = "private-server-response";

async function fixture(t, { transport = "http", mode = "ok", target, authorizationCheck } = {}) {
  const requests = [];
  const messages = [];
  const sockets = new Set();
  const eventStreams = new Set();
  let hangingConnections = 0;
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (mode === "hang") {
      hangingConnections += 1;
      res.on("close", () => { hangingConnections -= 1; });
      return;
    }
    if (mode === "unauthorized" || (authorizationCheck && !authorizationCheck(req.headers.authorization))) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end(secret);
      return;
    }
    if (mode === "redirect") {
      res.writeHead(307, { Location: target });
      res.end(secret);
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": connected\n\n");
      eventStreams.add(res);
      res.on("close", () => eventStreams.delete(res));
      if (transport === "sse") {
        res.write(`event: endpoint\ndata: ${mode === "cross-origin" ? target : "/messages"}\n\n`);
      }
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    messages.push(message);
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "remote-fixture", version: "1.0.0" }
      };
    } else if (message.method === "tools/list") {
      result = message.params?.cursor
        ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
        : { tools: [{ name: "echo", inputSchema: { type: "object" } }], nextCursor: "page-2" };
    } else if (message.method === "tools/call") {
      result = { content: [{ type: "text", text: message.params.arguments.value }] };
    } else if (message.method === "resources/list") {
      result = { resources: [{ uri: "fixture://document", name: "document" }] };
    } else if (message.method === "prompts/list") {
      result = { prompts: [{ name: "fixture-prompt" }] };
    }
    if (result === undefined) {
      res.writeHead(202).end();
      return;
    }
    const replies = [{ jsonrpc: "2.0", id: message.id, result }];
    if (message.method === "tools/call") {
      replies.push({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } });
      replies.push({ jsonrpc: "2.0", id: "server-request", method: "roots/list" });
    }
    if (transport === "sse") {
      for (const stream of eventStreams) {
        for (const reply of replies) stream.write(`data: ${JSON.stringify(reply)}\n\n`);
      }
      res.writeHead(202).end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(replies.length === 1 ? replies[0] : replies));
    }
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
  const url = `http://127.0.0.1:${server.address().port}/${transport === "sse" ? "sse" : "mcp"}`;
  return {
    requests, messages, eventStreams,
    get hangingConnections() { return hangingConnections; },
    config: { transport, url, headers: { Authorization: authorization, "X-Fixture": "present" } }
  };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function wire(stdioInput, stdioOutput) {
  const messages = [];
  const pending = new Set();
  let buffer = "";
  stdioOutput.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      messages.push(message);
      for (const waiter of pending) {
        if (waiter.match(message)) {
          pending.delete(waiter);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
      }
    }
  });
  const send = (message) => stdioInput.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  function next(match) {
    const found = messages.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, timeout: setTimeout(() => {
        pending.delete(waiter);
        reject(new Error("Timed out waiting for bridge message"));
      }, 2000) };
      pending.add(waiter);
    });
  }
  let id = 0;
  async function request(method, params) {
    const requestId = ++id;
    const response = next((message) => message.id === requestId);
    send({ id: requestId, method, params });
    return (await response).result;
  }
  return { send, next, request };
}

for (const transport of ["http", "sse"]) {
  test(`${transport} self-check initializes, paginates tools, authenticates GET/POST and closes streams`, async (t) => {
    const remote = await fixture(t, { transport });
    assert.deepEqual(await selfCheckRemoteMcpServer(remote.config), ["echo", "second"]);
    await waitUntil(() => remote.requests.some((request) => request.method === "GET"));
    assert.ok(remote.requests.some((request) => request.method === "POST"));
    for (const request of remote.requests) {
      assert.equal(request.headers.authorization, authorization);
      assert.equal(request.headers["x-fixture"], "present");
    }
    await waitUntil(() => remote.eventStreams.size === 0);
  });

  test(`${transport} raw stdio bridge forwards tools, resources, prompts, notifications and server requests`, async (t) => {
    const remote = await fixture(t, { transport });
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = wire(input, output);
    const env = { FREEBUDDY_REMOTE_MCP_CONFIG: JSON.stringify(remote.config) };
    const originalSignalListeners = process.listenerCount("SIGTERM");
    const running = runRemoteMcpBridge({ stdin: input, stdout: output, env });
    t.after(async () => { input.end(); await running; });
    assert.equal(env.FREEBUDDY_REMOTE_MCP_CONFIG, undefined);
    const initialized = await rpc.request("initialize", {
      protocolVersion: "2025-03-26", capabilities: { roots: {} },
      clientInfo: { name: "raw-bridge-test", version: "1.0.0" }
    });
    assert.equal(initialized.serverInfo.name, "remote-fixture");
    rpc.send({ method: "notifications/initialized" });
    const tool = await rpc.request("tools/call", { name: "echo", arguments: { value: "bridged" } });
    assert.equal(tool.content[0].text, "bridged");
    assert.equal((await rpc.request("resources/list", {})).resources[0].name, "document");
    assert.equal((await rpc.request("prompts/list", {})).prompts[0].name, "fixture-prompt");
    assert.equal((await rpc.next((message) => message.method === "notifications/message")).params.data, "hello");
    await rpc.next((message) => message.id === "server-request");
    rpc.send({ id: "server-request", result: { roots: [] } });
    rpc.send({ method: "notifications/fixture", params: { value: "from-client" } });
    await waitUntil(() => remote.messages.some((message) => message.method === "notifications/fixture"));
    assert.equal(remote.messages.filter((message) => message.method === "initialize").length, 1);
    assert.ok(remote.messages.some((message) => message.id === "server-request" && message.result));
    const toolRequest = remote.requests.find((request) => request.method === "POST" && request.headers["mcp-protocol-version"]);
    assert.equal(toolRequest?.headers["mcp-protocol-version"], "2025-03-26");
    input.end();
    await running;
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(process.listenerCount("SIGTERM"), originalSignalListeners);
    await waitUntil(() => remote.eventStreams.size === 0);
  });

  test(`${transport} timeout and authentication errors are safe and clean up connections`, async (t) => {
    const hanging = await fixture(t, { transport, mode: "hang" });
    await assert.rejects(selfCheckRemoteMcpServer(hanging.config, 80), (error) => {
      assert.equal(error.code, "remote_timeout");
      assert.match(error.message, /timed out/i);
      assert.ok(!error.message.includes(hanging.config.url));
      return true;
    });
    const denied = await fixture(t, { transport, mode: "unauthorized" });
    await assert.rejects(selfCheckRemoteMcpServer(denied.config, 1000), (error) => {
      assert.equal(error.code, "remote_auth_failed");
      assert.match(error.message, /401/);
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes(authorization));
      assert.ok(!error.message.includes(denied.config.url));
      return true;
    });
  });

  test(`${transport} redirects never forward credentials to the target`, async (t) => {
    const target = await fixture(t);
    const redirect = await fixture(t, { transport, mode: "redirect", target: target.config.url });
    await assert.rejects(selfCheckRemoteMcpServer(redirect.config, 1000), /Remote MCP/);
    assert.equal(target.requests.length, 0);
  });
}

test("SSE rejects a cross-origin endpoint before sending authenticated POST", async (t) => {
  const target = await fixture(t);
  const remote = await fixture(t, { transport: "sse", mode: "cross-origin", target: target.config.url });
  await assert.rejects(selfCheckRemoteMcpServer(remote.config, 1000), (error) => {
    assert.ok(!error.message.includes(remote.config.url));
    assert.ok(!error.message.includes(target.config.url));
    return true;
  });
  assert.equal(target.requests.length, 0);
  assert.equal(remote.requests.filter((request) => request.method === "POST").length, 0);
  await waitUntil(() => remote.eventStreams.size === 0);
});

test("remote configuration rejects unsupported schemes, embedded credentials and fragments", () => {
  for (const url of ["file:///tmp/mcp", "http://username:password@127.0.0.1/mcp", "http://127.0.0.1/mcp#fragment"]) {
    assert.throws(() => createRemoteMcpTransport({ transport: "http", url, headers: {} }), /Invalid remote MCP configuration/);
  }
});

test("closing stdin during pending SSE startup immediately aborts the connection", async (t) => {
  const remote = await fixture(t, { transport: "sse", mode: "hang" });
  const input = new PassThrough();
  const output = new PassThrough();
  const env = { FREEBUDDY_REMOTE_MCP_CONFIG: JSON.stringify(remote.config) };
  const listeners = process.listenerCount("SIGTERM");
  // Exercise a buffered initialize request before the SSE endpoint is known.
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  const running = runRemoteMcpBridge({ stdin: input, stdout: output, env });
  t.after(async () => { input.end(); await running; });
  await waitUntil(() => remote.hangingConnections === 1);
  input.end();
  let deadline;
  try {
    await Promise.race([
      running,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Bridge waited for its SSE startup timeout after stdin EOF")), 500);
      })
    ]);
  } finally {
    clearTimeout(deadline);
  }
  await waitUntil(() => remote.hangingConnections === 0);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(process.listenerCount("SIGTERM"), listeners);
  assert.equal(env.FREEBUDDY_REMOTE_MCP_CONFIG, undefined);
  assert.equal(remote.messages.length, 0);
});

for (const transport of ["http", "sse"]) {
  test(`${transport} bridge remote failure rejects safely and removes stdin and signal listeners`, async (t) => {
    const remote = await fixture(t, { transport, mode: "unauthorized" });
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = wire(input, output);
    const listeners = process.listenerCount("SIGINT");
    const running = runRemoteMcpBridge({
      stdin: input, stdout: output,
      env: { FREEBUDDY_REMOTE_MCP_CONFIG: JSON.stringify(remote.config) }
    });
    rpc.send({ id: 1, method: "initialize", params: {} });
    await assert.rejects(running, (error) => {
      assert.equal(error.message, "Remote MCP bridge connection failed.");
      return true;
    });
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(process.listenerCount("SIGINT"), listeners);
  });
}

test("bridge executable releases connections on stdin end, SIGTERM and SIGINT", async (t) => {
  const remote = await fixture(t);
  const entry = fileURLToPath(new URL("../dist-electron/mcp/remoteMcpBridge.js", import.meta.url));
  for (const shutdown of ["stdin", "SIGTERM", "SIGINT"]) {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, FREEBUDDY_REMOTE_MCP_CONFIG: JSON.stringify(remote.config) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Bridge process did not exit")), 2000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    const rpc = wire(child.stdin, child.stdout);
    await rpc.request("initialize", {
      protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "bridge-process-test", version: "1.0.0" }
    });
    rpc.send({ method: "notifications/initialized" });
    await waitUntil(() => remote.eventStreams.size > 0);
    if (shutdown === "stdin") child.stdin.end();
    else child.kill(shutdown);
    // Windows child.kill() forcibly terminates the process without running JS
    // signal handlers. Stdin EOF still exercises graceful shutdown everywhere.
    const expectedExit = process.platform === "win32" && shutdown !== "stdin"
      ? { code: null, signal: shutdown }
      : { code: 0, signal: null };
    assert.deepEqual(await exited, expectedExit, `${process.platform}: ${shutdown}`);
    assert.equal(stderr, "");
    await waitUntil(() => remote.eventStreams.size === 0);
  }
});

for (const transport of ["http", "sse"]) {
  test(`${transport} OAuth authenticates GET and POST through the local broker`, async (t) => {
    const accessToken = "private-oauth-access-token";
    const calls = [];
    const broker = createMcpOAuthBroker({ getAccessToken: async (...args) => { calls.push(args); return accessToken; } });
    t.after(() => broker.dispose());
    const remote = await fixture(t, { transport, authorizationCheck: (value) => value === `Bearer ${accessToken}` });
    const oauth = await broker.bind("oauth-server", remote.config.url);
    const config = { ...remote.config, headers: { "X-Fixture": "present" }, oauth };
    assert.deepEqual(await selfCheckRemoteMcpServer(config), ["echo", "second"]);
    assert.ok(remote.requests.some((request) => request.method === "GET"));
    assert.ok(remote.requests.some((request) => request.method === "POST"));
    for (const request of remote.requests) {
      assert.equal(request.headers.authorization, `Bearer ${accessToken}`);
      assert.equal(request.headers["x-fixture"], "present");
      assert.equal(JSON.stringify(request).includes(oauth.token), false);
    }
    assert.ok(calls.length > 0);
    for (const call of calls) assert.deepEqual(call, ["oauth-server", false, undefined]);
  });

  test(`${transport} OAuth retries an unauthorized request only once and returns a safe login error`, async (t) => {
    const calls = [];
    const broker = createMcpOAuthBroker({ getAccessToken: async (...args) => { calls.push(args); return args[1] ? "new-private-token" : "old-private-token"; } });
    t.after(() => broker.dispose());
    const remote = await fixture(t, { transport, mode: "unauthorized" });
    const oauth = await broker.bind("oauth-server", remote.config.url);
    await assert.rejects(selfCheckRemoteMcpServer({ ...remote.config, headers: {}, oauth }, 1000), (error) => {
      assert.equal(error.code, "oauth_required");
      for (const value of [secret, oauth.token, "old-private-token", "new-private-token", remote.config.url]) {
        assert.equal(error.message.includes(value), false);
      }
      return true;
    });
    assert.equal(remote.requests.length, 2);
    assert.deepEqual(calls, [["oauth-server", false, undefined], ["oauth-server", true, "old-private-token"]]);
  });
}

test("concurrent OAuth 401 responses share a single refresh and retry with the replacement token", async (t) => {
  let acceptedToken = "old-private-token";
  let currentToken = "old-private-token";
  let rejected = 0;
  const calls = [];
  const broker = createMcpOAuthBroker({
    getAccessToken: async (...args) => {
      calls.push(args);
      if (args[1]) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        currentToken = "new-private-token";
      }
      return currentToken;
    }
  });
  t.after(() => broker.dispose());
  const remote = await fixture(t, {
    authorizationCheck: (value) => {
      const valid = value === `Bearer ${acceptedToken}`;
      if (!valid) rejected += 1;
      return valid;
    }
  });
  const oauth = await broker.bind("oauth-concurrent", remote.config.url);
  const transport = createRemoteMcpTransport({ ...remote.config, headers: {}, oauth });
  transport.onmessage = () => {};
  t.after(() => transport.close());
  await transport.start();
  await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "concurrent-test", version: "1.0.0" }
  } });
  acceptedToken = "new-private-token";
  await Promise.all([
    transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    transport.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
  ]);
  assert.ok(rejected >= 2, "Both concurrent requests should first use the rejected token");
  assert.equal(calls.filter((args) => args[1]).length, 1);
  assert.deepEqual(calls.find((args) => args[1]), ["oauth-concurrent", true, "old-private-token"]);
  assert.equal(remote.messages.filter((message) => message.method === "tools/list").length, 2);
});

test("active OAuth transports observe main-process token replacement and revocation before their next request", async (t) => {
  let currentToken = "first-private-token";
  const broker = createMcpOAuthBroker({ getAccessToken: async () => currentToken });
  t.after(() => broker.dispose());
  const remote = await fixture(t, { authorizationCheck: (value) => value === `Bearer ${currentToken}` });
  const oauth = await broker.bind("oauth-active", remote.config.url);
  const transport = createRemoteMcpTransport({ ...remote.config, headers: {}, oauth });
  transport.onmessage = () => {};
  t.after(() => transport.close());
  await transport.start();
  await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "active-test", version: "1.0.0" }
  } });
  currentToken = "replacement-private-token";
  const startIndex = remote.requests.length;
  await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const later = remote.requests.slice(startIndex);
  assert.ok(later.some((request) => request.method === "POST"));
  for (const request of later) assert.equal(request.headers.authorization, `Bearer ${currentToken}`);
  broker.revoke("oauth-active");
  const before = remote.requests.length;
  await assert.rejects(transport.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }), { code: "oauth_required" });
  assert.equal(remote.requests.length, before, "A revoked bridge cannot send another MCP request");
});

test("OAuth broker failures never expose service messages or request MCP endpoints", async (t) => {
  const serviceSecret = "private-refresh-token-service-error";
  const broker = createMcpOAuthBroker({ getAccessToken: async () => { throw new Error(serviceSecret); } });
  t.after(() => broker.dispose());
  const remote = await fixture(t);
  const oauth = await broker.bind("oauth-failure", remote.config.url);
  await assert.rejects(selfCheckRemoteMcpServer({ ...remote.config, headers: {}, oauth }), (error) => {
    assert.equal(error.code, "oauth_unavailable");
    assert.equal(error.message, "Authorization is temporarily unavailable. Try again.");
    assert.equal(error.message.includes(serviceSecret), false);
    assert.equal(error.message.includes(oauth.token), false);
    return true;
  });
  assert.equal(remote.requests.length, 0);
});

for (const remoteTransport of ["http", "sse"]) {
  for (const action of ["revoke", "replace", "dispose"]) {
    test(`${remoteTransport} OAuth ${action} closes an initialized live stream and blocks old notifications`, async (t) => {
      const accessToken = "private-live-access-token";
      const broker = createMcpOAuthBroker({ getAccessToken: async () => accessToken });
      t.after(() => broker.dispose());
      const remote = await fixture(t, { transport: remoteTransport, authorizationCheck: (value) => value === `Bearer ${accessToken}` });
      const oauth = await broker.bind("live-oauth", remote.config.url);
      const transport = createRemoteMcpTransport({ ...remote.config, headers: {}, oauth });
      t.after(() => transport.close());
      const messages = [];
      const errors = [];
      let closed = 0;
      transport.onmessage = (message) => { messages.push(message); };
      transport.onerror = (error) => { errors.push(error); };
      transport.onclose = () => { closed += 1; };
      await transport.start();
      await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "live-oauth-test", version: "1.0.0" }
      } });
      await waitUntil(() => messages.some((message) => message.id === 1));
      await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await waitUntil(() => remote.eventStreams.size === 1);
      const streams = [...remote.eventStreams];
      const notification = (data) => `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data } })}\n\n`;
      for (const stream of streams) stream.write(notification("before-revocation"));
      await waitUntil(() => messages.some((message) => message.params?.data === "before-revocation"));
      if (action === "replace") await broker.bind("live-oauth", `${remote.config.url}/changed`);
      else if (action === "dispose") await broker.dispose();
      else broker.revoke("live-oauth");
      await waitUntil(() => closed === 1);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "oauth_required");
      for (const value of [oauth.token, accessToken, remote.config.url]) assert.equal(errors[0].message.includes(value), false);
      for (const stream of streams) if (!stream.destroyed) stream.write(notification("after-revocation"));
      await waitUntil(() => remote.eventStreams.size === 0);
      assert.equal(messages.some((message) => message.params?.data === "after-revocation"), false);
      const before = remote.requests.length;
      await assert.rejects(transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), { code: "oauth_required" });
      assert.equal(remote.requests.length, before);
      await transport.close();
      assert.equal(closed, 1);
    });
  }
}

test("temporary OAuth refresh failures remain retryable on the same active transport", async (t) => {
  let unavailable = false;
  const broker = createMcpOAuthBroker({ getAccessToken: async () => {
    if (unavailable) throw Object.assign(new Error("private-service-error"), { code: "oauth_refresh_failed" });
    return "current-private-token";
  } });
  t.after(() => broker.dispose());
  const remote = await fixture(t, { authorizationCheck: (value) => value === "Bearer current-private-token" });
  const oauth = await broker.bind("retryable-oauth", remote.config.url);
  const transport = createRemoteMcpTransport({ ...remote.config, headers: {}, oauth });
  t.after(() => transport.close());
  let closed = false;
  const errors = [];
  transport.onmessage = () => {};
  transport.onclose = () => { closed = true; };
  transport.onerror = (error) => { errors.push(error); };
  await transport.start();
  await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "retryable-oauth-test", version: "1.0.0" }
  } });
  unavailable = true;
  const before = remote.requests.length;
  await assert.rejects(transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), (error) => {
    assert.equal(error.code, "oauth_unavailable");
    assert.equal(error.message, "Authorization is temporarily unavailable. Try again.");
    return true;
  });
  assert.equal(remote.requests.length, before);
  assert.equal(closed, false);
  unavailable = false;
  await transport.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  assert.ok(remote.messages.some((message) => message.id === 3));
  assert.equal(closed, false);
  await transport.close();
  assert.equal(errors.some((error) => error.code === "oauth_required"), false);
});

async function watchFixture(t, { ready = true } = {}) {
  const streams = new Set();
  const sockets = new Set();
  const path = `/mcp-oauth/token/${"a".repeat(64)}`;
  const token = "b".repeat(43);
  const server = http.createServer(async (req, res) => {
    if (req.url === `${path}/watch` && req.method === "GET" && req.headers.authorization === `Bearer ${token}`) {
      streams.add(res);
      res.on("close", () => streams.delete(res));
      if (ready) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: ready\ndata: {}\n\n");
      }
      return;
    }
    if (req.url === path && req.method === "POST" && req.headers.authorization === `Bearer ${token}`) {
      for await (const _chunk of req) { /* Drain token request. */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accessToken: "private-fixture-access-token" }));
      return;
    }
    res.writeHead(403).end();
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { streams, oauth: { endpoint: `http://127.0.0.1:${server.address().port}${path}`, token } };
}

for (const mode of ["eof", "network-error"]) {
  test(`an unexpected OAuth watch ${mode} closes the live remote connection safely`, async (t) => {
    const broker = await watchFixture(t);
    const remote = await fixture(t);
    const transport = createRemoteMcpTransport({ ...remote.config, headers: {}, oauth: broker.oauth });
    t.after(() => transport.close());
    const messages = [];
    const errors = [];
    let closed = 0;
    transport.onmessage = (message) => { messages.push(message); };
    transport.onerror = (error) => { errors.push(error); };
    transport.onclose = () => { closed += 1; };
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "watch-loss-test", version: "1.0.0" }
    } });
    await waitUntil(() => messages.some((message) => message.id === 1));
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await waitUntil(() => remote.eventStreams.size === 1);
    for (const stream of broker.streams) {
      if (mode === "eof") stream.end();
      else stream.destroy();
    }
    await waitUntil(() => closed === 1 && remote.eventStreams.size === 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "oauth_required");
    assert.equal(errors[0].message, "Sign in to this MCP server again.");
    const before = remote.requests.length;
    await assert.rejects(transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), { code: "oauth_required" });
    assert.equal(remote.requests.length, before);
  });
}

test("closing while the OAuth watch starts cancels it without login errors or a remote connection", async (t) => {
  const broker = await watchFixture(t, { ready: false });
  const remote = await fixture(t);
  const transport = createRemoteMcpTransport({ ...remote.config, headers: {}, oauth: broker.oauth });
  t.after(() => transport.close());
  const errors = [];
  let closed = 0;
  transport.onerror = (error) => { errors.push(error); };
  transport.onclose = () => { closed += 1; };
  const starting = transport.start();
  assert.equal(transport.start(), starting, "Concurrent starts share one watch and transport startup");
  const stopped = assert.rejects(starting, /closed/);
  await waitUntil(() => broker.streams.size === 1);
  await transport.close();
  await stopped;
  await waitUntil(() => broker.streams.size === 0);
  assert.equal(closed, 1);
  assert.deepEqual(errors, []);
  assert.equal(remote.requests.length, 0);
});

test("OAuth configuration rejects external broker endpoints and conflicting authorization headers", async (t) => {
  const broker = createMcpOAuthBroker({ getAccessToken: async () => "access-token" });
  t.after(() => broker.dispose());
  const oauth = await broker.bind("oauth-config", "https://mcp.example.com/mcp");
  const config = { transport: "http", url: "https://mcp.example.com/mcp", headers: {}, oauth };
  for (const endpoint of [
    oauth.endpoint.replace("127.0.0.1", "localhost"),
    oauth.endpoint.replace("127.0.0.1", "example.com"),
    oauth.endpoint.replace("http:", "https:"),
    `${oauth.endpoint}?query`, `${oauth.endpoint}#fragment`,
  ]) assert.throws(() => createRemoteMcpTransport({ ...config, oauth: { ...oauth, endpoint } }), { code: "remote_config_invalid" });
  for (const name of ["Authorization", "authorization", "AUTHORIZATION"]) {
    assert.throws(() => createRemoteMcpTransport({ ...config, headers: { [name]: "Bearer manual" } }), { code: "remote_config_invalid" });
  }
});

test("real stdio bridge gets OAuth access tokens from the broker without exposing them on stdout or stderr", async (t) => {
  const accessToken = "private-real-stdio-access-token";
  const broker = createMcpOAuthBroker({ getAccessToken: async () => accessToken });
  t.after(() => broker.dispose());
  const remote = await fixture(t, { authorizationCheck: (value) => value === `Bearer ${accessToken}` });
  const oauth = await broker.bind("stdio-oauth-server", remote.config.url);
  const entry = fileURLToPath(new URL("../dist-electron/mcp/remoteMcpBridge.js", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, FREEBUDDY_REMOTE_MCP_CONFIG: JSON.stringify({ ...remote.config, headers: {}, oauth }) },
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OAuth bridge did not exit")), 3000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  const rpc = wire(child.stdin, child.stdout);
  const initialized = await rpc.request("initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "oauth-stdio-test", version: "1.0.0" }
  });
  assert.equal(initialized.serverInfo.name, "remote-fixture");
  rpc.send({ method: "notifications/initialized" });
  assert.equal((await rpc.request("tools/list", {})).tools[0].name, "echo");
  child.stdin.end();
  assert.equal(await exited, 0);
  assert.equal(output.includes(accessToken), false);
  assert.equal(output.includes(oauth.token), false);
  assert.equal(output.includes("refresh_token"), false);
});
