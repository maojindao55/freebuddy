import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

const main = read("../electron/main.ts");
const telemetry = read("../electron/telemetry.ts");
const ipc = read("../electron/cli/ipc.ts");
const settingsStore = read("../src/store/settingsStore.ts");
const generalTab = read("../src/components/Settings/GeneralTab.tsx");
const buildScript = read("../scripts/write-telemetry-config.mjs");
const packageJson = JSON.parse(read("../package.json"));

test("PostHog telemetry is owned by the Electron main process", () => {
  assert.match(main, /initializeTelemetry\(\)/);
  assert.match(main, /shutdownTelemetry\(\)/);
  assert.match(telemetry, /new PostHog\(/);
  assert.match(telemetry, /app_first_launch/);
  assert.match(telemetry, /app_launched/);
  assert.match(telemetry, /app_updated/);
  assert.match(telemetry, /disableGeoip:\s*false/);
  assert.match(telemetry, /\$process_person_profile:\s*false/);
  assert.match(telemetry, /flushAt:\s*20/);
  assert.match(telemetry, /flushInterval:\s*1000/);
});

test("telemetry uses a random installation id and excludes workspace content", () => {
  assert.match(telemetry, /randomUUID\(\)/);
  assert.match(telemetry, /installation_id/);
  assert.doesNotMatch(telemetry, /workspacePath|\bcwd\b|message_content|prompt_text/);
});

test("anonymous telemetry can be disabled from general settings", () => {
  assert.match(settingsStore, /telemetryEnabled:\s*true/);
  assert.match(settingsStore, /setTelemetryEnabled/);
  assert.match(generalTab, /general\.telemetryLabel/);
  assert.match(generalTab, /type="checkbox"/);
  assert.match(ipc, /setTelemetryEnabled\(args\.value === "true"\)/);
});

test("release builds write PostHog public configuration outside renderer code", () => {
  assert.match(buildScript, /FREEBUDDY_POSTHOG_KEY/);
  assert.match(buildScript, /telemetry-config\.json/);
  assert.match(packageJson.scripts["build:electron"], /write-telemetry-config/);
});
