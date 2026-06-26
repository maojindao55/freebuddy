import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadBridge() {
  const source = fs.readFileSync(
    new URL("../electron/agentBridge.ts", import.meta.url),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("parseBridgeRequest routes /freebuddy/<action>", async () => {
  const { parseBridgeRequest } = await loadBridge();
  assert.deepEqual(parseBridgeRequest("/freebuddy/preview"), {
    action: "preview",
    params: {}
  });
  const nav = parseBridgeRequest("/freebuddy/navigate?to=about.html");
  assert.equal(nav?.action, "navigate");
  assert.equal(nav?.params.to, "about.html");
  const server = parseBridgeRequest(
    "/freebuddy/navigate?to=http%3A%2F%2F127.0.0.1%3A5173%2F"
  );
  assert.equal(server?.params.to, "http://127.0.0.1:5173/");
});

test("parseBridgeRequest supports legacy /preview", async () => {
  const { parseBridgeRequest } = await loadBridge();
  assert.deepEqual(parseBridgeRequest("/preview"), {
    action: "preview",
    params: {}
  });
});

test("parseBridgeRequest returns null for non-bridge paths", async () => {
  const { parseBridgeRequest } = await loadBridge();
  assert.equal(parseBridgeRequest("/foo"), null);
  assert.equal(parseBridgeRequest("/"), null);
});

test("isKnownBridgeAction flags catalog entries only", async () => {
  const { isKnownBridgeAction } = await loadBridge();
  assert.equal(isKnownBridgeAction("preview"), true);
  assert.equal(isKnownBridgeAction("navigate"), true);
  assert.equal(isKnownBridgeAction("entry"), true);
  assert.equal(isKnownBridgeAction("status"), true);
  assert.equal(isKnownBridgeAction("error"), true);
  assert.equal(isKnownBridgeAction("notify"), true);
  assert.equal(isKnownBridgeAction("nope"), false);
});

test("buildBridgeSection lists actions with the live port", async () => {
  const { buildBridgeSection } = await loadBridge();
  const md = buildBridgeSection(12345);
  assert.ok(md.includes("/freebuddy/preview"));
  assert.ok(md.includes("/freebuddy/navigate"));
  assert.ok(md.includes("/freebuddy/entry"));
  assert.ok(md.includes("/freebuddy/status"));
  assert.ok(md.includes("/freebuddy/error"));
  assert.ok(md.includes("/freebuddy/notify"));
  assert.ok(md.includes("127.0.0.1:12345"));
  assert.ok(md.includes("npm run dev"));
  assert.ok(md.includes("README.md"));
  assert.ok(md.includes("assets%2Fmockup.png"));
});
