import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), "utf8");

test("Windows updater bypasses legacy pi-runtime uninstaller paths", () => {
  const nsh = read("desktop/windows/installer.nsh");

  assert.match(nsh, /!include "getProcessInfo\.nsh"/);
  assert.match(nsh, /!macro customCheckAppRunning/);
  assert.match(nsh, /!insertmacro IS_POWERSHELL_AVAILABLE/);
  assert.match(nsh, /!insertmacro _CHECK_APP_RUNNING/);
  // Sweep orphaned helper processes under $INSTDIR (older builds leave
  // FreeBuddy.exe-as-node / winpty-agent behind) before the stock check.
  assert.match(nsh, /!macro FreeBuddyLogInstDirProcesses/);
  assert.match(nsh, /!insertmacro FIND_PROCESS "\$\{APP_EXECUTABLE_FILENAME\}" \$R0/);
  assert.match(nsh, /!insertmacro KILL_PROCESS "\$\{APP_EXECUTABLE_FILENAME\}" 1/);
  assert.match(nsh, /Terminating leftover FreeBuddy processes/);
  assert.match(nsh, /resources\\pi-runtime\\runtime\\node_modules/);
  assert.match(nsh, /robocopy\.exe/);
  assert.match(nsh, /!macro customRemoveFiles/);
  assert.match(nsh, /FreeBuddyRemoveInstallDir "\$INSTDIR"/);
  assert.match(nsh, /FreeBuddyClearLegacyUninstallEntries/);
  assert.match(
    nsh,
    /DeleteRegValue HKCU "\$\{UNINSTALL_REGISTRY_KEY\}" "UninstallString"/
  );
});

test("app shutdown waits for CLI and ACP process trees", () => {
  const main = read("electron/main.ts");
  const runtime = read("electron/cli/runtime.ts");

  assert.match(runtime, /export async function shutdownCliProcesses/);
  assert.match(runtime, /cliKill\(sessionId\)/);
  assert.match(runtime, /waitForCliProcessExit/);

  const shutdownIndex = main.indexOf("function shutdownAppServices");
  const cliShutdownIndex = main.indexOf("await shutdownCliProcesses()", shutdownIndex);
  const runtimeShutdownIndex = main.indexOf("shutdownRuntimeProcesses()", cliShutdownIndex);
  const updateIndex = main.indexOf("beforeQuitAndInstall");
  const updateShutdownIndex = main.indexOf("await shutdownAppServices()", updateIndex);
  const quitIndex = main.indexOf('app.on("before-quit"');
  const quitShutdownIndex = main.indexOf("shutdownAppServices()", quitIndex);

  assert.ok(shutdownIndex >= 0);
  assert.ok(cliShutdownIndex > shutdownIndex);
  assert.ok(runtimeShutdownIndex > cliShutdownIndex);
  assert.ok(updateIndex >= 0);
  assert.ok(updateShutdownIndex > updateIndex);
  assert.ok(quitIndex >= 0);
  assert.ok(quitShutdownIndex > quitIndex);
});
