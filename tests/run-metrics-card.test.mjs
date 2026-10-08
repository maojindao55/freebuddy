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
const moduleUrls = {
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
async function loadComponent(path) {
  let source = compile(path);
  for (const [specifier, url] of Object.entries(moduleUrls)) {
    source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(url));
  }
  return import(asModule(source));
}
const { RunMetricsSection } = await loadComponent("../src/components/CLI/RunMetricsSection.tsx");
const { SessionInfoCard } = await loadComponent("../src/components/CLI/SessionInfoCard.tsx");
const { selectRunCardMetrics: select } = await import(metricUrl);
const text = html => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

async function renderComponent(Component, props, language = "zh-CN") {
  const i18n = createInstance();
  await i18n.init({ lng: language, resources: {
    [language]: { translation: JSON.parse(fs.readFileSync(new URL(`../src/locales/${language}.json`, import.meta.url), "utf8")) }
  } });
  return renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(Component, props)));
}
const render = async (metrics, props = {}, language = "zh-CN") => text(await renderComponent(RunMetricsSection, { metrics, ...props }, language));
const live = items => ({ taskSessionId: "run", status: "running", items });

test("card separates empty, preparing, waiting, and missing reported metrics in both languages", async () => {
  assert.match(await render(select([])), /尚无运行/);
  const preparing = await render(select([], live([])));
  assert.match(preparing, /本次运行/);
  assert.match(preparing, /准备中/);
  assert.match(preparing, /待上报/);
  const waiting = select([], live([{ kind: "usage", runMetrics: { runId: "run", status: "running", elapsedMs: 1_000, promptSubmitted: true } }]));
  assert.match(await render(waiting), /等待首字/);
  assert.match(await render(waiting, {}, "en"), /Waiting for text/);
});

test("card renders measured and reported TTFT separately and preserves reported zero", async () => {
  const metrics = select([], live([{ kind: "usage", runMetrics: {
    runId: "run", status: "running", elapsedMs: 2_000, promptSubmitted: true,
    firstTextLatencyMs: 1_280, reportedTtftMs: 300, tokensPerSecond: 0, inputTokens: 0, outputTokens: 860
  } }]));
  const html = await render(metrics, { elapsedMs: 2_500 });
  assert.match(html, /1\.3 s/);
  assert.match(html, /平均 TTFT · 上报/);
  assert.match(html, /0\.3 s/);
  assert.match(html, /0\.0/);
  assert.match(html, /Token 0 \/ 860 输入 \/ 输出/);
  assert.match(html, /2\.5 s/);
});

test("completed runs explain absent body and usage; team cards hide member metrics", async () => {
  const summary = { runId: "run", status: "done", elapsedMs: 2_000, promptSubmitted: true };
  const metrics = select([{ role: "assistant", content: JSON.stringify([{ kind: "usage", runMetrics: summary }]) }]);
  const done = await render(metrics, { elapsedMs: 2_000 });
  assert.match(done, /最近一次运行/);
  assert.match(done, /未产生正文/);
  assert.match(done, /未上报/);
  assert.match(done, /Token 未上报/);
  const team = await render({ ...metrics, firstTextMs: 1_280, tokensPerSecond: 900, inputTokens: 500 }, { team: true, elapsedMs: 5_000 });
  assert.match(team, /团队运行/);
  assert.match(team, /5\.0 s/);
  assert.doesNotMatch(team, /1\.3 s|900\.0|Token 500|平均 TTFT · 上报/);
});

test("card distinguishes automatic measurement, measured results and unmeasurable streams in both languages", async () => {
  const summary = { runId: "run", status: "running", elapsedMs: 2_000, promptSubmitted: true, automaticSpeed: true };
  const selectSummary = value => select([], live([{ kind: "usage", runMetrics: value }]));
  assert.match(await render(selectSummary(summary)), /测速中/);
  assert.match(await render(selectSummary(summary), {}, "en"), /Measuring/);
  const measured = { ...summary, tokensPerSecond: 40, speedSource: "measured" };
  const html = await render(selectSummary(measured));
  assert.match(html, /40\.0/);
  assert.match(html, /实测/);
  assert.match(html, /排除首包等待、工具执行和人工等待/);
  assert.match(await render(selectSummary(measured), {}, "en"), /Measured/);
  const done = select([{ role: "assistant", content: JSON.stringify([{ kind: "usage", runMetrics: { ...summary, status: "done" } }]) }]);
  assert.match(await render(done), /不可测/);
  const newRun = await render(select([], live([])));
  assert.doesNotMatch(newRun, /40\.0|实测/);
  const observed = selectSummary({ ...measured, speedSource: "observed" });
  assert.match(await render(observed), /流式观测/);
  assert.match(await render(observed, {}, "en"), /Stream observed/);
  assert.match(await render(observed), /本轮真实输出 Token/);
  assert.doesNotMatch(await render(done), /char\/s|字符\/s/);
});

test("call average survives reload and explains first-packet-inclusive timing in both languages", async () => {
  const summary = { runId: "run", status: "done", elapsedMs: 25_950, promptSubmitted: true,
    automaticSpeed: true, outputTokens: 339, tokensPerSecond: 57.72114862020914,
    speedSource: "call-average", modelCallDurationMs: 5_873.064 };
  const metrics = select([{ role: "assistant", taskId: "run",
    content: JSON.stringify([{ kind: "usage", runMetrics: summary }]) }]);
  const html = await render(metrics, { elapsedMs: 25_950 });
  assert.equal(metrics.speedSource, "call-average");
  assert.match(html, /57\.7/);
  assert.match(html, /平均吞吐 57\.7 tok\/s 含首包/);
  assert.match(html, /包含首包等待、思考和正文生成/);
  assert.match(html, /排除 CLI 初始化、工具执行与调用之间的等待/);
  assert.match(html, /25\.9 s/);
  const english = await render(metrics, {}, "en");
  assert.match(english, /Average throughput 57\.7 tok\/s Incl\. first packet/);
  assert.match(english, /Includes first-packet waiting, reasoning and text generation/);
});


test("folded metric details preserve real zero, unknown cache rate and reported secondary usage", async () => {
  const metrics = select([], live([
    { kind: "usage", inputTokens: 100, cachedReadTokens: 0, thoughtTokens: 0, costAmount: 0, costCurrency: "USD", metrics: { llmDurationMs: 1_500 } },
    { kind: "usage", runMetrics: { runId: "run", status: "running", elapsedMs: 2_000 } }
  ]));
  const html = await renderComponent(RunMetricsSection, { metrics });
  assert.match(text(html), /缓存命中率 0% 思考 Token 0/);
  assert.match(text(html), /1\.5 s/);
  assert.match(text(html), /0\.00 USD/);
  assert.match(html, /<details class="workspace-overview-disclosure">/);
  const unknown = await render({ ...metrics, usage: { kind: "usage", cachedReadTokens: 0 } });
  assert.match(unknown, /缓存命中率 —/);
});

test("card shows partial tokens, identity lockup and compact token counts in both languages", async () => {
  const partial = select([], live([{ kind: "usage", runMetrics: { runId: "run", status: "running", elapsedMs: 1_000, promptSubmitted: true, inputTokens: 17_000 } }]));
  assert.match(await render(partial), /Token 17K \/ — 输入 \/ 输出/);
  assert.match(await render(partial, {}, "en"), /Tokens 17K \/ — Input \/ Output/);
  assert.match(await renderComponent(RunMetricsSection, { metrics: partial }), /title="输入 17,000 · 输出 —"/);
  assert.match(await renderComponent(RunMetricsSection, { metrics: partial }, "en"), /title="in 17,000 · out —"/);
  const withIdentity = await render(partial, { identity: React.createElement("span", null, "DeepSeek Harness") });
  assert.match(withIdentity, /^\s*DeepSeek Harness 本次运行/);
});

test("session card collapses the empty project row into a single line in both languages", async () => {
  const empty = await renderComponent(SessionInfoCard, { cwd: "", folders: [], messages: 0, turns: 0, contextUsed: 8_896, contextSize: 1_000_000 });
  assert.match(text(empty), /会话信息 未设置工作目录 上下文占用 0\.9% 8\.9K \/ 1M Token/);
  assert.doesNotMatch(text(empty), /未设置 未设置/);
  const english = await renderComponent(SessionInfoCard, { cwd: "", folders: [], messages: 0, turns: 0, contextUsed: 8_896, contextSize: 1_000_000 }, "en");
  assert.match(text(english), /No working directory/);
  const named = await renderComponent(SessionInfoCard, { projectName: "FreeBuddy", cwd: "", folders: [], messages: 0, turns: 0 });
  assert.match(text(named), /会话信息 FreeBuddy 上下文占用/);
  assert.doesNotMatch(text(named), /未设置/);
});

const sessionProps = { projectName: "FreeBuddy", cwd: "/Users/me/www/freebuddy", folders: ["/Users/me/www/freebuddy"], sessionId: "97aa294c-0000-1111-2222-333333365ca2", messages: 6, turns: 3 };

test("session details retain full session ID, worktree and multi-root mounts", async () => {
  const html = await renderComponent(SessionInfoCard, { ...sessionProps, folders: [...sessionProps.folders, "/Users/me/www/agy-acp"], primaryFolder: sessionProps.cwd, worktreePath: "/Users/me/.worktrees/freebuddy", contextUsed: 102_500, contextSize: 1_000_000 });
  assert.match(text(html), /会话信息 FreeBuddy ~\/www\/freebuddy/);
  assert.match(text(html), /Primary ~\/www\/agy-acp/);
  assert.match(text(html), /上下文占用 10\.3% 103K \/ 1M Token/);
  assert.match(html, /value="10\.25"/);
  assert.ok(html.includes(sessionProps.sessionId));
  assert.match(text(html), /Worktree .worktrees\/freebuddy/);
  assert.match(text(html), /消息数 6 Agent 轮次 3/);
});

test("context meter distinguishes unknown capacity, real zero and over-capacity values", async () => {
  for (const values of [{}, { contextUsed: 0 }, { contextUsed: 20, contextSize: 0 }, { contextUsed: NaN, contextSize: 100 }, { contextUsed: -1, contextSize: 100 }]) {
    const html = await renderComponent(SessionInfoCard, { ...sessionProps, ...values });
    assert.doesNotMatch(html, /<progress/);
    assert.match(text(html), /上下文占用 —/);
  }
  const zero = await renderComponent(SessionInfoCard, { ...sessionProps, contextUsed: 0, contextSize: 100 });
  assert.match(text(zero), /上下文占用 0%/);
  assert.match(zero, /value="0"/);
  const full = await renderComponent(SessionInfoCard, { ...sessionProps, contextUsed: 120, contextSize: 100 });
  assert.match(text(full), /上下文占用 120%/);
  assert.match(full, /value="100"/);
});

test("token counts use K/M/B in every language", async () => {
  const { formatTokenCount } = await import(asModule(compile("../src/utils/tokenCount.ts")));
  const table = new Map([
    [0, "0"], [174, "174"], [999, "999"], [1000, "1K"], [1234, "1.23K"], [8896, "8.9K"],
    [17000, "17K"], [102500, "103K"], [123456, "123K"], [999500, "1M"], [1234567, "1.23M"],
    [99900000, "99.9M"], [1500000000, "1.5B"]
  ]);
  for (const [input, expected] of table) assert.equal(formatTokenCount(input), expected, `formatTokenCount(${input})`);
  assert.equal(formatTokenCount(undefined), "—");
  const metrics = select([{ role: "assistant", content: JSON.stringify([{ kind: "usage", runMetrics: { runId: "run", status: "done", elapsedMs: 1_000, promptSubmitted: true, inputTokens: 123_456, outputTokens: 8_896 } }]) }]);
  assert.match(await render(metrics, { elapsedMs: 1_000 }), /Token 123K \/ 8\.9K/);
  assert.doesNotMatch(await renderComponent(RunMetricsSection, { metrics, elapsedMs: 1_000 }), /万|亿/);
  const session = await renderComponent(SessionInfoCard, { cwd: "", folders: [], messages: 0, turns: 0, contextUsed: 1_234_567, contextSize: 2_000_000 });
  assert.match(text(session), /1\.23M \/ 2M Token/);
  assert.doesNotMatch(session, /万|亿/);
});

test("team session information hides member context and native session ID in both languages", async () => {
  for (const language of ["zh-CN", "en"]) {
    const html = await renderComponent(SessionInfoCard, { ...sessionProps, team: true, contextUsed: 102_500, contextSize: 1_000_000 }, language);
    assert.doesNotMatch(html, /<progress|97aa294c|102,500|103K/);
    assert.match(text(html), /FreeBuddy/);
    assert.match(text(html), language === "en" ? /Messages 6 Agent turns 3/ : /消息数 6 Agent 轮次 3/);
  }
});
