import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { buildCommand, sanitizeCliAgentEnv } from "../dist-electron/cli/adapters.js";
import { buildInitializeRequest, buildSessionNewRequest, acpSessionSetupToItems, acpModelSelectionMatches } from "../dist-electron/cli/acp.js";

// Opt in with the local standalone lib/bin.js path; no real API key is used.
for (const byok of [false, true]) test(`FreeBuddy launches local Harness and receives a streamed chat completion (BYOK=${byok})`, {
  skip: !process.env.FREEBUDDY_DSH_LOCAL_ENTRY, timeout: 45000
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "freebuddy-dsh-live-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    // Generic BYOK endpoints may not implement DeepSeek Files; exercise inline fallback.
    if (req.url.endsWith("/files")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Files API not supported" } }));
      return;
    }
    if (!body) { res.end(JSON.stringify({ data: [] })); return; }
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const delta of [{ reasoning_content: "Checking." }, { content: "FreeBuddy local OK" }]) {
      res.write(`data: ${JSON.stringify({ id: "chat-test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ id: "chat-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  let child;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const catalog = byok ? [{ id: "vendor/fast", name: "Custom Fast", contextWindow: 65536, inputModalities: ["text", "image"] }, { id: "vendor/pro", name: "Custom Pro", contextWindow: 131072 }] : undefined;
    const built = buildCommand({ adapter: "dsh-acp", binary: process.env.FREEBUDDY_DSH_LOCAL_ENTRY, cwd: root, prompt: "hello", extraArgs: byok ? ["--model", "vendor/fast"] : [] });
    assert.equal(built.args.includes("--config"), false);
    child = spawn(built.bin, built.args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: {
      ...sanitizeCliAgentEnv(process.env), ...built.env,
      DSH_HOME: path.join(root, "home"), DSH_SESSIONS_ROOT: path.join(root, "sessions"),
      DEEPSEEK_API_KEY: "local-test-only", DEEPSEEK_PROTOCOL: "chat-completions",
      DEEPSEEK_MODELS_JSON: catalog ? JSON.stringify(catalog) : "",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`, DSH_TELEMETRY_DISABLED: "1"
    } });
    const exited = once(child, "exit");
    const messages = [];
    let buffer = "", stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
    });
    async function request(message) {
      child.stdin.write(JSON.stringify(message) + "\n");
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const response = messages.find((m) => m.id === message.id && !m.method);
        if (response) { assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result; }
        assert.equal(child.exitCode, null, stderr);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw new Error(`Timed out: ${message.method}\n${stderr}`);
    }
    const init = await request(buildInitializeRequest(1));
    assert.equal(init.agentInfo.name, "deepseek-harness-acp");
    assert.equal(init.agentCapabilities.promptCapabilities.image, true);
    const setup = await request(buildSessionNewRequest(2, root));
    const { sessionId } = setup;
    const config = acpSessionSetupToItems(sessionId, setup).find((item) => item.kind === "config-options");
    const model = config.options.find((option) => option.id === "model");
    assert.deepEqual(model.values.map((value) => JSON.parse(value.id)[1]), byok ? ["vendor/fast", "vendor/pro"] : ["deepseek-flash", "deepseek-v4-pro"]);
    if (byok) assert.equal(model.currentValue, JSON.stringify(["deepseek-official", "vendor/fast"]));
    if (byok) {
      const selected = await request({ jsonrpc: "2.0", id: 7, method: "session/set_config_option", params: { sessionId, configId: "model", value: "vendor/fast" } });
      const actual = selected.configOptions.find((option) => option.id === "model").currentValue;
      assert.equal(acpModelSelectionMatches("dsh-acp", actual, "vendor/fast"), true);
    }
    const result = await request({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hello" }] } });
    assert.equal(result.stopReason, "end_turn");
    assert.ok(result.usage.outputTokens > 0);
    const updates = messages.filter((m) => m.method === "session/update").map((m) => m.params.update);
    assert.equal(updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join(""), "FreeBuddy local OK");
    assert.equal(updates.filter((u) => u.sessionUpdate === "agent_thought_chunk").map((u) => u.content.text).join(""), "Checking.");
    assert.ok(requests.some((r) => r.url.endsWith("/chat/completions")));
    if (byok) {
      assert.equal(requests[0].body.model, "vendor/fast");
      const pngChunk = (type, bytes) => {
        const payload = Buffer.concat([Buffer.from(type), bytes]);
        const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
        size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(payload));
        return Buffer.concat([size, payload, checksum]);
      };
      const header = Buffer.alloc(13);
      header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
      const data = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))), pngChunk("IEND", Buffer.alloc(0))]).toString("base64");
      await request({ jsonrpc: "2.0", id: 8, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "Describe this image" }, { type: "image", mimeType: "image/png", data }] } });
      const image = requests.at(-1).body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((block) => block.type === "image_url");
      assert.ok(image.image_url.url.startsWith("data:image/png;base64,"));
      await request({ jsonrpc: "2.0", id: 5, method: "session/set_config_option", params: { sessionId, configId: "model", value: JSON.stringify(["deepseek-official", "vendor/pro"]) } });
      await request({ jsonrpc: "2.0", id: 6, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "again" }] } });
      assert.equal(requests.at(-1).body.model, "vendor/pro");
    }
    await request({ jsonrpc: "2.0", id: 4, method: "session/close", params: { sessionId } });
    child.stdin.end();
    assert.equal((await exited)[0], 0);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
