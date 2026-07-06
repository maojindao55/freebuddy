import test from "node:test";
import assert from "node:assert/strict";

import { getAdapterDefinition, getCliCheckProbe } from "../dist-electron/cli/adapters.js";

test("Codex ACP checks the new Agent Client Protocol package version", () => {
  assert.deepEqual(getCliCheckProbe("codex-acp"), {
    args: ["--version"],
    versionOptional: false
  });
});

test("Codex ACP install command force-overwrites the retired Zed package binary", () => {
  assert.equal(
    getAdapterDefinition("codex-acp")?.installHint,
    "npm install -g --force @agentclientprotocol/codex-acp"
  );
});

test("Claude ACP checks the delegated CLI version instead of starting ACP", () => {
  assert.deepEqual(getCliCheckProbe("claude-agent-acp"), {
    args: ["--cli", "--version"],
    versionOptional: false
  });
});

test("legacy adapters still require a version response", () => {
  assert.deepEqual(getCliCheckProbe("codex"), {
    args: ["--version"],
    versionOptional: false
  });
});
