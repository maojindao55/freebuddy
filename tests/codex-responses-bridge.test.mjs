import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";

// node:http instead of fetch(): undici keep-alive sockets + --test-force-exit
// trip a libuv assertion on Windows at process exit.
function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            contentType: res.headers["content-type"] ?? "",
            raw: Buffer.concat(chunks).toString("utf8"),
            json: () => JSON.parse(Buffer.concat(chunks).toString("utf8"))
          });
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const bridgeSource = fs.readFileSync(
  new URL("../electron/cli/responsesBridge.ts", import.meta.url),
  "utf8"
);
const storeSource = fs.readFileSync(
  new URL("../electron/cli/store.ts", import.meta.url),
  "utf8"
);

let bridge;
try {
  bridge = await import("../dist-electron/cli/responsesBridge.js");
} catch {
  bridge = undefined;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    http
      .get(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              status: res.statusCode,
              json: () => JSON.parse(Buffer.concat(chunks).toString("utf8"))
            });
          });
        }
      )
      .on("error", reject);
  });
}

function sseDataChunks(raw) {
  return raw
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice("data: ".length));
}

function sseEvents(raw) {
  return sseDataChunks(raw)
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line));
}

test("codex BYOK chat wire API is routed through the local bridge", () => {
  assert.match(
    storeSource,
    /registerCodexChatBridgeRoute/,
    "resolveCodexByokEnv must register a bridge route for chat wire APIs"
  );
  assert.match(
    storeSource,
    /ensureCodexChatBridge/,
    "store must expose ensureCodexChatBridge for session runners"
  );
  assert.match(
    bridgeSource,
    /chat\/completions/,
    "bridge module must document the chat/completions translation"
  );
});

test("session runners pre-start the codex chat bridge", () => {
  for (const file of [
    "../electron/cli/runtime.ts",
    "../electron/cli/acpAuth.ts",
    "../electron/cli/sessionConfigProbe.ts"
  ]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(
      source,
      /await ensureCodexChatBridge\(\)/,
      `${file} must await ensureCodexChatBridge before resolving BYOK env`
    );
  }
});

test("translateResponsesRequestToChat maps instructions, input and tools", (t) => {
  if (!bridge) {
    t.skip("dist-electron bridge not built yet");
    return;
  }
  const { translateResponsesRequestToChat } = bridge;
  const result = translateResponsesRequestToChat({
    model: "deepseek-chat",
    instructions: "You are a coder.",
    stream: true,
    max_output_tokens: 1234,
    temperature: 0.2,
    reasoning: { effort: "high", summary: "auto" },
    parallel_tool_calls: false,
    tool_choice: { type: "function", name: "shell" },
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "be nice" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "reasoning", summary: [] },
      { type: "function_call", call_id: "call_a", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call", call_id: "call_b", name: "shell", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_a", output: "ok" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }
    ],
    tools: [
      {
        type: "function",
        name: "shell",
        description: "run shell",
        strict: false,
        parameters: { type: "object" }
      },
      { type: "web_search" },
      { type: "custom", name: "apply_patch", description: "patch" }
    ]
  });

  assert.ok(result);
  const chat = result.chat;
  assert.equal(chat.model, "deepseek-chat");
  assert.equal(chat.stream, true);
  assert.deepEqual(chat.stream_options, { include_usage: true });
  assert.equal(chat.max_tokens, 1234);
  assert.equal(chat.temperature, 0.2);
  assert.equal(chat.reasoning_effort, "high");
  assert.equal(chat.parallel_tool_calls, false);
  assert.deepEqual(chat.tool_choice, {
    type: "function",
    function: { name: "shell" }
  });
  assert.deepEqual(result.customToolNames, ["apply_patch"]);

  const messages = chat.messages;
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, "You are a coder.");
  assert.equal(messages[1].role, "system");
  assert.equal(messages[1].content, "be nice");
  assert.equal(messages[2].role, "user");
  assert.equal(messages[2].content, "hello");
  // consecutive function_calls merge into one assistant tool_calls message
  assert.deepEqual(
    messages[3].tool_calls.map((call) => call.id),
    ["call_a", "call_b"]
  );
  assert.equal(messages[4].role, "tool");
  assert.equal(messages[4].tool_call_id, "call_a");
  assert.equal(messages[4].content, "ok");
  assert.equal(messages[5].role, "assistant");
  assert.equal(messages[5].content, "done");

  assert.equal(chat.tools.length, 2);
  assert.deepEqual(chat.tools[0].function.parameters, { type: "object" });
  assert.equal(chat.tools[0].function.strict, false);
  assert.deepEqual(chat.tools[1].function.parameters.required, ["input"]);

  // string input becomes a single user message
  const simple = translateResponsesRequestToChat({
    model: "m",
    input: "hi",
    stream: false
  });
  assert.equal(simple.chat.stream, false);
  assert.equal(simple.chat.stream_options, undefined);
  assert.equal(simple.chat.messages[0].role, "user");
  assert.equal(simple.chat.messages[0].content, "hi");
});

test("stripOptionalChatFields removes chat extensions providers reject", (t) => {
  if (!bridge) {
    t.skip("dist-electron bridge not built yet");
    return;
  }
  const stripped = bridge.stripOptionalChatFields({
    model: "m",
    messages: [],
    reasoning_effort: "high",
    stream_options: { include_usage: true },
    parallel_tool_calls: false,
    tools: [
      { type: "function", function: { name: "shell", strict: true } }
    ]
  });
  assert.equal(stripped.reasoning_effort, undefined);
  assert.equal(stripped.stream_options, undefined);
  assert.equal(stripped.parallel_tool_calls, undefined);
  assert.equal(stripped.tools[0].function.strict, undefined);
  assert.equal(stripped.tools[0].function.name, "shell");
});

test("ChatToResponsesStream translates chat SSE chunks into Responses events", (t) => {
  if (!bridge) {
    t.skip("dist-electron bridge not built yet");
    return;
  }
  const stream = new bridge.ChatToResponsesStream("deepseek-chat", ["apply_patch"]);
  const chunks = [];
  for (const raw of stream.begin()) chunks.push(...sseDataChunks(raw));
  for (const chunk of [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { reasoning_content: "thinking" } }] },
    { choices: [{ delta: { content: "Hello" } }] },
    { choices: [{ delta: { content: " world" } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_z", function: { name: "apply_patch", arguments: "{\"in" } },
              { index: 0, function: { arguments: "put\": \"*** Begin Patch\"}" } }
            ]
          }
        }
      ]
    },
    {
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    }
  ]) {
    for (const raw of stream.handleChatChunk(chunk)) chunks.push(...sseDataChunks(raw));
  }
  for (const raw of stream.finish()) chunks.push(...sseDataChunks(raw));

  const events = chunks
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line));
  assert.equal(chunks.at(-1), "[DONE]");

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.output_item.done",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.output_item.done",
      "response.completed"
    ]
  );

  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.usage.input_tokens, 11);
  assert.equal(completed.response.usage.output_tokens, 7);
  assert.equal(completed.response.usage.total_tokens, 18);

  const messageDone = events.find(
    (event) =>
      event.type === "response.output_item.done" && event.item.type === "message"
  );
  assert.equal(messageDone.item.content[0].text, "Hello world");

  const callDone = events.find(
    (event) =>
      event.type === "response.output_item.done" &&
      event.item.type === "function_call"
  );
  assert.equal(callDone.item.call_id, "call_z");
  assert.equal(callDone.item.name, "apply_patch");
  assert.equal(
    callDone.item.arguments,
    "*** Begin Patch",
    "custom (freeform) tool arguments must be unwrapped from {input: …}"
  );
});

test("SseParser handles split frames, CRLF and comments", (t) => {
  if (!bridge) {
    t.skip("dist-electron bridge not built yet");
    return;
  }
  const parser = new bridge.SseParser();
  const frames = [
    ...parser.push('data: {"a":1}\n\ndata: {"b":'),
    ...parser.push('2}\n\n: keepalive\n\ndata: [DONE]\r\n\r\n')
  ];
  assert.deepEqual(
    frames.map((frame) => frame.data),
    ['{"a":1}', '{"b":2}', "[DONE]"]
  );
});

test("bridge server proxies /v1/<route>/responses to upstream chat/completions", async (t) => {
  if (!bridge) {
    t.skip("dist-electron bridge not built yet");
    return;
  }

  const captured = { headers: {}, path: "", body: null };
  const upstreamChunks = [
    { choices: [{ delta: { reasoning_content: "hmm" } }] },
    { choices: [{ delta: { content: "Hi " } }] },
    { choices: [{ delta: { content: "there" } }] },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    }
  ];
  const upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      captured.path = req.url;
      captured.headers = req.headers;
      captured.body = JSON.parse(raw);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of upstreamChunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  try {
    const port = await bridge.startResponsesBridge();
    assert.ok(port, "bridge must start");
    const route = bridge.registerCodexChatBridgeRoute(
      `http://127.0.0.1:${upstreamPort}/v1`
    );
    assert.ok(route);

    const response = await postJson(
      `http://127.0.0.1:${port}/v1/${route.routeId}/responses`,
      {
        model: "deepseek-chat",
        instructions: "sys",
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hey" }]
          }
        ]
      },
      { authorization: "Bearer sk-test" }
    );

    assert.equal(response.status, 200);
    assert.match(response.contentType, /text\/event-stream/);
    const raw = response.raw;
    const events = sseEvents(raw);
    assert.equal(events[0].type, "response.created");
    assert.equal(
      events.find(
        (event) =>
          event.type === "response.output_item.done" &&
          event.item.type === "message"
      ).item.content[0].text,
      "Hi there"
    );
    const completed = events.find((event) => event.type === "response.completed");
    assert.equal(completed.response.usage.input_tokens, 5);
    assert.equal(completed.response.usage.output_tokens, 2);
    assert.equal(raw.trimEnd().endsWith("data: [DONE]"), true);

    assert.equal(captured.path, "/v1/chat/completions");
    assert.equal(captured.headers.authorization, "Bearer sk-test");
    assert.equal(captured.body.model, "deepseek-chat");
    assert.deepEqual(captured.body.stream_options, { include_usage: true });
    assert.equal(captured.body.messages[0].content, "sys");
    assert.equal(captured.body.messages[1].content, "hey");
  } finally {
    await bridge.closeResponsesBridge();
    await closeServer(upstream);
  }
});

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

test("bridge retries optional-field rejections and relays other errors", async (t) => {
  if (!bridge) {
    t.skip("dist-electron bridge not built yet");
    return;
  }

  const requests = [];
  const upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      if (
        body.reasoning_effort !== undefined ||
        body.stream_options !== undefined
      ) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: "unknown field: stream_options" } })
        );
        return;
      }
      if (body.stream === false) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: "provider exploded" } })
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          model: "deepseek-chat",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "plain" }
            }
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
        })
      );
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  try {
    const port = await bridge.startResponsesBridge();
    const route = bridge.registerCodexChatBridgeRoute(
      `http://127.0.0.1:${upstreamPort}/v1`
    );
    const endpoint = `http://127.0.0.1:${port}/v1/${route.routeId}/responses`;

    // nothing to strip → upstream error is relayed untouched
    const relayed = await postJson(endpoint, {
      model: "m",
      input: "hi",
      stream: false
    });
    assert.equal(relayed.status, 400);
    assert.deepEqual(relayed.json(), {
      error: { message: "provider exploded" }
    });

    // optional fields rejected → one retry without them succeeds
    const ok = await postJson(endpoint, {
      model: "deepseek-chat",
      input: "hi",
      stream: true,
      reasoning: { effort: "low" }
    });
    assert.equal(ok.status, 200);
    const lastTwo = requests.slice(-2);
    assert.equal(lastTwo[0].reasoning_effort, "low");
    assert.notEqual(lastTwo[0].stream_options, undefined);
    assert.equal(lastTwo[1].reasoning_effort, undefined);
    assert.equal(lastTwo[1].stream_options, undefined);

    const events = sseEvents(ok.raw);
    assert.equal(events[0].type, "response.created");
    assert.equal(
      events.find((event) => event.type === "response.output_item.done").item
        .content[0].text,
      "plain"
    );
    assert.equal(
      events.find((event) => event.type === "response.completed").response
        .usage.total_tokens,
      4
    );
  } finally {
    await bridge.closeResponsesBridge();
    await closeServer(upstream);
  }
});

test("bridge auto-upgrades bare gateways from /chat/completions to /v1", async (t) => {
  if (!bridge) {
    t.skip("dist-electron bridge not built yet");
    return;
  }

  const hits = [];
  const upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      hits.push(req.url);
      if (req.url === "/chat/completions") {
        // gateway serves its web UI at the bare path, with status 200
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><html>gateway ui</html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "via /v1" } }]
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  try {
    const port = await bridge.startResponsesBridge();
    const route = bridge.registerCodexChatBridgeRoute(
      `http://127.0.0.1:${upstreamPort}`
    );

    const first = await postJson(
      `http://127.0.0.1:${port}/v1/${route.routeId}/responses`,
      { model: "gpt-5.6-luna", input: "hi", stream: true }
    );
    assert.equal(first.status, 200);
    const events = sseEvents(first.raw);
    assert.equal(
      events.find((event) => event.type === "response.output_item.done").item
        .content[0].text,
      "via /v1"
    );

    const second = await postJson(
      `http://127.0.0.1:${port}/v1/${route.routeId}/responses`,
      { model: "gpt-5.6-luna", input: "again", stream: true }
    );
    assert.equal(second.status, 200);
    // fallback happened once, then the working path was remembered
    assert.deepEqual(hits, [
      "/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions"
    ]);
  } finally {
    await bridge.closeResponsesBridge();
    await closeServer(upstream);
  }
});

test("bridge reports a diagnostic snippet when the upstream body is unusable", async (t) => {
  if (!bridge) {
    t.skip("dist-electron bridge not built yet");
    return;
  }

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("this is not json at all");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  try {
    const port = await bridge.startResponsesBridge();
    // base without /v1 so the fallback also runs and fails, ending at the
    // original unusable response
    const route = bridge.registerCodexChatBridgeRoute(
      `http://127.0.0.1:${upstreamPort}`
    );
    const response = await postJson(
      `http://127.0.0.1:${port}/v1/${route.routeId}/responses`,
      { model: "m", input: "hi", stream: false }
    );
    assert.equal(response.status, 502);
    const message = response.json().error.message;
    assert.match(message, /could not parse upstream chat response/);
    assert.match(message, /this is not json at all/);
  } finally {
    await bridge.closeResponsesBridge();
    await closeServer(upstream);
  }
});

test("bridge sniffs SSE bodies mislabeled as application/json", async (t) => {
  if (!bridge) {
    t.skip("dist-electron bridge not built yet");
    return;
  }

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "sniffed" } }]
      })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  try {
    const port = await bridge.startResponsesBridge();
    const route = bridge.registerCodexChatBridgeRoute(
      `http://127.0.0.1:${upstreamPort}/v1`
    );
    const response = await postJson(
      `http://127.0.0.1:${port}/v1/${route.routeId}/responses`,
      { model: "m", input: "hi", stream: true }
    );
    assert.equal(response.status, 200);
    const events = sseEvents(response.raw);
    assert.equal(
      events.find((event) => event.type === "response.output_item.done").item
        .content[0].text,
      "sniffed"
    );
    assert.equal(
      events.at(-1).type,
      "response.completed",
      "sniffed stream still terminates with completed"
    );
  } finally {
    await bridge.closeResponsesBridge();
    await closeServer(upstream);
  }
});

test("bridge rejects unknown routes and serves healthz", async (t) => {
  if (!bridge) {
    t.skip("dist-electron bridge not built yet");
    return;
  }
  const port = await bridge.startResponsesBridge();
  try {
    const missing = await postJson(
      `http://127.0.0.1:${port}/v1/unknown123/responses`,
      {}
    );
    assert.equal(missing.status, 404);

    const health = await getJson(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(health.json(), { ok: true, routes: 0 });
  } finally {
    await bridge.closeResponsesBridge();
  }
});
