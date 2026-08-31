import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("../src/store/conversationHandlers.ts", import.meta.url),
  "utf8"
);

test("terminal stream errors override an ACP zero exit code", () => {
  assert.match(
    source,
    /e\.exitCode === 0 && !hasTerminalUserFacingError\(nextItems\)/
  );
  assert.match(
    source,
    /live\.status === "done" && live\.exitCode === 0/
  );
  assert.match(source, /message: e\.message, terminal: true/);
});
