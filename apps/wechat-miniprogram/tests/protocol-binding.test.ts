/**
 * The generated binding is the only protocol consumption path for the mini program, so its
 * header is part of the cross-component contract. The protocol owner froze it at exactly four
 * lines, and the sha256 always covers the UTF-8 bytes of `packages/protocol/src/remote.ts`.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { PROTOCOL_DIR, REPO_ROOT } from "./helpers/paths";
import { REMOTE_PROTOCOL_VERSION } from "../miniprogram/protocol";

const SOURCE_PATH = join(REPO_ROOT, "packages", "protocol", "src", "remote.ts");

// <app>/.tmp-test/tests -> <app>
const APP_ROOT = resolve(__dirname, "..", "..");
const GENERATED_PATH = join(APP_ROOT, "miniprogram", "protocol", "remote.generated.ts");

test("generated header matches the frozen four-line template", () => {
  const sha256 = createHash("sha256").update(readFileSync(SOURCE_PATH, "utf8"), "utf8").digest("hex");
  const lines = readFileSync(GENERATED_PATH, "utf8").split("\n");

  assert.deepEqual(lines.slice(0, 4), [
    "// GENERATED FILE - DO NOT EDIT.",
    `// Source: packages/protocol/src/remote.ts (sha256 ${sha256})`,
    "// Wire authority: protocol/remote/v1",
    "// Regenerate with: npm run sync:protocol"
  ]);
});

test("generated binding is exactly the header plus the untouched source", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");
  const lines = readFileSync(GENERATED_PATH, "utf8").split("\n");

  assert.equal(lines.length, source.split("\n").length + 4);
  assert.equal(`${lines.slice(4).join("\n")}`, source);
});

test("binding version agrees with the frozen protocol README", () => {
  const readme = readFileSync(join(PROTOCOL_DIR, "README.md"), "utf8");
  assert.equal(REMOTE_PROTOCOL_VERSION, 1);
  assert.match(readme, /v1 frames send `v: 1`/);
});
