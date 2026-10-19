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

const authorization = "Bearer private-fixture-token";
const secret = "private-server-response";

async function fixture(t, { transport = "http", mode = "ok", target } = {}) {
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
    if (mode === "unauthorized") {
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
