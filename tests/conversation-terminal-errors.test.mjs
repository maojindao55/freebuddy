import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(
  new URL("../src/store/conversationHandlers.ts", import.meta.url),
  "utf8"
);

test("terminal stream errors override an ACP zero exit code", () => {
  assert.match(
    source,
    /e\.exitCode === 0 && !hasTerminalUserFacingError\(nextItems\)/
  );
  assert.match(
    source,
    /live\.status === "done" && live\.exitCode === 0/
  );
  assert.match(source, /message: e\.message, terminal: true/);
});

test("stopping persisted passive work cancels its control session without a LiveAssistant", async () => {
  const killed = [];
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    if (name === "@/services/cli/client") return { cliClient: { kill: async id => killed.push(id) } };
    if (name === "@/services/delegation/client") return { delegationClient: { isAvailable: () => false } };
    if (name === "@/services/workflows/client") return { workflowClient: { isAvailable: () => false } };
    return {};
  } });
  let state = { live: {}, messages: { chat: [
    { id: "old", role: "assistant", taskId: "completed-prompt", status: "done" },
    { id: "old-passive", role: "assistant", taskId: "acp-idle-old", status: "done" },
    { id: "passive", role: "assistant", taskId: "acp-idle-current", status: "running" },
    { id: "same-session", role: "assistant", taskId: "acp-idle-current", status: "running" }
  ] } };
  await exports.killConversation(fn => { state = { ...state, ...fn(state) }; }, () => state, "chat");
  assert.deepEqual(killed, ["acp-idle-current"]);
  assert.deepEqual(state.messages.chat.map(m => m.status), ["done", "done", "killed", "killed"]);
});
