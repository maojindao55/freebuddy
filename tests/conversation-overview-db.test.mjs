import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { bindingAvailable = false; }

const time = (second) => `2026-10-05T00:00:${String(second).padStart(2, "0")}.000Z`;

async function fixture(t) {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable; run with the Electron test runner");
    return;
  }
  const db = new Database(":memory:");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  t.after(() => { setDbForTest(null); db.close(); });
  const { listConversationOverviews } = await import("../dist-electron/cli/conversationOverview.js");
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");
  const runtime = await import("../dist-electron/cli/runtimeShared.js");
  const conversation = (id, owner = "alice", archived = 0) => db.prepare(`INSERT INTO conversations
    (id,title,agent_id,agent_name,adapter,owner_id,archived,created_at,updated_at)
    VALUES (?,?,'agent','Agent','codex',?,?,?,?)`).run(id, id, owner, archived, time(0), time(0));
  const message = (id, conversationId, role, second, options = {}) => db.prepare(`INSERT INTO conversation_messages
    (id,conversation_id,role,status,content,task_id,workflow_run_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, conversationId, role, options.status ?? "done",
      typeof options.content === "string" ? options.content : JSON.stringify(options.content ?? []),
      options.taskId ?? null, options.runId ?? null, time(second), time(second));
  const task = (id, status, second, owner = "alice", error = null) => db.prepare(`INSERT INTO cli_tasks
    (id,agent_id,agent_name,adapter,status,prompt,session_id,owner_id,error_message,created_at,updated_at)
    VALUES (?,'agent','Agent','codex',?,'prompt',?,?,?,?,?)`).run(id, status, id, owner, error, time(second), time(second));
  const run = (id, conversationId, status, second, kind = "workflow") => db.prepare(`INSERT INTO workflow_runs
    (id,conversation_id,name,goal,status,plan_json,kind,created_at,updated_at)
    VALUES (?,?,'Team','goal',?,'{}',?,?,?)`).run(id, conversationId, status, kind, time(second), time(second));
  const overview = (id) => runAsCaller("alice", () => listConversationOverviews([id]))[0];
  return { db, conversation, message, task, run, overview, listConversationOverviews, runAsCaller, runtime };
}

test("batch overviews scope conversations and task associations before returning content", async (t) => {
  const f = await fixture(t); if (!f) return;
  f.conversation("alice"); f.conversation("bob", "bob"); f.conversation("archived", "alice", 1);
  f.task("bob-task", "failed", 1, "bob", "PRIVATE BOB ERROR");
  f.message("alice-linked", "alice", "assistant", 2, { taskId: "bob-task" });
  f.message("private", "bob", "assistant", 2, { content: [{ kind: "text", role: "assistant", content: "PRIVATE BOB MESSAGE" }] });
  const list = f.runAsCaller("alice", () => f.listConversationOverviews(["bob", "alice", "alice", "archived", "missing"]));
  assert.deepEqual(list.map((entry) => entry.conversationId), ["alice"]);
  assert.equal(list[0].taskId, undefined);
  assert.ok(!JSON.stringify(list).includes("PRIVATE BOB"));
  assert.deepEqual(f.runAsCaller("owner", () => f.listConversationOverviews(["bob", "alice"]), true)
    .map((entry) => entry.conversationId), ["bob", "alice"]);
  assert.deepEqual(f.listConversationOverviews(null), []);
});

test("new user turns and attempts replace historical failed task status", async (t) => {
  const f = await fixture(t); if (!f) return;
  f.conversation("retry");
  f.message("u1", "retry", "user", 1);
  f.task("attempt1", "failed", 2, "alice", "old failure");
  f.message("a1", "retry", "assistant", 2, { taskId: "attempt1", status: "failed",
    content: [{ kind: "error", message: "old failure" }] });
  assert.equal(f.overview("retry").status, "failed");
  f.message("u2", "retry", "user", 3);
  assert.equal(f.overview("retry").status, "idle");
  assert.deepEqual(f.overview("retry").activities, []);
  assert.equal(f.overview("retry").error, undefined);
  f.message("a2", "retry", "assistant", 4, { status: "starting" });
  assert.equal(f.overview("retry").status, "starting");
  f.task("attempt2", "running", 4);
  f.db.prepare("UPDATE conversation_messages SET task_id = ? WHERE id = ?").run("attempt2", "a2");
  assert.equal(f.overview("retry").status, "running");
  f.db.prepare("UPDATE cli_tasks SET status = 'done', updated_at = ? WHERE id = ?").run(time(5), "attempt2");
  assert.equal(f.overview("retry").status, "completed");
  // A failed startup can create a fresh assistant row before it has a task ID.
  f.message("a3", "retry", "assistant", 6, { status: "failed", content: [{ kind: "error", message: "startup failed" }] });
  assert.equal(f.overview("retry").status, "failed");
  assert.equal(f.overview("retry").error, "startup failed");
});

test("permission and authentication counts reflect live requests without consuming them", async (t) => {
  const f = await fixture(t); if (!f) return;
  f.conversation("inputs"); f.task("input-task", "running", 1);
  f.message("input-message", "inputs", "assistant", 1, { taskId: "input-task", status: "running" });
  const resolver = () => {};
  f.runtime.registerPermissionResolver("input-task", "permission-1", resolver);
  f.runtime.registerAuthenticationResolver("input-task", "auth-1", resolver);
  assert.equal(f.overview("inputs").status, "needs-input");
  assert.equal(f.overview("inputs").attentionCount, 2);
  assert.equal(f.runtime.takePermissionResolver("input-task", "permission-1"), resolver);
  assert.equal(f.overview("inputs").attentionCount, 1);
  assert.equal(f.runtime.takeAuthenticationResolver("input-task", "auth-1"), resolver);
  assert.equal(f.overview("inputs").status, "running");
  f.runtime.setAuthenticationTerminalPending("input-task", "terminal-1", true);
  assert.equal(f.overview("inputs").status, "needs-input");
  f.runtime.setAuthenticationTerminalPending("input-task", "terminal-1", false);
  assert.equal(f.overview("inputs").status, "running");
});

test("a recovered failed message does not resurrect an abandoned running task", async (t) => {
  const f = await fixture(t); if (!f) return;
  f.conversation("recovery"); f.task("abandoned", "running", 1);
  f.message("recovered-message", "recovery", "assistant", 2, {
    taskId: "abandoned", status: "failed", content: [
      { kind: "command", command: "unfinished-command" },
      { kind: "error", message: "Interrupted before completion" }
    ]
  });
  const overview = f.overview("recovery");
  assert.equal(overview.status, "failed");
  assert.equal(overview.activities[0].status, "failed");
  assert.equal(overview.error, "Interrupted before completion");
});

test("structured activities merge tool updates and exclude reasoning, usage and stdout", async (t) => {
  const f = await fixture(t); if (!f) return;
  f.conversation("activities"); f.task("activities-task", "done", 1);
  f.message("activity-message", "activities", "assistant", 1, { taskId: "activities-task", content: [
    { kind: "tool-call", id: "read-1", tool: "read_file", toolKind: "read", status: "running", locations: [{ path: "/repo/app.ts" }] },
    { kind: "thinking", content: "PRIVATE REASONING" },
    { kind: "tool-call", id: "thought", tool: "think", toolKind: "think" },
    { kind: "command-output", content: "PRIVATE STDOUT" },
    { kind: "usage", inputTokens: 12345 },
    { kind: "tool-call", id: "read-1", tool: "read_file", status: "completed" },
    { kind: "tool-call", id: "exec-1", tool: "exec_command", toolKind: "execute", input: { cmd: "npm test" }, status: "running" },
    { kind: "tool-result", id: "exec-1", tool: "exec_command", content: "PRIVATE TOOL OUTPUT" },
    { kind: "file-edit", path: "/repo/app.ts", action: "update", status: "completed", patch: "PRIVATE PATCH" },
    { kind: "config-options", options: [{ id: "model", category: "model", currentValue: "gpt-6" }] },
    { kind: "text", role: "assistant", content: "The tests passed." }
  ] });
  const overview = f.overview("activities");
  assert.equal(overview.activities.length, 3);
  assert.deepEqual(overview.activities.map((entry) => [entry.target, entry.status]), [
    ["/repo/app.ts", "completed"], ["npm test", "completed"], ["/repo/app.ts", "completed"]
  ]);
  assert.equal(overview.activities[0].toolKind, "read");
  assert.equal(overview.activities[0].messageId, "activity-message");
  assert.equal(overview.activities[0].toolCallId, "read-1");
  assert.equal(overview.model, "gpt-6");
  assert.equal(overview.summary, "The tests passed.");
  assert.ok(!JSON.stringify(overview).includes("PRIVATE"));
});

test("completed streamed summaries preserve code fences and prose chunk separators", async (t) => {
  const f = await fixture(t); if (!f) return;
  f.conversation("diagram-summary"); f.task("diagram-task", "done", 1);
  const content = [
    { kind: "text", role: "assistant", content: "时序图如下：\n```mermaid\nsequenceDiagram\n" },
    { kind: "text", role: "assistant", content: "participant Controller\nController->>Model: request\n".repeat(30), append: true },
    { kind: "text", role: "assistant", content: "```", append: true }
  ];
  f.message("diagram-message", "diagram-summary", "assistant", 1, { taskId: "diagram-task", content });
  const overview = f.overview("diagram-summary");
  assert.equal(overview.status, "completed");
  assert.ok(overview.summary.startsWith(content[0].content));
  assert.equal(overview.summary.length, 420);
  const fs = await import("node:fs/promises");
  const ts = (await import("typescript")).default;
  const source = await fs.readFile(new URL("../src/components/CLI/conversationPanelData.ts", import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { formatPanelSummary } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  assert.equal(formatPanelSummary(overview.summary, (key) => key), "conversationPanel.codeResult");
  assert.deepEqual(JSON.parse(f.db.prepare("SELECT content FROM conversation_messages WHERE id = ?").get("diagram-message").content), content);

  f.conversation("prose-summary");
  f.message("prose-message", "prose-summary", "assistant", 1, { content: [
    { kind: "text", role: "assistant", content: "The tests" },
    { kind: "text", role: "assistant", content: " passed.\nNext step is ready.", append: true }
  ] });
  assert.equal(f.overview("prose-summary").summary, "The tests passed.\nNext step is ready.");
  f.db.prepare("UPDATE conversation_messages SET content = ? WHERE id = ?").run(JSON.stringify([
    { kind: "text", role: "assistant", content: "I will inspect the configuration. " },
    { kind: "text", role: "assistant", content: "Checked one setting. ".repeat(60), append: true },
    { kind: "text", role: "assistant", content: "\nCompleted. All tests passed.", append: true }
  ]), "prose-message");
  const latest = f.overview("prose-summary").summary;
  assert.ok(latest.endsWith("\nCompleted. All tests passed."));
  assert.ok(!latest.includes("I will inspect"));
  assert.equal(latest.length, 420);
});

test("workflow and delegation state is authoritative over child task failures and expires on a fresh turn", async (t) => {
  const f = await fixture(t); if (!f) return;
  f.conversation("team"); f.message("team-user", "team", "user", 1);
  f.run("team-run", "team", "running", 2, "delegation");
  // Historical delegation messages have real del-<runId>-… task IDs but no
  // workflow_run_id. A failed child still must not override the team run.
  f.task("del-team-run-child-turn", "failed", 3, "alice", "child failure");
  f.message("child-message", "team", "assistant", 3, { taskId: "del-team-run-child-turn", status: "failed" });
  assert.equal(f.overview("team").status, "running");
  f.db.prepare("UPDATE workflow_runs SET status = 'blocked', updated_at = ? WHERE id = ?").run(time(4), "team-run");
  assert.equal(f.overview("team").status, "needs-input");
  assert.equal(f.overview("team").runId, "team-run");
  f.db.prepare("UPDATE workflow_runs SET status = 'paused' WHERE id = ?").run("team-run");
  assert.equal(f.overview("team").status, "paused");
  f.db.prepare("UPDATE workflow_runs SET status = 'completed', updated_at = ? WHERE id = ?").run(time(5), "team-run");
  assert.equal(f.overview("team").status, "completed");
  assert.equal(f.overview("team").error, undefined);
  f.message("team-next-user", "team", "user", 6);
  assert.equal(f.overview("team").status, "idle");
  f.run("workflow-next", "team", "pending_approval", 7);
  assert.equal(f.overview("team").status, "needs-input");
});

test("overview bodies and activities are bounded and cache invalidation uses actual content", async (t) => {
  const f = await fixture(t); if (!f) return;
  f.conversation("bounds"); f.message("bounds-user", "bounds", "user", 1);
  f.task("bounds-task", "done", 2);
  const items = Array.from({ length: 20 }, (_, index) => ({ kind: "command", command: `cmd-${index}` }));
  f.message("bounds-message", "bounds", "assistant", 2, { taskId: "bounds-task", content: items });
  assert.deepEqual(f.overview("bounds").activities.map((entry) => entry.target),
    ["cmd-14", "cmd-15", "cmd-16", "cmd-17", "cmd-18", "cmd-19"]);
  // Same ID + updatedAt + byte length can still hold a newer stream snapshot.
  f.db.prepare("UPDATE conversation_messages SET content = ? WHERE id = ?").run(
    JSON.stringify([{ kind: "command", command: "new-evidence" }]), "bounds-message");
  assert.equal(f.overview("bounds").activities[0].target, "new-evidence");
  f.db.prepare("UPDATE conversation_messages SET content = ? WHERE id = ?").run(
    JSON.stringify([{ kind: "text", role: "assistant", content: "x".repeat(200_000) }]), "bounds-message");
  const overview = f.overview("bounds");
  assert.equal(overview.status, "completed");
  assert.equal(overview.summary, undefined);
  assert.deepEqual(overview.activities, []);
  assert.ok(JSON.stringify(overview).length < 1000);
  for (let index = 0; index < 101; index += 1) f.conversation(`batch-${index}`);
  assert.equal(f.listConversationOverviews(Array.from({ length: 101 }, (_, index) => `batch-${index}`)).length, 100);
});

test("a team surfaces input requests from an older running teammate, not only its newest message", async (t) => {
  const f = await fixture(t); if (!f) return;
  f.conversation("parallel"); f.run("parallel-run", "parallel", "running", 1, "delegation");
  f.task("del-parallel-run-older-turn", "running", 2);
  f.message("older-child", "parallel", "assistant", 2, { taskId: "del-parallel-run-older-turn", status: "running" });
  f.task("del-parallel-run-newer-turn", "running", 3);
  f.message("newer-child", "parallel", "assistant", 3, { taskId: "del-parallel-run-newer-turn", status: "running" });
  f.runtime.registerPermissionResolver("del-parallel-run-older-turn", "older-input", () => {});
  assert.equal(f.overview("parallel").status, "needs-input");
  assert.equal(f.overview("parallel").attentionCount, 1);
  f.runtime.takePermissionResolver("del-parallel-run-older-turn", "older-input");
  assert.equal(f.overview("parallel").status, "running");
});
