import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const settingsSource = fs.readFileSync(
  new URL("../src/components/Settings/CLIAdaptersTab.tsx", import.meta.url),
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
