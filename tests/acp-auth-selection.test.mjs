import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) =>
  fs.readFileSync(new URL(path, import.meta.url), "utf8");

const runtime = read("../electron/cli/acpRuntime.ts");
const runtimeShared = read("../electron/cli/runtimeShared.ts");
const ipc = read("../electron/cli/ipc.ts");
const preload = read("../electron/preload.ts");
const app = read("../src/App.tsx");
const handlers = read("../src/store/conversationHandlers.ts");
const store = read("../src/store/authenticationStore.ts");
const dialog = read("../src/components/CLI/AuthenticationDialog.tsx");

test("ACP runtime asks the renderer to select among multiple agent auth methods", () => {
  assert.match(runtime, /const automatic = selectAcpAuthMethod\(methods\)/);
  assert.match(runtime, /supported\.length < 2/);
  assert.match(runtime, /type: "authentication"/);
  assert.match(runtime, /registerAuthenticationResolver/);
  assert.match(runtime, /buildAuthenticateRequest\(nextId\(\), method\.id\)/);
});

test("authentication decisions cross the preload and IPC boundary", () => {
  assert.match(runtimeShared, /registerAuthenticationResolver/);
  assert.match(runtimeShared, /takeAuthenticationResolver/);
  assert.match(runtimeShared, /resolver\(\{ outcome: "cancelled" \}\)/);
  assert.match(ipc, /"cli:authenticationDecision"/);
  assert.match(ipc, /takeAuthenticationResolver/);
  assert.match(preload, /authenticationDecision/);
});

test("renderer queues, displays, resolves, and cleans up authentication requests", () => {
  assert.match(app, /<AuthenticationDialog \/>/);
  assert.match(handlers, /e\.type === "authentication"/);
  assert.match(handlers, /e\.type === "authentication-resolved"/);
  assert.match(handlers, /useAuthenticationStore\.getState\(\)\.removeForConversation/);
  assert.match(store, /cliClient\.authenticationDecision/);
  assert.match(dialog, /current\.methods\.map/);
  assert.match(dialog, /event\.key === "Escape"/);
  assert.match(dialog, /outcome: "cancelled"/);
  assert.match(dialog, /ArrowUp: "\\u001b\[A"/);
});

test("terminal auth restarts ACP and repeats initialize before authenticate", () => {
  assert.match(runtime, /runAuthenticationTerminal/);
  assert.match(runtime, /await restartAndInitialize\(\)/);
  const restartIndex = runtime.indexOf("await restartAndInitialize();");
  const authenticateIndex = runtime.indexOf(
    "buildAuthenticateRequest(nextId(), method.id)",
    restartIndex
  );
  assert.ok(restartIndex >= 0);
  assert.ok(authenticateIndex > restartIndex);
});
