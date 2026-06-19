import test from "node:test";
import assert from "node:assert/strict";

// dist-electron is produced by `npm run build:electron`, which `npm test` runs first.
const { taskkillArgs } = await import("../dist-electron/cli/process-kill.js");

test("taskkillArgs builds a forceful tree-kill command for a pid", () => {
  assert.deepEqual(taskkillArgs(123), ["/PID", "123", "/T", "/F"]);
});
