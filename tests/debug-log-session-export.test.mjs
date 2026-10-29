import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import * as core from "../dist-electron/shared/debugLogExportCore.js";
import * as sanitize from "../dist-electron/shared/logSanitize.js";

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL("../electron/debugLogExport.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source + "\nexport { readSessionLogFiles };", {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;

test("full conversation export retains a large run's prompt and end, with secrets still redacted", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-export-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = (type, content) => JSON.stringify({ ts: "2026-10-29T08:31:14+08:00", type, content }) + "\n";
  const start = log("system", "start run=long-run");
  const prompt = log("stdin", JSON.stringify({ method: "session/prompt", params: { prompt: [{ type: "text", text: "continue the review" }] } }));
  const body = log("stdout", "x".repeat(63_000)).repeat(36);
  const end = log("system", "prompt complete; finalizing ACP turn");
  fs.writeFileSync(path.join(dir, "long-run.jsonl"), start + prompt + body + log("system", "Authorization: Bearer sk-test-secret-token-1234567890") + end);
  fs.writeFileSync(path.join(dir, "other-conversation.jsonl"), log("system", "unrelated conversation"));
  const exports = {};
  vm.runInNewContext(compiled, { exports, Buffer, process, console, require(name) {
    if (name.startsWith("node:")) return require(name);
    if (name === "./cli/db.js") return { getLogDir: () => dir, getDb: () => ({ prepare: () => ({ all: () => [{ task_id: "long-run", tool_session_id: "pi-session" }] }) }) };
    if (name === "./shared/debugLogExportCore.js") return core;
    if (name === "./shared/logSanitize.js") return sanitize;
    if (name === "./shared/debugLogCore.js") return { LOG_RETENTION_DAYS: 7 };
    return {};
  } });
  const full = exports.readSessionLogFiles("full", [], "conversation");
  assert.equal(full.length, 1);
  const content = full[0].lines.join("\n");
  assert.match(content, /start run=long-run/);
  assert.match(content, /continue the review/);
  assert.match(content, /prompt complete/);
  assert.doesNotMatch(content, /truncated to last|unrelated conversation|sk-test-secret-token/);
  const standard = exports.readSessionLogFiles("standard", [], "conversation");
  assert.match(standard[0].lines[0], /truncated to last 2MB/);
});
