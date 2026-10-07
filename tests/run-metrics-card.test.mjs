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
const durationUrl = asModule(compile("../src/utils/duration.ts"));
const componentSource = compile("../src/components/CLI/RunMetricsSection.tsx")
  .replace('"@/utils/duration"', JSON.stringify(durationUrl))
  .replace('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime")))
  .replace('"react-i18next"', JSON.stringify(import.meta.resolve("react-i18next")));
const { RunMetricsSection } = await import(asModule(componentSource));
const { selectRunCardMetrics: select } = await import(asModule(compile("../src/components/CLI/runCardMetrics.ts")));

async function render(metrics, props = {}, language = "zh-CN") {
  const i18n = createInstance();
  await i18n.init({ lng: language, resources: {
    [language]: { translation: JSON.parse(fs.readFileSync(new URL(`../src/locales/${language}.json`, import.meta.url), "utf8")) }
  } });
  return renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(RunMetricsSection, { metrics, ...props })));
}
const live = items => ({ taskSessionId: "run", status: "running", items });

test("card separates empty, preparing, waiting, and missing reported metrics in both languages", async () => {
  assert.match(await render(select([])), /尚无运行/);
  const preparing = await render(select([], live([])));
  assert.match(preparing, /本轮运行/);
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
  assert.match(html, /1\.28 s/);
  assert.match(html, /平均 TTFT · 上报/);
  assert.match(html, /0\.30 s/);
  assert.match(html, /0\.0/);
  assert.match(html, /0 \/ 860/);
  assert.match(html, /2\.50 s/);
});

test("completed runs explain absent body and usage; team cards hide member metrics", async () => {
  const summary = { runId: "run", status: "done", elapsedMs: 2_000, promptSubmitted: true };
  const metrics = select([{ role: "assistant", content: JSON.stringify([{ kind: "usage", runMetrics: summary }]) }]);
  const done = await render(metrics, { elapsedMs: 2_000 });
  assert.match(done, /最近一次运行/);
  assert.match(done, /未产生正文/);
  assert.match(done, /未上报/);
  const team = await render({ ...metrics, firstTextMs: 1_280, tokensPerSecond: 900, inputTokens: 500 }, { team: true, elapsedMs: 5_000 });
  assert.match(team, /团队运行/);
  assert.match(team, /5\.00 s/);
  assert.doesNotMatch(team, /1\.28 s|900\.0|500 \/|平均 TTFT · 上报/);
});

test("card distinguishes automatic measurement, measured results and unmeasurable streams in both languages", async () => {
  const summary = { runId: "run", status: "running", elapsedMs: 2_000, promptSubmitted: true, automaticSpeed: true };
  const selectSummary = value => select([], live([{ kind: "usage", runMetrics: value }]));
  assert.match(await render(selectSummary(summary)), /测速中/);
  assert.match(await render(selectSummary(summary), {}, "en"), /Measuring/);
  const measured = { ...summary, tokensPerSecond: 40, speedSource: "measured" };
  const html = await render(selectSummary(measured));
  assert.match(html, /40\.0/);
  assert.match(html, /<small>实测<\/small>/);
  assert.match(html, /排除首包等待、工具执行和人工等待/);
  assert.match(await render(selectSummary(measured), {}, "en"), /<small>Measured<\/small>/);
  const done = select([{ role: "assistant", content: JSON.stringify([{ kind: "usage", runMetrics: { ...summary, status: "done" } }]) }]);
  assert.match(await render(done), /不可测/);
  const newRun = await render(select([], live([])));
  assert.doesNotMatch(newRun, /40\.0|<small>实测<\/small>/);
  const observed = selectSummary({ ...measured, speedSource: "observed" });
  assert.match(await render(observed), /<small>流式观测<\/small>/);
  assert.match(await render(observed, {}, "en"), /<small>Stream observed<\/small>/);
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
  assert.match(html, /调用平均（含首包）/);
  assert.match(html, /包含首包等待、思考和正文生成/);
  assert.match(html, /排除 CLI 初始化、工具执行与调用之间的等待/);
  assert.match(html, /25\.95 s/);
  const english = await render(metrics, {}, "en");
  assert.match(english, /Call average \(incl\. first packet\)/);
  assert.match(english, /Includes first-packet waiting, reasoning and text generation/);
});
