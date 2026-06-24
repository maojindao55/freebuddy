import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const settingsSource = fs.readFileSync(
  new URL("../src/components/Settings/CLIAdaptersTab.tsx", import.meta.url),
  "utf8"
);
const storeSource = fs.readFileSync(
  new URL("../src/store/cliExecutorStore.ts", import.meta.url),
  "utf8"
);

test("coding agent settings hide protocol command details by default", () => {
  assert.equal(settingsSource.includes("placeholder={ex.defaultBinary}"), false);
  assert.equal(settingsSource.includes("rt.binaryPath"), false);
  assert.equal(/<a[^>]*>\s*\{ex\.docsUrl\}\s*<\/a>/s.test(settingsSource), false);
});

test("coding agent settings expose model as a first-class field", () => {
  assert.equal(settingsSource.includes("Model"), true);
  assert.equal(settingsSource.includes("extractModelArg"), true);
  assert.equal(settingsSource.includes("withModelArg"), true);
});

test("coding agent settings support bulk check and auto-check on load", () => {
  assert.equal(settingsSource.includes("checkAll"), true);
  assert.equal(settingsSource.includes("handleCheckAll"), true);
  assert.equal(settingsSource.includes("useShallow"), true);
  assert.equal(settingsSource.includes("sortAdapters"), true);
  assert.equal(settingsSource.includes("lastCheckAt"), false);
  assert.equal(storeSource.includes("async checkAll()"), true);
  assert.match(storeSource, /for \(const adapter of acpAdapters\)/);
});
