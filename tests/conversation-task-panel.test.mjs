import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/components/CLI/conversationPanelData.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const helpers = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

const snapshot = (status) => ({ conversationId: "a", status, updatedAt: "2026-10-05T03:00:00Z", activities: [] });
const conversation = (id, updatedAt) => ({ id, updatedAt, createdAt: updatedAt });

test("current requests outrank running signals and a fresh run outranks a historical failure", () => {
  const { selectConversationPanelStatus: status } = helpers;
  assert.equal(status(snapshot("running"), { attentionCount: 1, live: { status: "running" } }), "needs-input");
  assert.equal(status(snapshot("failed"), { live: { status: "starting" } }), "starting");
  assert.equal(status(snapshot("completed"), { live: { status: "failed" } }), "completed");
  assert.equal(status(undefined, { live: { status: "done" } }), "unknown");
  assert.equal(status(undefined, { workflowStatus: "pending_approval" }), "needs-input");
  assert.equal(status(undefined, { workflowStatus: "blocked" }), "waiting");
  assert.equal(status(snapshot("paused"), { workflowStatus: "running" }), "paused");
  assert.equal(status(snapshot("running"), { workflowStatus: "paused" }), "running");
});

test("live activity coalesces one invocation without showing thinking or terminal output", () => {
  const result = helpers.livePanelActivity([
    { kind: "thinking", content: "private intermediate analysis" },
    { kind: "tool-call", id: "read-1", tool: "read_file", toolKind: "read", status: "running", locations: [{ path: "src/App.tsx" }] },
    { kind: "tool-call", id: "read-1", tool: "read_file", toolKind: "read", status: "completed" },
    { kind: "tool-result", id: "read-1", tool: "read_file", content: "a large output" },
    { kind: "command-output", content: "lots of stdout" },
    { kind: "text", role: "assistant", content: "Finished checking the layout." }
  ], "message-1");
  assert.equal(result.activities.length, 1);
  assert.equal(result.activities[0].status, "completed");
  assert.equal(result.activities[0].filePath, "src/App.tsx");
  assert.equal(result.activities[0].target, "src/App.tsx");
  assert.equal(result.activities[0].toolKind, "read");
  assert.equal(result.activities[0].messageId, "message-1");
  assert.equal(result.summary, "Finished checking the layout.");
});

test("chat-only replies stay summaries and activities remain bounded", () => {
  const result = helpers.livePanelActivity([
    { kind: "text", role: "assistant", content: "The two approaches " },
    { kind: "text", role: "assistant", content: "have different tradeoffs.", append: true },
    { kind: "config-options", options: [{ id: "model", category: "model", currentValue: "actual-model" }] }
  ], "reply");
  assert.deepEqual(result.activities, []);
  assert.equal(result.summary, "The two approaches have different tradeoffs.");
  assert.equal(result.model, "actual-model");
  const many = helpers.livePanelActivity(Array.from({ length: 12 }, (_, index) => ({ kind: "file-edit", path: `file-${index}.ts`, action: "update" })), "reply");
  assert.equal(many.activities.length, 6);
  assert.equal(many.activities[0].target, "file-6.ts");
});

test("a retry never displays the previous attempt's reply and activities", () => {
  const previous = { ...snapshot("failed"), taskId: "old-task", summary: "Previous failure", activities: [{ id: "old", messageId: "old-message" }] };
  assert.equal(helpers.currentConversationPanelSnapshot(previous, { status: "starting", taskSessionId: "new-task" }), undefined);
  assert.equal(helpers.currentConversationPanelSnapshot(previous, { status: "running", taskSessionId: "old-task" }), previous);
  assert.equal(helpers.currentConversationPanelSnapshot(previous, { status: "done", taskSessionId: "new-task" }), previous);
});

test("input paths and real edit output supply file navigation evidence", () => {
  const input = helpers.livePanelActivity([{ kind: "tool-call", id: "edit", tool: "edit_file", toolKind: "edit", input: { file_path: "src/changed.ts" } }], "reply");
  assert.equal(input.activities[0].filePath, "src/changed.ts");
  const output = helpers.livePanelActivity([{ kind: "tool-call", id: "edit", tool: "edit_file", toolOutputs: [{ kind: "file-edit", path: "src/output.ts", action: "update" }] }], "reply");
  assert.equal(output.activities[0].filePath, "src/output.ts");
});

test("activity updates keep existing cards stable and remove archived cards", () => {
  const { stableConversationOrder: order } = helpers;
  const initial = order([], [conversation("a", "2026-10-05T01:00:00Z"), conversation("b", "2026-10-05T02:00:00Z")]);
  assert.deepEqual(initial, ["b", "a"]);
  assert.deepEqual(order(initial, [conversation("a", "2026-10-05T04:00:00Z"), conversation("b", "2026-10-05T02:00:00Z")]), ["b", "a"]);
  assert.deepEqual(order(initial, [conversation("a", "2026-10-05T04:00:00Z"), conversation("c", "2026-10-05T03:00:00Z")]), ["c", "a"]);
});

test("activity labels use renderer translations, and timestamps never invent future activity", () => {
  const translate = (key, args) => `${key}:${args.target}`;
  assert.equal(helpers.formatPanelActivity({ toolKind: "read", target: "src/App.tsx" }, translate), "stream.read:src/App.tsx");
  assert.equal(helpers.formatPanelActivity({ toolKind: "search", target: "signing  error" }, translate), "conversationPanel.activity.search:signing error");
  assert.equal(helpers.panelRelativeTime("invalid", "en"), "");
  assert.equal(helpers.panelRelativeTime("2026-10-05T03:05:00Z", "en", Date.parse("2026-10-05T03:00:00Z")), "now");
  assert.equal(helpers.panelRelativeTime("2026-10-05T02:58:00Z", "en", Date.parse("2026-10-05T03:00:00Z")), "2 minutes ago");
});

const activity = (target, overrides = {}) => ({ id: target, messageId: "source-message", kind: "tool-call", toolKind: "other", status: "completed", target, ...overrides });
const labelKey = (key, args) => args?.target ? `${key}:${args.target}` : key;

test("panel file labels shorten Unix and Windows project paths without changing navigation evidence", () => {
  const unix = activity("/Users/person/project/src/App.tsx", { toolKind: "edit", filePath: "/Users/person/project/src/App.tsx" });
  assert.equal(helpers.formatPanelActivity(unix, labelKey, "/Users/person/project"), "stream.edit:src/App.tsx");
  assert.equal(unix.filePath, "/Users/person/project/src/App.tsx");
  const windows = activity("C:\\Users\\Person\\Project\\src\\App.tsx", { toolKind: "read", filePath: "C:\\Users\\Person\\Project\\src\\App.tsx" });
  assert.equal(helpers.formatPanelActivity(windows, labelKey, "c:\\users\\person\\project"), "stream.read:src/App.tsx");
  assert.equal(helpers.formatPanelActivity(activity("/etc/freebuddy/config.json", { toolKind: "read" }), labelKey), "stream.read:freebuddy/config.json");
  assert.equal(helpers.formatPanelActivity(activity("/Users/person/project/src", { toolKind: "search" }), labelKey, "/Users/person/project"), "conversationPanel.activity.search:src");
  assert.equal(helpers.formatPanelActivity(activity("read_file", { toolKind: "read" }), labelKey), "conversationPanel.activity.readFile");
});

test("panel commands show accurate short actions rather than cwd, arguments or script bodies", () => {
  const command = (value, cwd) => helpers.formatPanelActivity(activity(value, { kind: "command", toolKind: "execute" }), labelKey, cwd);
  assert.equal(command("cd /Users/person/project && head -40 handbook.md"), "stream.read:handbook.md");
  assert.equal(command('cd /d "C:\\Users\\Person\\Project" && npm.cmd run build:renderer'), "conversationPanel.activity.build");
  assert.equal(command("cd /preview/freebuddy && python3 - <<'PY'\nprint('private code')\nPY"), "conversationPanel.activity.runScript");
  assert.equal(command("cd /preview/freebuddy && printf '\\n' >> handbook.md"), "conversationPanel.activity.runCommand");
  assert.equal(command("grep -n handbook handbook.md"), "conversationPanel.activity.searchCode");
  assert.equal(command("CI=1 npm test -- --runInBand"), "conversationPanel.activity.runTests");
  assert.equal(command("pnpm run typecheck"), "conversationPanel.activity.typecheck");
  assert.equal(command("git diff -- src/App.tsx"), "conversationPanel.activity.inspectChanges");
  assert.equal(command("unknown-executable --token secret"), "conversationPanel.activity.runCommand");
  assert.equal(helpers.formatPanelActivity(activity("https://example.com/report?private=1", { toolKind: "fetch" }), labelKey), "conversationPanel.activity.fetch:example.com");
});

test("known collaboration tools have useful labels and unknown tool names stay out of previews", () => {
  const actions = {
    mcp_freebuddy_skills_skill_list: "listSkills",
    mcp__freebuddy__skills_skill_load: "loadSkill",
    mcp_freebuddy_delegate_list_teammates: "listTeammates",
    mcp_freebuddy_delegate_delegate: "delegateTask",
    mcp_freebuddy_delegate_yield_to_delegates: "waitDelegates"
  };
  for (const [name, action] of Object.entries(actions)) assert.equal(helpers.formatPanelActivity(activity(name), labelKey), `conversationPanel.activity.${action}`);
  assert.equal(helpers.formatPanelActivity(activity("mcp_unfamiliar_service_secret_internal_tool"), labelKey), "conversationPanel.activity.callTool");
  assert.equal(helpers.formatPanelActivity(activity("very_long_internal_tool_identifier"), labelKey), "conversationPanel.activity.callTool");
  assert.equal(helpers.formatPanelActivity(activity("Error: /Users/person/hidden/path and stack trace", { kind: "error", status: "failed" }), labelKey), "conversationPanel.activity.error");
});

test("existing short human descriptions remain useful without exposing commands, tool names or code", () => {
  assert.equal(helpers.formatPanelActivity(activity("检查 API 限流降级"), labelKey), "检查 API 限流降级");
  assert.equal(helpers.formatPanelActivity(activity("定位证书路径错误"), labelKey), "定位证书路径错误");
  assert.equal(helpers.formatPanelActivity(activity("Check API rate limiting"), labelKey), "Check API rate limiting");
  assert.equal(helpers.formatPanelActivity(activity("loadRelease() +48 行", { toolKind: "edit" }), labelKey), "loadRelease() +48 行");
  assert.equal(helpers.formatPanelActivity(activity("读取接口定义", { toolKind: "read" }), labelKey), "读取接口定义");
  assert.equal(helpers.formatPanelActivity(activity("生成 diff 预览"), labelKey), "生成 diff 预览");
  assert.equal(helpers.formatPanelActivity(activity("检查 /Users/person/project/src/App.tsx 布局"), labelKey, "/Users/person/project"), "检查 src/App.tsx 布局");
  assert.equal(helpers.formatPanelActivity(activity("npm run 测试"), labelKey), "conversationPanel.activity.callTool");
  assert.equal(helpers.formatPanelActivity(activity("const 信息 = { foo: 1 }"), labelKey), "conversationPanel.activity.callTool");
  assert.equal(helpers.formatPanelActivity(activity("调用 mcp_private_server_tool"), labelKey), "conversationPanel.activity.callTool");
  assert.ok(Array.from(helpers.formatPanelActivity(activity("检查界面内容".repeat(30)), labelKey)).length <= 56);
});

test("summaries keep readable prose while removing Markdown, links, images and diagram code", () => {
  const summary = helpers.formatPanelSummary("## **检查结果**\n- 已修复 _标题_，请看 [说明](https://example.com/private) 和 `App.tsx`。\n![截图](data:image/png;base64,secret)\n```mermaid\nsequenceDiagram\nparticipant A\nA->>B: request\n```\n可以继续验证。", labelKey);
  assert.equal(summary, "检查结果 已修复 标题，请看 说明 和 App.tsx。 可以继续验证。");
  assert.equal(helpers.formatPanelSummary("保留说明。 ```ts\nconst privateValue = 1", labelKey), "保留说明。");
  assert.equal(helpers.formatPanelSummary("基于同一份改造路径，时序图如下： ```mermaid sequenceDiagram participant A A->>B: request```", labelKey), "conversationPanel.codeResult");
  assert.equal(helpers.formatPanelSummary("已修复标题。时序图如下： ```mermaid sequenceDiagram A->>B: request```", labelKey), "已修复标题。");
  assert.equal(helpers.formatPanelSummary("```mermaid sequenceDiagram participant Controller````", labelKey), "conversationPanel.codeResult");
  assert.equal(helpers.formatPanelSummary("~~~python\nprint('result')", labelKey), "conversationPanel.codeResult");
  assert.equal(helpers.formatPanelSummary("sequenceDiagram\nparticipant A\nA->>B: request", labelKey), "conversationPanel.codeResult");
  assert.equal(helpers.formatPanelSummary("A release timeline is ready to discuss.", labelKey), "A release timeline is ready to discuss.");
  assert.equal(helpers.formatPanelSummary("检查失败: a < b 与 c > d", labelKey), "检查失败: a < b 与 c > d");
  assert.equal(helpers.formatPanelSummary("可以使用 classDiagram 表示关系，或选择 flowchart TD 表示流程。", labelKey), "可以使用 classDiagram 表示关系，或选择 flowchart TD 表示流程。");
  assert.equal(helpers.formatPanelSummary("classDiagram is useful for relationships.", labelKey), "classDiagram is useful for relationships.");
  assert.equal(helpers.formatPanelSummary("classDiagram 可以表达类关系。", labelKey), "classDiagram 可以表达类关系。");
  assert.equal(helpers.formatPanelSummary("flowchart TD describes the chosen layout.", labelKey), "flowchart TD describes the chosen layout.");
  assert.equal(helpers.formatPanelSummary("mermaid erDiagram 可用于数据关系。", labelKey), "mermaid erDiagram 可用于数据关系。");
  assert.equal(helpers.formatPanelSummary("推荐使用 mermaid 表达类关系。", labelKey), "推荐使用 mermaid 表达类关系。");
  assert.equal(helpers.formatPanelSummary('检查 <strong>标题</strong> 和 <a href="https://example.com">说明</a>，<br/>随后验证。', labelKey), "检查 标题 和 说明， 随后验证。");
  assert.equal(helpers.formatPanelSummary("![only image](https://example.com/screenshot.png)", labelKey), undefined);
  assert.equal(helpers.formatPanelSummary(undefined, labelKey), undefined);
  assert.equal(helpers.formatPanelSummary("   ", labelKey), undefined);
  const long = helpers.formatPanelSummary("界面🙂".repeat(100), labelKey);
  assert.equal(Array.from(long).length, 160);
  assert.ok(long.startsWith("…"));
  assert.equal(long.includes("\uFFFD"), false);
});

test("long streamed code keeps its opening fence so truncation never turns its body into prose", () => {
  const streamed = helpers.livePanelActivity([
    { kind: "text", role: "assistant", content: "时序图如下：\n```mermaid\nsequenceDiagram\n" },
    { kind: "text", role: "assistant", content: "participant Controller\nController->>Model: private internal step\n".repeat(30), append: true },
    { kind: "text", role: "assistant", content: "```", append: true }
  ], "streamed-reply");
  assert.equal(streamed.summary.length, 500);
  assert.ok(streamed.summary.startsWith("时序图如下：\n```mermaid"));
  assert.equal(helpers.formatPanelSummary(streamed.summary, labelKey), "conversationPanel.codeResult");
});

test("long streamed prose retains the actual latest result rather than the opening plan", () => {
  const streamed = helpers.livePanelActivity([
    { kind: "text", role: "assistant", content: "我会先检查配置。\n" },
    { kind: "text", role: "assistant", content: "这里是中间的检查说明。".repeat(90), append: true },
    { kind: "text", role: "assistant", content: "\n已修复证书路径，类型检查通过。", append: true }
  ], "prose-reply");
  assert.equal(streamed.summary.length, 500);
  assert.equal(streamed.summary.includes("我会先检查配置"), false);
  assert.ok(streamed.summary.endsWith("已修复证书路径，类型检查通过。"));
  const preview = helpers.formatPanelSummary(streamed.summary, labelKey);
  assert.ok(preview.startsWith("…"));
  assert.ok(preview.endsWith("已修复证书路径，类型检查通过。"));
  assert.ok(Array.from(preview).length <= 160);
});

test("activity selection prioritizes running, pending and failed sources and keeps source navigation objects", () => {
  const oldRead = activity("src/App.tsx", { id: "old-read", toolKind: "read", filePath: "src/App.tsx" });
  const running = activity("src/App.tsx", { id: "current-read", toolKind: "read", filePath: "src/App.tsx", status: "running" });
  const pending = activity("src/pending.ts", { id: "pending", toolKind: "edit", filePath: "src/pending.ts", status: "pending" });
  const failed = activity("npm test", { id: "failed", kind: "command", toolKind: "execute", status: "failed" });
  const recentCompleted = activity("src/latest.ts", { id: "done", toolKind: "read", filePath: "src/latest.ts" });
  const selected = helpers.selectPanelActivities([oldRead, running, pending, failed, recentCompleted]);
  assert.deepEqual(selected, [running, pending, failed]);
  assert.equal(selected[0], running);
  assert.equal(selected[0].filePath, "src/App.tsx");
  assert.equal(selected[0].messageId, "source-message");
  assert.equal(helpers.selectPanelActivities([oldRead, running, pending, failed], 20).length, 3);
  assert.deepEqual(helpers.selectPanelActivities([oldRead], 0), []);
});

test("activity selection merges repeated short labels and retains the most recent real invocation", () => {
  const old = activity("cd /project && python3 - <<'PY'\nprint(1)\nPY", { id: "old", kind: "command", toolKind: "execute" });
  const newest = activity("cd /project && python3 - <<'PY'\nprint(2)\nPY", { id: "new", kind: "command", toolKind: "execute", messageId: "new-source" });
  const search = activity("rg heading README.md", { id: "search", kind: "command", toolKind: "execute" });
  assert.deepEqual(helpers.selectPanelActivities([old, search, newest]), [search, newest]);
  assert.equal(helpers.selectPanelActivities([old, search, newest])[1], newest);
  const running = { ...newest, id: "running", status: "running" };
  const failed = { ...old, id: "failed", status: "failed" };
  assert.deepEqual(helpers.selectPanelActivities([failed, running, newest]), [failed, running]);
});

test("different current invocations with the same short label and status retain their own navigation", () => {
  const first = activity("python3 script-a.py", { id: "script-a", messageId: "message-a", kind: "command", toolKind: "execute", status: "running" });
  const second = activity("python3 script-b.py", { id: "script-b", messageId: "message-b", kind: "command", toolKind: "execute", status: "running" });
  const failed = activity("python3 failed.py", { id: "script-failed", messageId: "message-failed", kind: "command", toolKind: "execute", status: "failed" });
  const selected = helpers.selectPanelActivities([first, second, failed]);
  assert.deepEqual(selected, [first, second, failed]);
  assert.equal(selected[0], first);
  assert.equal(selected[1], second);
  const updatedFirst = { ...first, status: "pending" };
  assert.deepEqual(helpers.selectPanelActivities([first, updatedFirst, second]), [updatedFirst, second]);
});

async function overviewStore(client) {
  globalThis.__taskPanelOverviewClient = client;
  const storeSource = fs.readFileSync(new URL("../src/store/conversationOverviewStore.ts", import.meta.url), "utf8")
    .replace('import { create } from "zustand";', `import { create } from ${JSON.stringify(import.meta.resolve("zustand"))};`)
    .replace('import { cliClient } from "@/services/cli/client";', 'const cliClient = globalThis.__taskPanelOverviewClient;');
  const javascript = ts.transpileModule(storeSource, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  const result = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}#${Math.random()}`);
  delete globalThis.__taskPanelOverviewClient;
  return result.useConversationOverviewStore;
}

test("a message event during an overview fetch schedules a fresh follow-up", async () => {
  const calls = [];
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const store = await overviewStore({ listConversationOverviews(ids) {
    calls.push(ids);
    return calls.length === 1 ? first : Promise.resolve([{ ...snapshot("completed"), conversationId: "a" }]);
  } });
  const pending = store.getState().refresh(["a"]);
  await store.getState().refresh(["a"]);
  resolveFirst([{ ...snapshot("running"), conversationId: "a" }]);
  await pending;
  assert.deepEqual(calls, [["a"], ["a"]]);
  assert.equal(store.getState().overviews.a.status, "completed");
  assert.deepEqual(store.getState().loading, {});
});

test("overview batches cover every conversation and refresh errors preserve last-good data", async () => {
  const calls = [];
  let fail = false;
  const store = await overviewStore({ async listConversationOverviews(ids) {
    calls.push(ids);
    if (fail) throw new Error("network unavailable");
    return ids.map((conversationId) => ({ ...snapshot("idle"), conversationId }));
  } });
  const ids = Array.from({ length: 205 }, (_, index) => `id-${index}`);
  await store.getState().refresh(ids);
  assert.deepEqual(calls.map((batch) => batch.length), [100, 100, 5]);
  assert.equal(Object.keys(store.getState().overviews).length, 205);
  fail = true;
  await store.getState().refresh(["id-0"]);
  assert.equal(store.getState().overviews["id-0"].status, "idle");
  assert.equal(store.getState().errors["id-0"], "network unavailable");
  assert.deepEqual(store.getState().loading, {});
});
