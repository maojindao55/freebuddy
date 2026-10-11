import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";

const asModule = output => `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
const compile = path => ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText;
const metricUrl = asModule(compile("../src/components/CLI/runCardMetrics.ts"));
const staticUrls = {
  "@/utils/duration": asModule(compile("../src/utils/duration.ts")),
  "@/utils/clipboard": asModule(compile("../src/utils/clipboard.ts")),
  "@/utils/projectPaths": asModule(compile("../src/utils/projectPaths.ts")),
  "@/utils/tokenCount": asModule(compile("../src/utils/tokenCount.ts")),
  "./runCardMetrics": metricUrl,
  "react": import.meta.resolve("react"),
  "lucide-react": import.meta.resolve("lucide-react"),
  "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
  "react-i18next": import.meta.resolve("react-i18next")
};
const nestedModule = path => {
  let source = compile(path);
  for (const [specifier, url] of Object.entries(staticUrls)) {
    source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(url));
  }
  return asModule(source);
};
const moduleUrls = {
  ...staticUrls,
  "./runMetricsView": nestedModule("../src/components/CLI/runMetricsView.tsx"),
  "react": import.meta.resolve("react"),
  "lucide-react": import.meta.resolve("lucide-react"),
  "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
  "react-i18next": import.meta.resolve("react-i18next")
};
async function loadComponent(path) {
  let source = compile(path);
  for (const [specifier, url] of Object.entries(moduleUrls)) {
    source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(url));
  }
  return import(asModule(source));
}
const { AgentSessionCard } = await loadComponent("../src/components/CLI/AgentSessionCard.tsx");
const { MessageRunMetrics, RunMetricsDetails, LiveRunElapsed, hasMessageRunMetrics } = await loadComponent("../src/components/CLI/MessageRunMetrics.tsx");
const { selectRunCardMetrics: selectCard, selectRunMetrics: selectRun } = await import(metricUrl);
const text = html => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

async function renderComponent(Component, props, language = "zh-CN") {
  const i18n = createInstance();
  await i18n.init({ lng: language, resources: {
    [language]: { translation: JSON.parse(fs.readFileSync(new URL(`../src/locales/${language}.json`, import.meta.url), "utf8")) }
  } });
  return renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(Component, props)));
}
const sessionProps = { projectName: "FreeBuddy", cwd: "/Users/me/www/freebuddy", folders: ["/Users/me/www/freebuddy"], sessionId: "97aa294c-0000-1111-2222-333333365ca2", messages: 6, turns: 3 };
const card = async (metrics, props = {}, language = "zh-CN") =>
  text(await renderComponent(AgentSessionCard, { cwd: "", folders: [], messages: 0, turns: 0, metrics, status: metrics.status, ...props }, language));
const cardHtml = (metrics, props = {}, language = "zh-CN") =>
  renderComponent(AgentSessionCard, { cwd: "", folders: [], messages: 0, turns: 0, metrics, status: metrics.status, ...props }, language);
const inline = async (metrics, language = "zh-CN") =>
  text(await renderComponent(MessageRunMetrics, { metrics }, language));
const details = async (metrics, language = "zh-CN") =>
  text(await renderComponent(RunMetricsDetails, { metrics }, language));
const live = (items, status = "running") => ({ taskSessionId: "run", status, items });
const message = items => ({ role: "assistant", taskId: "run", content: JSON.stringify(items) });
const run = summary => [{ kind: "usage", runMetrics: { runId: "run", promptSubmitted: true, ...summary } }];

test("side card shows idle, preparing and running states with live first-output waits", async () => {
  assert.match(await card({ ...selectCard([]), status: undefined }, { status: "idle" }), /空闲/);
  const preparing = selectCard([], live([], "starting"));
  const preparingHtml = await card(preparing);
  assert.match(preparingHtml, /准备中/);
  const waiting = selectCard([], live(run({ status: "running", elapsedMs: 1_000, firstOutputTracked: true })));
  const waitingHtml = await card(waiting, { elapsedMs: 2_500 });
  assert.match(waitingHtml, /运行中/);
  assert.match(waitingHtml, /首字输出 等待输出/);
  assert.match(waitingHtml, /2s/);
  const thinking = selectCard([], live(run({ status: "running", elapsedMs: 1_000, firstOutputTracked: true, firstOutputLatencyMs: 500, firstOutputKind: "thinking" })));
  assert.match(await card(thinking), /首字输出 0\.5 s · 思考/);
});

test("side card shows a finished run without elapsed or a first-output line and never measures inline", async () => {
  const metrics = selectCard([message(run({ status: "done", elapsedMs: 4_500, firstOutputTracked: true, firstOutputLatencyMs: 500, tokensPerSecond: 63.5, inputTokens: 17_000, outputTokens: 174 }))]);
  const html = await card(metrics, { elapsedMs: 4_500 });
  assert.match(html, /已完成/);
  assert.doesNotMatch(html, /首字输出|待上报|测速中|tok\/s|4\.5 s/);
});

test("side card context block appears only when usage is known", async () => {
  const metrics = selectCard([message(run({ status: "done", elapsedMs: 1_000 }))]);
  assert.doesNotMatch(await card(metrics), /上下文占用/);
  const withContext = await card(metrics, { contextUsed: 8_896, contextSize: 1_000_000 });
  assert.match(withContext, /上下文占用 0\.9% 8\.9K \/ 1M Token/);
});

test("team card shows the team title and duration without member metrics or session ID", async () => {
  const metrics = selectCard([message(run({ status: "done", elapsedMs: 5_000 }))]);
  const html = await card(metrics, { ...sessionProps, team: true, teamRunning: false, status: "done", elapsedMs: 5_000, contextUsed: 102_500, contextSize: 1_000_000 });
  assert.match(html, /团队运行/);
  assert.match(html, /5s/);
  assert.doesNotMatch(html, /97aa294c|tok\/s|首字输出|102,500|103K/);
  assert.match(html, /项目 · 消息 · 轮次/);
  const english = await card(metrics, { ...sessionProps, team: true, status: "done", elapsedMs: 5_000 }, "en");
  assert.match(english, /Team run/);
  assert.match(english, /Project · Messages · Turns/);
});

test("session details keep the project, session ID, mounts, worktree and counts", async () => {
  const metrics = selectCard([message(run({ status: "done", elapsedMs: 2_000 }))]);
  const html = await cardHtml(metrics, { ...sessionProps, folders: [...sessionProps.folders, "/Users/me/www/agy-acp"], primaryFolder: sessionProps.cwd, worktreePath: "/Users/me/.worktrees/freebuddy", contextUsed: 102_500, contextSize: 1_000_000 });
  assert.match(text(html), /项目 · ID · 消息 · 轮次/);
  assert.match(text(html), /FreeBuddy ~\/www\/freebuddy/);
  assert.match(text(html), /Primary ~\/www\/agy-acp/);
  assert.match(text(html), /上下文占用 10\.3% 103K \/ 1M Token/);
  assert.ok(html.includes(sessionProps.sessionId));
  assert.match(text(html), /Worktree .worktrees\/freebuddy/);
  assert.match(text(html), /消息数 6 Agent 轮次 3/);
  const english = await card(metrics, { projectName: "FreeBuddy", cwd: "", folders: [], messages: 6, turns: 3 }, "en");
  assert.match(english, /Project · ID · Messages · Turns/);
  assert.match(english, /Messages 6 Agent turns 3/);
  const empty = await card(selectCard([]), { status: "idle" });
  assert.match(empty, /未设置工作目录/);
});

test("inline row shows duration, first output, speed and tokens in order after a turn", async () => {
  const metrics = selectCard([message(run({
    status: "done", elapsedMs: 18_200, firstOutputTracked: true, firstOutputLatencyMs: 3_700,
    firstOutputKind: "text", tokensPerSecond: 52.4, speedSource: "measured", inputTokens: 3_200, outputTokens: 860
  }))]);
  const row = await inline(metrics);
  const duration = row.indexOf("18.2 s");
  const firstOutput = row.indexOf("首字输出 3.7 s");
  const speed = row.indexOf("52.4 tok/s");
  const tokens = row.indexOf("3.2K / 860 Token");
  assert.ok(duration >= 0 && firstOutput > duration && speed > firstOutput && tokens > speed, row);
  const html = await renderComponent(MessageRunMetrics, { metrics });
  assert.match(html, /class="msg-run-metrics"/);
  assert.match(html, /msg-run-metric is-duration/);
  assert.doesNotMatch(html, /msg-run-metrics-panel/);
});

test("inline row omits unmeasured items instead of reporting placeholders", async () => {
  const cline = selectCard([message(run({ status: "done", elapsedMs: 20_000, automaticSpeed: true, firstOutputTracked: true, firstOutputLatencyMs: 1_200 }))]);
  const row = await inline(cline);
  assert.match(row, /20\.0 s/);
  assert.match(row, /首字输出 1\.2 s/);
  assert.doesNotMatch(row, /未上报|不可测|tok\/s|Token/);
  const zeros = selectCard([message(run({ status: "done", elapsedMs: 2_000, tokensPerSecond: 0, inputTokens: 0, outputTokens: 860 }))]);
  const zeroRow = await inline(zeros);
  assert.match(zeroRow, /0\.0 tok\/s/);
  assert.match(zeroRow, /0 \/ 860 Token/);
  const legacy = selectCard([message(run({ status: "done", elapsedMs: 20_000, firstTextLatencyMs: 19_000 }))]);
  assert.match(await inline(legacy), /正文等待 19\.0 s/);
  const interrupted = selectCard([message(run({ status: "running", elapsedMs: 9_000, inputTokens: 12 }))]);
  const interruptedRow = await inline(interrupted);
  assert.doesNotMatch(interruptedRow, /9\.0 s/);
  assert.match(interruptedRow, /12 \/ — Token/);
});

test("hasMessageRunMetrics gates the row on a persisted summary", async () => {
  const plain = selectRun([{ kind: "text", role: "assistant", content: "answer" }], "run");
  assert.equal(plain.summary, undefined);
  assert.equal(hasMessageRunMetrics(plain), false);
  const summaryOnly = selectRun(run({ status: "running", elapsedMs: 9_000 }), "run");
  assert.equal(hasMessageRunMetrics(summaryOnly), false);
});

test("popover body renders first output kinds, waits and basis notes in both languages", async () => {
  const base = { status: "done", elapsedMs: 20_000, promptSubmitted: true, firstOutputTracked: true, firstOutputLatencyMs: 500, firstTextLatencyMs: 19_000 };
  for (const [kind, chinese, english] of [["thinking", "思考", "Thinking"], ["tool-call", "工具请求", "Tool request"], ["text", "正文", "Text"]]) {
    const metrics = selectCard([message(run({ ...base, firstOutputKind: kind }))]);
    const zh = await details(metrics);
    assert.match(zh, new RegExp(`首字输出 0\\.5 s · ${chinese}`));
    assert.match(await details(metrics, "en"), new RegExp(`First output wait 0\\.5 s · ${english}`));
    const html = await renderComponent(RunMetricsDetails, { metrics });
    assert.match(html, /工具请求通知可能晚于参数的首个 Token/);
  }
  const historical = selectCard([message(run({ status: "done", elapsedMs: 20_000, firstTextLatencyMs: 19_000 }))]);
  assert.match(await details(historical), /正文等待 19\.0 s/);
  assert.match(await details(historical, "en"), /Body text wait 19\.0 s/);
  const absent = selectCard([message(run({ status: "done", elapsedMs: 20_000, firstOutputTracked: true }))]);
  assert.match(await details(absent), /未观察到输出/);
  const unavailableSummary = { ...base, firstOutputLatencyMs: undefined, firstOutputUnavailable: true };
  const unavailable = selectCard([message(run(unavailableSummary))]);
  assert.match(await details(unavailable), /首字输出 不可测/);
});

test("popover body lists measured, reported, call-average and automatic speed in both languages", async () => {
  const base = { status: "done", elapsedMs: 2_000, promptSubmitted: true, automaticSpeed: true };
  const measured = selectCard([message(run({ ...base, tokensPerSecond: 40, speedSource: "measured" }))]);
  const measuredHtml = await details(measured);
  assert.match(measuredHtml, /40\.0 tok\/s · 实测/);
  assert.match(measuredHtml, /排除首包等待、工具执行和人工等待/);
  const observed = selectCard([message(run({ ...base, tokensPerSecond: 40, speedSource: "observed" }))]);
  const observedHtml = await details(observed);
  assert.match(observedHtml, /流式观测/);
  assert.match(observedHtml, /本轮真实输出 Token/);
  const callAverage = selectCard([message(run({ ...base, elapsedMs: 25_950, outputTokens: 339, tokensPerSecond: 57.72114862020914, speedSource: "call-average" }))]);
  const avgHtml = await details(callAverage);
  assert.match(avgHtml, /平均吞吐 57\.7 tok\/s · 含首包/);
  assert.match(avgHtml, /包含首包等待、思考和正文生成/);
  const avgEn = await details(callAverage, "en");
  assert.match(avgEn, /Average throughput 57\.7 tok\/s · Incl\. first packet/);
  const automatic = selectCard([message(run(base))]);
  assert.match(await details(automatic), /不可测/);
  const missing = selectCard([message(run({ status: "done", elapsedMs: 2_000 }))]);
  assert.match(await details(missing), /未上报/);
  assert.doesNotMatch(await details(measured), /char\/s|字符\/s/);
});

test("popover body keeps reported TTFT, cache rate, thought tokens, LLM time and cost", async () => {
  const metrics = selectCard([], live([
    { kind: "usage", usageScope: "turn", inputTokens: 100, cachedReadTokens: 0, thoughtTokens: 0, costAmount: 0, costCurrency: "USD", metrics: { llmDurationMs: 1_500 } },
    { kind: "usage", runMetrics: { runId: "run", status: "done", elapsedMs: 2_000, promptSubmitted: true, reportedTtftMs: 300, inputTokens: 100, outputTokens: 50 } }
  ], "done"));
  const html = await details(metrics);
  assert.match(html, /平均 TTFT · 上报 0\.3 s/);
  assert.match(html, /缓存命中率 0%/);
  assert.match(html, /思考 Token 0/);
  assert.match(html, /1\.5 s/);
  assert.match(html, /0\.00 USD/);
  const unknown = { ...metrics, usage: { kind: "usage", cachedReadTokens: 0 } };
  assert.match(await details(unknown), /缓存命中率 —/);
  for (const [status, label] of [["failed", "失败"], ["cancelled", "已取消"], ["timed-out", "已超时"], ["yielded", "已委派 / 让出"]]) {
    const m = selectCard([message(run({ status, elapsedMs: 1_000, inputTokens: 1 }))]);
    assert.match(await details(m), new RegExp(label));
  }
});

test("live elapsed ticker renders inside the running status pill", async () => {
  const metrics = selectCard([], live(run({ status: "running", elapsedMs: 2_000 })));
  const html = await renderComponent(LiveRunElapsed, { summary: metrics.summary, receivedAt: performance.now() });
  assert.match(html, /status-pill-elapsed/);
  assert.match(text(html), /2s/);
});

test("selectRunMetrics binds the summary to the message run id", () => {
  const items = [
    { kind: "usage", runMetrics: { runId: "other", status: "done", elapsedMs: 999 } },
    { kind: "usage", runMetrics: { runId: "run", status: "done", elapsedMs: 4_500, outputTokens: 12 } }
  ];
  const metrics = selectRun(items, "run");
  assert.equal(metrics.summary.elapsedMs, 4_500);
  assert.equal(metrics.outputTokens, 12);
  const other = selectRun(items, "other");
  assert.equal(other.summary.elapsedMs, 999);
});
