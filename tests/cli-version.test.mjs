import test from "node:test";
import assert from "node:assert/strict";

import {
  compareSemver,
  extractSemver
} from "../dist-electron/cli/version.js";

test("extractSemver reads Codex ACP CLI and npm JSON output", () => {
  assert.equal(
    extractSemver("@agentclientprotocol/codex-acp 1.1.0")?.raw,
    "1.1.0"
  );
  assert.equal(extractSemver('"1.1.2"')?.raw, "1.1.2");
});

test("compareSemver detects newer stable Codex ACP releases", () => {
  const installed = extractSemver("1.1.0");
  const latest = extractSemver("1.1.2");
  assert.ok(installed && latest);
  assert.equal(compareSemver(installed, latest), -1);
  assert.equal(compareSemver(latest, installed), 1);
});

test("compareSemver sorts prereleases below stable releases", () => {
  const prerelease = extractSemver("1.2.0-beta.2");
  const stable = extractSemver("1.2.0");
  assert.ok(prerelease && stable);
  assert.equal(compareSemver(prerelease, stable), -1);
});
