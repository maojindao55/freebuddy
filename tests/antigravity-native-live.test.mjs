import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommand } from "../dist-electron/cli/adapters.js";
import { buildInitializeRequest, acpUpdateToItems } from "../dist-electron/cli/acp.js";

// Opt in: uses an already signed-in local CLI and makes two small model turns.
test("native Antigravity executes client MCP, streams real diffs, reloads and reconnects", {
  skip: process.env.FREEBUDDY_TEST_AGY_NATIVE !== "1", timeout: 180_000
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-agy-live-")));
  const audit = path.join(root, "mcp-calls.jsonl");
  const mcpServers = [{ name: "freebuddy-eval", command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/antigravity-echo-mcp.mjs", import.meta.url)), audit], env: [] }];
  const items = [];
  let successful = false;
  const children = [];
  const timers = new Set();
  const connect = async () => {
    const built = buildCommand({ adapter: "agy-acp", binary: process.env.FREEBUDDY_TEST_AGY_BINARY || "agy", prompt: "",
      extraArgs: ["--disable-telemetry", "--log-file", path.join(root, `acp-${children.length}.log`)] });
    const child = spawn(built.bin, built.args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let buffer = "", nextId = 0;
    const pending = new Map();
    const rejectPending = error => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } pending.clear(); };
    child.on("error", rejectPending);
    child.on("close", code => rejectPending(new Error(`Antigravity exited: ${code}`)));
    child.stderr.resume();
    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (waiter && !message.method) {
          clearTimeout(waiter.timer); timers.delete(waiter.timer); pending.delete(message.id);
          if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
        } else if (message.method === "session/update") {
          items.push(...acpUpdateToItems(message.params.update, message.params.sessionId, "agy-acp", { legacyAgyBridge: false }));
        } else if (message.id != null) {
          const allow = message.params?.options?.find(option => option.kind === "allow_once");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
            ...(message.method === "session/request_permission" && allow
              ? { result: { outcome: { outcome: "selected", optionId: allow.optionId } } }
              : { error: { code: -32601, message: "Unsupported live-test request" } }) }) + "\n");
        }
      }
    });
    await once(child, "spawn");
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 75_000);
      timers.add(timer); pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const initialized = await request("initialize", buildInitializeRequest(1).params);
    assert.equal(initialized.protocolVersion, 1);
    assert.equal(initialized.agentInfo.name, "Antigravity ACP Server");
    assert.equal(initialized.agentCapabilities.mcpCapabilities.http, true);
    return { child, request };
  };
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const child of children) {
      if (child.exitCode != null || child.signalCode != null) continue;
      const closed = once(child, "close");
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
      await closed; clearTimeout(timer);
    }
    if (successful) fs.rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Live test artifacts: ${root}`);
  });
  const first = await connect();
  const session = await first.request("session/new", { cwd: root, mcpServers });
  const model = process.env.FREEBUDDY_TEST_AGY_MODEL || "claude-sonnet-4-6";
  const selected = await first.request("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: model });
  if (selected.configOptions?.some(option => option.id === "thought_level" && option.options?.some(value => value.value === "low"))) {
    await first.request("session/set_config_option", { sessionId: session.sessionId, configId: "thought_level", value: "low" });
  }
  const prompt = text => first.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text }] });
  assert.equal((await prompt("This is a temporary ACP integration test. Call the MCP tool freebuddy_test_echo with value 'echo-one'. Then create probe.txt containing exactly first followed by a newline, 中文🙂 followed by a newline. Change no other files. Reply OK.")).stopReason, "end_turn");
  assert.ok(fs.existsSync(path.join(root, "probe.txt")), JSON.stringify(items.map(item => ({
    kind: item.kind, content: item.content, message: item.message, tool: item.tool, status: item.status
  }))));
  assert.equal(fs.readFileSync(path.join(root, "probe.txt"), "utf8"), "first\n中文🙂\n");
  await first.request("session/load", { sessionId: session.sessionId, cwd: root, mcpServers });
  assert.equal((await prompt("Call the MCP tool freebuddy_test_echo with value 'echo-two'. In probe.txt replace first with second on the first line; preserve the rest exactly. Change no other files. Reply OK.")).stopReason, "end_turn");
  assert.equal(fs.readFileSync(path.join(root, "probe.txt"), "utf8"), "second\n中文🙂\n");
  const calls = fs.readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line).arguments.value);
  assert.deepEqual(calls, ["echo-one", "echo-two"]);
  const edits = items.flatMap(item => item.kind === "file-edit" ? [item] : item.toolOutputs?.filter(output => output.kind === "file-edit") ?? []);
  assert.ok(edits.some(edit => /probe\.txt$/.test(edit.path) && /first/.test(edit.newText ?? edit.patch ?? "")), "missing creation diff");
  assert.ok(edits.some(edit => /probe\.txt$/.test(edit.path) && /second/.test(edit.newText ?? edit.patch ?? "")), "missing update diff");
  await first.request("session/close", { sessionId: session.sessionId });
  const closed = once(first.child, "close"); first.child.stdin.end(); await closed;
  const second = await connect();
  const resumed = await second.request("session/load", { sessionId: session.sessionId, cwd: root, mcpServers });
  assert.ok(resumed.configOptions.some(option => option.id === "model"));
  await second.request("session/close", { sessionId: session.sessionId });
  successful = true;
});
