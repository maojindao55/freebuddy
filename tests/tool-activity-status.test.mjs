import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";

const compile = path => ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
let source = compile("../src/components/CLI/ToolActivityStatus.tsx");
for (const name of ["react", "react/jsx-runtime", "react-i18next"]) {
  source = source.replaceAll(JSON.stringify(name), JSON.stringify(import.meta.resolve(name)));
}
source = source.replaceAll('"@/utils/duration"', JSON.stringify(moduleUrl(compile("../src/utils/duration.ts"))));
const { ToolActivityStatus } = await import(moduleUrl(source));
const now = Date.now();
const call = { kind: "tool-call", id: "command", tool: "run_command", status: "running", startedAt: now - 150000, lastProgressAt: now - 130000 };
async function render(props = {}, language = "zh-CN") {
  const i18n = createInstance();
  await i18n.init({ lng: language, initImmediate: false, resources: { [language]: {
    translation: JSON.parse(fs.readFileSync(new URL(`../src/locales/${language}.json`, import.meta.url), "utf8"))
  } } });
  return renderToStaticMarkup(React.createElement(I18nextProvider, { i18n },
    React.createElement(ToolActivityStatus, { items: [call], active: true, onStop: async () => {}, ...props })));
}

test("silent tools show elapsed time and an honest wait-or-stop hint outside tool details", async () => {
  const html = await render();
  assert.match(html, /run_command/);
  assert.match(html, /已运行/);
  assert.match(html, /暂未收到新的执行进展/);
  assert.match(html, /部分工具只在结束后返回输出/);
  assert.match(html, /停止当前任务/);
  assert.doesNotMatch(html, /<details/);
  assert.match(await render({}, "en"), /Stop current task/);
});

test("historical, completed and legacy tool calls never show a live waiting warning", async () => {
  assert.equal(await render({ active: false }), "");
  assert.equal(await render({ items: [{ ...call, status: "completed" }] }), "");
  assert.equal(await render({ items: [{ ...call, startedAt: undefined }] }), "");
  assert.equal(await render({ items: [{ ...call, startedAt: Date.now(), lastProgressAt: Date.now() }] }), "");
});

test("fresh progress keeps the elapsed indicator but clears the silence warning", async () => {
  const html = await render({ items: [{ ...call, lastProgressAt: Date.now() }] });
  assert.match(html, /已运行/);
  assert.doesNotMatch(html, /暂未收到新的执行进展/);
  assert.doesNotMatch(html, /<button/);
});
