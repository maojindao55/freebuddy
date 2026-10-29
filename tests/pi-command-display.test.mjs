import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { acpUpdateToItems } from "../dist-electron/cli/acp.js";
import { AcpEmbeddedTerminalTracker } from "../dist-electron/cli/acpEmbeddedTerminal.js";
import { MAX_TERMINAL_OUTPUT_BYTES } from "../dist-electron/cli/acpTerminal.js";

const streamSource = fs.readFileSync(new URL("../src/components/CLI/StreamItem.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("StreamItem.tsx", streamSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["summarizeValue", "truncate", "toolActionLabel", "formatValue"]);
const source = syntax.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text))
  .map(statement => "export " + statement.getText(syntax)).join("\n");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const labels = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const translate = (key, args) => `${key}:${args?.target ?? ""}`;

test("stored Pi terminal references use the real command title instead of object coercion", () => {
  const call = { kind: "tool-call", id: "pi-tool", tool: "git status --short", toolKind: "execute", status: "completed",
    input: [{ type: "terminal", terminalId: "pi-tool" }] };
  assert.equal(labels.toolActionLabel(call, translate), "stream.exec:git status --short");
  assert.equal(labels.formatValue(call.input), "");
  assert.equal(labels.summarizeValue([{ command: "npm test" }, { command: "git status" }]), "npm test git status");
  assert.equal(labels.summarizeValue(["node", "--version"]), "node --version");
});

test("ACP terminal and text output are separate from raw command arguments", () => {
  const [call] = acpUpdateToItems({ sessionUpdate: "tool_call", toolCallId: "pi-tool", title: "git status --short", kind: "execute", status: "in_progress",
    content: [{ type: "terminal", terminalId: "pi-tool" }] });
  assert.equal(call.input, undefined);
  assert.deepEqual(call.toolOutputs, [{ kind: "terminal-embed", terminalId: "pi-tool" }]);
  assert.equal(labels.toolActionLabel(call, translate), "stream.exec:git status --short");
  const [textOutput] = acpUpdateToItems({ sessionUpdate: "tool_call", toolCallId: "text", title: "Tool", content: [
    { type: "content", content: { type: "text", text: "output" } }
  ] });
  assert.equal(textOutput.input, undefined);
  const [withInput] = acpUpdateToItems({ sessionUpdate: "tool_call", toolCallId: "real-input", rawInput: { command: "npm test" }, kind: "execute" });
  assert.deepEqual(withInput.input, { command: "npm test" });
});

const start = (toolCallId, terminalId = toolCallId) => ({ sessionUpdate: "tool_call", toolCallId, title: "git status", kind: "execute", status: "in_progress",
  content: [{ type: "terminal", terminalId }], _meta: { terminal_info: { terminal_id: terminalId, cwd: "C:/project" } } });
const delta = (id, data, phase = "in_progress", exitCode) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: phase, _meta: {
  terminal_output: { terminal_id: id, data }, ...(exitCode !== undefined ? { terminal_exit: { terminal_id: id, exit_code: exitCode, signal: null } } : {})
} });

test("embedded terminal deltas accumulate, preserve failed exit codes and stay scoped to their tools", () => {
  const tracker = new AcpEmbeddedTerminalTracker();
  tracker.consume(start("one"));
  tracker.consume(start("two"));
  assert.equal(tracker.consume(delta("one", "first\n"))[0].output, "first\n");
  assert.equal(tracker.consume(delta("two", "other\n"))[0].output, "other\n");
  const [failed] = tracker.consume(delta("one", "failure\n", "failed", 7));
  assert.equal(failed.output, "first\nfailure\n");
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.exited, true);
  assert.equal(failed.running, false);
  assert.deepEqual(tracker.consume(delta("unknown", "ignored")), []);
  assert.deepEqual(tracker.consume({ ...delta("one", "cross-tool"), toolCallId: "two" }), []);
  const [last] = tracker.consume(delta("two", "", "completed", 0));
  assert.equal(last.output, "other\n");
  assert.equal(last.exitCode, 0);
});

test("tool completion without terminal_exit keeps the exit code unknown", () => {
  for (const status of ["completed", "failed"]) {
    const tracker = new AcpEmbeddedTerminalTracker();
    tracker.consume(start("unknown-exit"));
    const [snapshot] = tracker.consume({ sessionUpdate: "tool_call_update", toolCallId: "unknown-exit", status });
    assert.equal(snapshot.exitCode, null);
    assert.equal(snapshot.exited, true);
    assert.equal(snapshot.running, false);
  }
});

test("embedded output stays bounded without splitting a UTF-8 character", () => {
  const tracker = new AcpEmbeddedTerminalTracker();
  tracker.consume(start("large"));
  const [snapshot] = tracker.consume(delta("large", "界".repeat(MAX_TERMINAL_OUTPUT_BYTES)));
  assert.ok(Buffer.byteLength(snapshot.output) <= MAX_TERMINAL_OUTPUT_BYTES);
  assert.equal(snapshot.truncated, true);
  assert.doesNotMatch(snapshot.output, /\uFFFD/);
});
