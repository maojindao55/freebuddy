import assert from "node:assert/strict";
import test from "node:test";

import {
  debugLogDir,
  logMain,
  mainLogDroppedLines
} from "../dist-electron/debugLog.js";

test("debug log can be imported in Electron Node mode before app initialization", () => {
  assert.doesNotThrow(() => logMain().info("test", "uninitialized logger remains a no-op"));
  assert.equal(mainLogDroppedLines(), 0);
  assert.throws(
    () => debugLogDir(),
    /Electron app APIs are unavailable before debug log initialization/
  );
});
