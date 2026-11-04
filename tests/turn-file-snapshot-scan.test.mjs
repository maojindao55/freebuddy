import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import os from "node:os";

test("expired snapshot scans do not launch Git and preserve unknown ending versions", async () => {
  const originalExecFile = childProcess.execFile;
  const calls = [];
  // Install before importing the scanner, which promisifies execFile at load time.
  childProcess.execFile = (...args) => {
    calls.push(args);
    throw new Error("An expired scan must not launch a subprocess");
  };
  syncBuiltinESMExports();
  try {
    const { scanSnapshotVersions, snapshotPathIdentity, DEFAULT_LIMITS } = await import("../dist-electron/cli/turnFileSnapshotScan.js?expired-budget");
    const root = path.join(os.tmpdir(), "freebuddy-expired-snapshot");
    const file = path.join(root, "file.md");
    const version = { state: "captured", hash: "saved-hash", bytes: 5 };
    for (const phase of ["before", "after"]) {
      const roots = [{ path: root, complete: true }];
      const events = [];
      const complete = await scanSnapshotVersions({
        phase, roots, owner: "alice", complete: true,
        limits: { ...DEFAULT_LIMITS, milliseconds: 0 },
        before: phase === "after" ? [{ path: file, identity: snapshotPathIdentity(file), before_version: JSON.stringify(version) }] : undefined
      }, async event => { events.push(event); });
      assert.equal(complete, false);
      assert.equal(calls.length, 0, `${phase}-turn scanning must not start Git after the deadline`);
      if (phase === "before") {
        assert.equal(roots[0].complete, false);
        assert.deepEqual(events, [{ kind: "roots", roots }]);
      } else {
        assert.equal(roots[0].complete, true, "ending scans retain the original enumeration coverage");
        assert.deepEqual(events, [{ kind: "batch", entries: [{
          path: file, identity: snapshotPathIdentity(file), before: version,
          after: { state: "unavailable", reason: "unavailable" }, same: false, body: undefined
        }] }]);
      }
    }
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
  }
});
