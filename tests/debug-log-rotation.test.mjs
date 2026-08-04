import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

async function load() {
  const sanitizeSource = fs.readFileSync(
    new URL("../electron/shared/logSanitize.ts", import.meta.url), "utf8"
  );
  const coreSource = fs.readFileSync(
    new URL("../electron/shared/debugLogCore.ts", import.meta.url), "utf8"
  );
  const combined = `${sanitizeSource}\n${coreSource.replace(
    /import \{ redactsecrets \} from "\.\/logSanitize\.js";\s*/m, ""
  )}`;
  const output = ts.transpileModule(combined, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "debuglog-test-"));
}

test("writes JSONL lines named by source and day, secrets redacted at write time", async () => {
  const { createDebugLogger } = await load();
  const dir = tmpDir();
  const utc = (d) => d.toISOString();
  const log = createDebugLogger({
    dir,
    source: "main",
    now: () => new Date("2026-07-30T10:00:00Z"),
    formatTimestamp: utc
  });
  log.info("acp", "started with sk-ant-abc123def456", { adapter: "codex" });
  const file = path.join(dir, "main-2026-07-30.log");
  const line = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(line.level, "info");
  assert.equal(line.scope, "acp");
  assert.equal(line.msg, "started with sk-ant…<redacted>");
  assert.equal(line.data.adapter, "codex");
  assert.equal(line.ts, "2026-07-30T10:00:00.000Z");
});

test("rotates a full file to .1 then shifts .1 to .2", async () => {
  const { createDebugLogger } = await load();
  const dir = tmpDir();
  const now = () => new Date("2026-07-30T10:00:00Z");
  const utc = (d) => d.toISOString();
  const log = createDebugLogger({ dir, source: "main", maxFileBytes: 120, now, formatTimestamp: utc });
  for (let i = 0; i < 12; i += 1) log.info("s", `line-${i}-padding-padding-padding`);
  assert.ok(fs.existsSync(path.join(dir, "main-2026-07-30.log")));
  assert.ok(fs.existsSync(path.join(dir, "main-2026-07-30.log.1")));
  assert.ok(fs.existsSync(path.join(dir, "main-2026-07-30.log.2")));
});

test("disk failures drop lines and count them instead of throwing", async () => {
  const { createDebugLogger } = await load();
  // A path nested under a regular file cannot be created on any platform,
  // unlike "/nonexistent/..." which mkdirSync can create on Windows drives.
  const blocker = path.join(tmpDir(), "blocker-file");
  fs.writeFileSync(blocker, "x");
  const log = createDebugLogger({ dir: path.join(blocker, "nested"), source: "main" });
  log.info("s", "dropped");
  assert.equal(log.droppedLines, 1);
});

test("pruneOldLogs removes files older than retention, keeps recent ones", async () => {
  const { pruneOldLogs } = await load();
  const dir = tmpDir();
  const old = path.join(dir, "abc.jsonl");
  const recent = path.join(dir, "def.jsonl");
  fs.writeFileSync(old, "x");
  fs.writeFileSync(recent, "x");
  const now = new Date("2026-07-30T00:00:00Z");
  const oldTime = new Date("2026-07-20T00:00:00Z");
  fs.utimesSync(old, oldTime, oldTime);
  const removed = pruneOldLogs(dir, 7, now);
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(recent));
});

test("createDebugLogger prunes its own directory on creation", async () => {
  const { createDebugLogger } = await load();
  const dir = tmpDir();
  const old = path.join(dir, "main-2026-07-01.log");
  fs.writeFileSync(old, "x");
  const oldTime = new Date("2026-07-01T00:00:00Z");
  fs.utimesSync(old, oldTime, oldTime);
  createDebugLogger({ dir, source: "main", now: () => new Date("2026-07-30T00:00:00Z") });
  assert.ok(!fs.existsSync(old));
});
