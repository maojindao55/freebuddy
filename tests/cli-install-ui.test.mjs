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
  assert.match(storeSource, /getState\(\)\.check/);
});
