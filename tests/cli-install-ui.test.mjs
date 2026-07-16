import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const settingsSource = fs.readFileSync(
  new URL("../src/components/Settings/CLIAdaptersTab.tsx", import.meta.url),
  "utf8"
);
const hostSource = fs.readFileSync(
  new URL("../src/components/Settings/CliInstallPanelHost.tsx", import.meta.url),
  "utf8"
);
const storeSource = fs.readFileSync(
  new URL("../src/store/cliInstallStore.ts", import.meta.url),
  "utf8"
);
const appSource = fs.readFileSync(
  new URL("../src/App.tsx", import.meta.url),
  "utf8"
);
const mainSource = fs.readFileSync(
  new URL("../electron/main.ts", import.meta.url),
  "utf8"
);
const checkSource = fs.readFileSync(
  new URL("../electron/cli/check.ts", import.meta.url),
  "utf8"
);
const windowsEnvSource = fs.readFileSync(
  new URL("../electron/cli/windowsEnv.ts", import.meta.url),
  "utf8"
);
const preloadSource = fs.readFileSync(
  new URL("../electron/preload.ts", import.meta.url),
  "utf8"
);
const ipcSource = fs.readFileSync(
  new URL("../electron/cli/ipc.ts", import.meta.url),
  "utf8"
);
const zhLocale = JSON.parse(
  fs.readFileSync(new URL("../src/locales/zh-CN.json", import.meta.url), "utf8")
);

test("agent install uses non-blocking floating panel instead of modal backdrop", () => {
  assert.equal(settingsSource.includes("InstallDialog"), false);
  assert.equal(settingsSource.includes("useCliInstallStore"), true);
  assert.equal(hostSource.includes("modal-backdrop"), false);
  assert.equal(hostSource.includes("install-panel-stack"), true);
  assert.equal(appSource.includes("CliInstallPanelHost"), true);
});

test("agent install store throttles output and supports background dismiss", () => {
  assert.match(storeSource, /FLUSH_MS/);
  assert.match(storeSource, /scheduleFlush/);
  assert.match(storeSource, /setPanelState\(id, "minimized"\)/);
  assert.match(storeSource, /import\("@\/store\/cliExecutorStore"\)/);
});

test("desktop agent installs discover common user-level runtime managers", () => {
  assert.match(mainSource, /path\.join\(home, "\.volta", "bin"\)/);
  assert.match(checkSource, /path\.join\(home, "\.volta", "bin"\)/);
  assert.match(checkSource, /prepareInstallEnvironment/);
  assert.match(checkSource, /absoluteInstallCommand/);
  assert.match(checkSource, /preflight\.requiresPowerShell/);
  assert.match(windowsEnvSource, /windowsCommandInvocation/);
  assert.match(checkSource, /path\.dirname\(executable\)/);
  assert.match(checkSource, /failureCode:\s*"tool_missing"/);
  assert.match(checkSource, /getFreshWindowsEnvironment/);
  assert.match(windowsEnvSource, /GetEnvironmentVariable\('Path','Machine'\)/);
  assert.match(windowsEnvSource, /GetEnvironmentVariable\('Path','User'\)/);
  assert.match(windowsEnvSource, /Get-Command/);
});

test("Apple Silicon installs reject an x64 Node runtime before package install", () => {
  assert.match(checkSource, /hw\.optional\.arm64/);
  assert.match(checkSource, /\["-p", "process\.arch"\]/);
  assert.match(checkSource, /adapter === "claude-agent-acp"/);
  assert.match(checkSource, /failureCode:\s*"node_arch_mismatch"/);
  assert.equal(
    zhLocale.settings.cli.nodeArchitectureMismatch,
    "检测到 Apple Silicon Mac 正在使用 x64 Node.js。请安装 ARM64 Node.js 后重试。"
  );
});

test("successful package install is verified before the UI reports success", () => {
  assert.match(storeSource, /phase:\s*"verifying"/);
  assert.match(storeSource, /await useCliExecutorStore\.getState\(\)\.check/);
  assert.match(storeSource, /"verification_failed"/);
  assert.match(hostSource, /settings\.cli\.installVerifying/);
  assert.match(hostSource, /settings\.cli\.installVerifiedSuccess/);
  assert.match(hostSource, /settings\.cli\.installVerificationFailed/);
});

test("concurrent agent installs keep stream events scoped to their request", () => {
  assert.match(preloadSource, /nextCliInstallRequestId/);
  assert.match(preloadSource, /event\.requestId !== requestId/);
  assert.match(preloadSource, /\{ adapter, command, requestId \}/);
  assert.match(checkSource, /\{ \.\.\.payload, requestId \}/);
  assert.match(ipcSource, /event\.sender,[\s\S]*args\.adapter,[\s\S]*args\.requestId/);
  assert.equal(ipcSource.includes("BrowserWindow.getFocusedWindow()?.webContents"), false);
});

test("agent version probes preserve actionable failure categories", () => {
  assert.match(checkSource, /timeoutMs = 15_000/);
  assert.match(checkSource, /CPU lacks AVX support/);
  assert.match(checkSource, /Claude native binary not found/);
  assert.match(checkSource, /version probe timed out/);
});
