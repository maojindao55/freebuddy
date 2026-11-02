import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// dist-electron is produced by `npm run build:electron`, which `npm test` runs first.
const { taskkillArgs } = await import("../dist-electron/cli/process-kill.js");

test("taskkillArgs builds a forceful tree-kill command for a pid", () => {
  assert.deepEqual(taskkillArgs(123), ["/PID", "123", "/T", "/F"]);
});

test("taskkill does not open a Windows console window", () => {
  const source = fs.readFileSync(new URL("../electron/cli/process-kill.ts", import.meta.url), "utf8");
  assert.match(source, /spawn\("taskkill", taskkillArgs\(pid\), \{ stdio: "ignore", windowsHide: true \}\)/);
});
