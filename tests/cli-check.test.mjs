import test from "node:test";
import assert from "node:assert/strict";

import { getCliCheckProbe } from "../dist-electron/cli/adapters.js";

test("Codex ACP uses help as its install check because it has no version flag", () => {
  assert.deepEqual(getCliCheckProbe("codex-acp"), {
    args: ["--help"],
    versionOptional: true
  });
});

test("legacy adapters still require a version response", () => {
  assert.deepEqual(getCliCheckProbe("codex"), {
    args: ["--version"],
    versionOptional: false
  });
});
