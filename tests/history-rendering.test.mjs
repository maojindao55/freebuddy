import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const compile = source => ts.transpileModule(source, {compilerOptions:{
  module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX
}}).outputText;
const resolveImports = source => {
  for (const name of ["react", "react/jsx-runtime", "@freebuddy/cli-stream"])
    source = source.replaceAll(JSON.stringify(name), JSON.stringify(import.meta.resolve(name)));
  return source;
};
const { DeferredDetails } = await import(dataUrl(resolveImports(compile(fs.readFileSync(
  new URL("../src/components/CLI/DeferredDetails.tsx", import.meta.url), "utf8"
)))));
const utils = await import(dataUrl(resolveImports(compile(fs.readFileSync(
  new URL("../src/store/conversationUtils.ts", import.meta.url), "utf8"
)))));
const bubbleSource = fs.readFileSync(new URL("../src/components/CLI/MessageBubble.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("bubble.tsx",bubbleSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names = new Set(["HIDDEN_CODEX_EVENTS","errorMessageFrom","normalizeRawItem","normalizeStoredItems"]);
const declarations = ast.statements.filter(node =>
  ts.isFunctionDeclaration(node) && names.has(node.name?.text) ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.has(d.name.getText(ast)))
).map(node => node.getText(ast)).join("\n");
const normalizers = new Function("appendItems", compile(declarations).replaceAll("export ", "") +
  ";return {normalizeStoredItems,normalizeRawItem};")(utils.appendItems);

test("collapsed details never constructs or renders its expensive body", () => {
  let calls = 0;
  const child = () => {calls++; return React.createElement("pre", null, "full result");};
  const summary = React.createElement("summary", null, "Details");
  const closed = renderToStaticMarkup(React.createElement(DeferredDetails, {summary}, child));
  assert.equal(calls, 0);
  assert.match(closed, /<summary>Details<\/summary>/);
  assert.doesNotMatch(closed, /full result/);
  const open = renderToStaticMarkup(React.createElement(DeferredDetails, {summary,open:true}, child));
  assert.equal(calls, 1);
  assert.match(open, /full result/);
});

test("batched history normalization preserves legacy errors, tools and final snapshots", () => {
  const items = [
    {kind:"raw",content:JSON.stringify({type:"item.completed",item:{type:"reasoning",text:"reason"}})},
    ...Array.from({length:8000}, () => ({kind:"thinking",append:true,content:"tiny"})),
    {kind:"tool-call",id:"tool",tool:"read",status:"running",input:{path:"readme.md"}},
    {kind:"tool-result",id:"tool",tool:"read",content:"first"},
    {kind:"tool-result",id:"tool",tool:"read",content:"complete"},
    {kind:"tool-call",id:"tool",tool:"read",status:"completed"},
    {kind:"text",role:"assistant",content:"hello",append:true,messageId:"answer"},
    {kind:"text",role:"assistant",content:" world",append:true,messageId:"answer"},
    {kind:"text",role:"assistant",content:"hello world",messageId:"answer"},
    {kind:"error",message:"one error"}, {kind:"error",message:"one error"}
  ];
  const original = JSON.stringify(items);
  let previous = [];
  for (const item of items) {
    for (const next of item.kind === "raw" ? normalizers.normalizeRawItem(item) : [item]) {
      if(next.kind === "error" && previous.at(-1)?.kind === "error" && previous.at(-1).message === next.message) continue;
      previous = utils.appendItems(previous, [next]);
    }
  }
  assert.deepEqual(normalizers.normalizeStoredItems(items), previous);
  assert.equal(JSON.stringify(items), original);
  assert.equal(previous.find(item=>item.kind==="text").content, "hello world");
});
