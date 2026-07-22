import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  findMacAppCliBinary,
  macAppCliCandidates
} from "../dist-electron/cli/macAppCli.js";

test("macOS Codex lookup includes official desktop app bundles", () => {
  const home = "/Users/example";
  assert.deepEqual(macAppCliCandidates("codex", home), [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    path.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
    path.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex")
  ]);
});

test("macOS Codex lookup returns the first existing app-bundled CLI", () => {
  const expected = "/Applications/ChatGPT.app/Contents/Resources/codex";
  assert.equal(
    findMacAppCliBinary("codex", {
      platform: "darwin",
      home: "/Users/example",
      isFile: (candidate) => candidate === expected
    }),
    expected
  );
});

test("app-bundled CLI lookup stays disabled on other platforms", () => {
  assert.equal(
    findMacAppCliBinary("codex", {
      platform: "linux",
      isFile: () => true
    }),
    undefined
  );
});
