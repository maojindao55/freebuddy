import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import ts from "typescript";
import { buildFileDiff } from "@freebuddy/cli-stream";
const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
const acp = await import("../dist-electron/cli/acp.js");
const localDiff = await import("../dist-electron/cli/acpLocalDiff.js");
const snapshots = await import("../dist-electron/cli/turnFileSnapshots.js");
const blobs = await import("../dist-electron/cli/fileEditBlobs.js");

// Opt in only: launches the installed, authenticated Qoder and uses its model.
// Desktop services are stubbed; ACP runtime, filesystem, snapshot DB and reads
// execute the actual implementation. No user project or conversation is used.
test("live Qoder ACP freezes three disjoint edits with complete historical versions", {
  skip: !process.env.FREEBUDDY_QODER_ENTRY || !process.env.FREEBUDDY_QODER_NODE || !process.env.FREEBUDDY_QODER_MODEL, timeout: 180000
}, async t => {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrate(db); setDbForTest(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-qoder-snapshots-live-"));
  const filename = path.join(root, "test.md");
  const before = "# 测试文档\n\n第一行：内容已更改。\n\n第二行：这是第二次追加的内容。\n\n新增行：这是新添加的一行。\n";
  fs.writeFileSync(filename, before);
  db.prepare(`INSERT INTO conversations(id, title, agent_id, agent_name, adapter, created_at, updated_at)
    VALUES ('live', 'live test', 'agent', 'Qoder', 'qoder-acp', '0', '0')`).run();
  db.prepare(`INSERT INTO conversation_messages(id, conversation_id, role, status, content, task_id, created_at, updated_at)
    VALUES ('live-message', 'live', 'assistant', 'done', '[]', 'live-run', '0', '0')`).run();
  const model = process.env.FREEBUDDY_QODER_MODEL;
  const child = spawn(process.env.FREEBUDDY_QODER_NODE, [process.env.FREEBUDDY_QODER_ENTRY, "--acp", "--model", model, "--tools", "Read", "Edit"], {
    cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  });
  const timers = new Set();
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    child.kill(); setDbForTest(null); db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("freebuddy-qoder-snapshots-live-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const noop = () => {};
  const events = [];
  let submitted = false;
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = (...args) => {
    const message = JSON.parse(String(args[0]));
    if (message.method === "session/prompt") {
      assert.equal(db.prepare("SELECT state FROM turn_file_capture_runs WHERE task_id = 'live-run'").get().state, "running");
      assert.equal(fs.readFileSync(filename, "utf8"), before);
      submitted = true;
    }
    return write(...args);
  };
  const services = { ...snapshots, ...blobs,
    mergeCliByokModelOption: (_agentId, _adapter, options) => options,
    getDataDir: () => root, getLanguage: () => "zh-CN", takeSavedOfficeFiles: () => [],
    createAcpTerminalManager: () => ({ dispose: noop }),
    logMain: () => ({ info: noop, warn: noop, error: noop }),
    killProcessTree: () => child.kill(), formatAcpAgentExitMessage: code => `Agent exited ${code}`
  };
  const source = fs.readFileSync(new URL("../electron/cli/acpRuntime.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const require = createRequire(import.meta.url);
  const exports = {};
  vm.runInNewContext(compiled, { exports, process, console, Buffer, clearTimeout,
    setTimeout: (...args) => { const timer = setTimeout(...args); timers.add(timer); return timer; },
    require: name => name.startsWith("node:") ? require(name) : name === "./acp.js" ? acp : name === "./acpLocalDiff.js" ? localDiff
      : new Proxy(services, { get: (obj, key) => key === "__esModule" ? true : obj[key] ?? noop })
  });
  await exports.runAcpAgent({ child, pid: child.pid, webContents: { isDestroyed: () => false },
    args: { sessionId: "live-run", conversationId: "live", agentId: "agent", adapter: "qoder-acp", cwd: root, approvalMode: "auto", configOptionOverrides: { model },
      prompt: "只操作当前目录的 test.md。先 Read 文件，再严格执行三次独立 Edit 调用：第一次仅将‘第一行：内容已更改。’替换为‘第一行：第一次修改完成（1/3）。’；第二次仅将‘第二行：这是第二次追加的内容。’替换为‘第二行：第二次修改完成（2/3）。’；第三次仅将‘新增行：这是新添加的一行。’替换为‘新增行：第三次修改完成（3/3）。’。保持标题、空行、末尾换行不变。不要 shell，不要写其他文件。完成后仅回复完成。" },
    logStream: null, running: new Map(), capturedSessions: new Map(), agentCommand: { bin: process.env.FREEBUDDY_QODER_NODE, args: [], env: {} },
    restartAgent: async () => { throw new Error("Unexpected restart"); },
    emit: event => {
      events.push(event);
      if (event.type === "done" && submitted) assert.ok(["ready", "incomplete"].includes(db.prepare("SELECT state FROM turn_file_capture_runs WHERE task_id = 'live-run'").get()?.state));
    }
  });
  assert.equal(events.some(event => event.type === "error"), false, JSON.stringify(events.filter(event => event.type === "error")));
  assert.equal(submitted, true);
  const page = blobs.listMessageFileEdits("live-message", 0, true);
  if (!page.capture.complete) console.log(JSON.stringify({ capture: page.capture, versions: db.prepare("SELECT path, before_version, after_version FROM turn_file_versions").all().map(row => ({ file: path.basename(row.path), before: JSON.parse(row.before_version).state, after: row.after_version ? JSON.parse(row.after_version).state : null })) }));
  assert.equal(page.capture.complete, true); assert.equal(page.edits.length, 1);
  const [edit] = page.edits;
  const chunk = blobs.readMessageFileEdit("live-message", edit.path, edit.turnKey);
  const content = JSON.parse(Buffer.from(chunk.data, "base64").toString("utf8"));
  assert.equal(content.oldText, before); assert.equal(content.newText, fs.readFileSync(filename, "utf8")); assert.equal(content.partial, false);
  const diff = buildFileDiff({ ...edit, ...content });
  assert.deepEqual(diff.rows.filter(row => row.kind === "delete").map(row => row.oldLine), [3, 5, 7]);
  assert.deepEqual(diff.rows.filter(row => row.kind === "add").map(row => row.newLine), [3, 5, 7]);
  const calls = new Map();
  for (const event of events) if (event.type === "items") for (const item of event.items) {
    if (item.kind !== "tool-call" || !item.id) continue;
    const previous = calls.get(item.id);
    calls.set(item.id, { id: item.id, tool: item.tool || previous?.tool, status: item.status ?? previous?.status, toolKind: item.toolKind ?? previous?.toolKind });
  }
  const completedEdits = [...calls.values()].filter(item => item.status === "completed" && item.toolKind === "edit");
  assert.ok(completedEdits.length >= 3, JSON.stringify([...calls.values()]));
  const selected = events.filter(event => event.type === "items").flatMap(event => event.items).filter(item => item.kind === "config-options")
    .flatMap(item => item.options).findLast(option => option.id === "model");
  assert.equal(selected.currentValue, model);
  const savedDb = path.join(root, "captured.db");
  await db.backup(savedDb);
  fs.writeFileSync(filename, "# Today's file is different\n");
  const reopened = new Database(savedDb, { readonly: true, fileMustExist: true });
  try {
    setDbForTest(reopened);
    const historical = blobs.readMessageFileEdit("live-message", edit.path, edit.turnKey);
    const stored = JSON.parse(Buffer.from(historical.data, "base64").toString("utf8"));
    assert.equal(stored.oldText, before);
    assert.equal(stored.newText, content.newText);
  } finally { setDbForTest(db); reopened.close(); }
  const evidence = { agent: "Qoder", modelId: model, modelName: selected.values.find(value => value.id === model)?.name,
    files: page.edits.length, lines: [3, 5, 7], complete: true, independentEdits: completedEdits.length,
    source: content.source, historicalAfterReopen: true, before: content.oldText, after: content.newText };
  if (process.env.FREEBUDDY_QODER_EVIDENCE) fs.writeFileSync(process.env.FREEBUDDY_QODER_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ ...evidence, before: undefined, after: undefined }));
});
