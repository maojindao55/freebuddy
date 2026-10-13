import "./electron-stub.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

// Use a killable process so a regression in FIFO handling cannot hang the suite.
const [root, phase] = process.argv.slice(2);
assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
assert.ok(path.basename(root).startsWith("freebuddy-file-versions-"));
assert.ok(["before", "after", "ignore"].includes(phase));
const { migrate, setDbForTest } = await import("../../dist-electron/cli/db.js");
const { prepareTurnFileCapture, finalizeTurnFileCapture } = await import("../../dist-electron/cli/turnFileSnapshots.js");
const db = new Database(":memory:");
db.pragma("foreign_keys = ON"); migrate(db); setDbForTest(db);
db.prepare(`INSERT INTO conversations(id, title, agent_id, agent_name, adapter, created_at, updated_at)
  VALUES ('test', 'test', 'agent', 'Agent', 'qoder-acp', '0', '0')`).run();
try {
  const filename = path.join(root, phase === "ignore" ? ".gitignore" : "tracked.md");
  fs.writeFileSync(filename, "before\n");
  if (phase !== "ignore") {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "tracked.md"], { cwd: root });
  }
  const prepare = () => prepareTurnFileCapture({ conversationId: "test", taskId: "run", roots: [root], limits: { milliseconds: 1000 } });
  let capture;
  if (phase === "after") capture = await prepare();
  fs.unlinkSync(filename); execFileSync("mkfifo", [filename]);
  capture ??= await prepare();
  await finalizeTurnFileCapture(capture);
  const run = db.prepare("SELECT state, complete FROM turn_file_capture_runs WHERE task_id = 'run'").get();
  console.log(JSON.stringify({ state: run.state, complete: !!run.complete }));
} finally { setDbForTest(null); db.close(); }
