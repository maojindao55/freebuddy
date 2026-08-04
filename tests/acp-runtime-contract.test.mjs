import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const acpRuntimeSource = fs.readFileSync(
  new URL("../electron/cli/acpRuntime.ts", import.meta.url),
  "utf8"
);
const ipcSource = fs.readFileSync(
  new URL("../electron/cli/ipc.ts", import.meta.url),
  "utf8"
);
const runtimeSource = fs.readFileSync(
  new URL("../electron/cli/runtime.ts", import.meta.url),
  "utf8"
);

test("ACP runtime finalizes successful prompt turns without waiting for process exit", () => {
  const promptIndex = acpRuntimeSource.indexOf("await runPromptOnSession();");
  const closeIndex = acpRuntimeSource.indexOf(
    "buildSessionCloseRequest",
    promptIndex
  );
  const doneIndex = acpRuntimeSource.indexOf('finish("done", 0)', closeIndex);
  const stdinEndIndex = acpRuntimeSource.indexOf("child.stdin.end();", doneIndex);

  assert.notEqual(promptIndex, -1);
  assert.notEqual(closeIndex, -1);
  assert.notEqual(doneIndex, -1);
  assert.notEqual(stdinEndIndex, -1);
  assert.ok(promptIndex < closeIndex);
  assert.ok(closeIndex < doneIndex);
  assert.ok(doneIndex < stdinEndIndex);
});

test("ACP runtime still treats process close as a fallback finish signal", () => {
  assert.match(acpRuntimeSource, /child\.on\("close"/);
  assert.match(acpRuntimeSource, /exitCode === 0 \? "done" : "failed"/);
  assert.match(acpRuntimeSource, /finish\(status, exitCode, crashMessage\)/);
});

test("ACP auto approval never leaves an unsupported permission request pending", () => {
  assert.match(
    acpRuntimeSource,
    /if \(args\.approvalMode === "auto"\)[\s\S]*?permission auto-cancelled \(no allow option\)[\s\S]*?respondToPermission\(requestRpcId, \{ outcome: "cancelled" \}\)/
  );
});

test("ACP permission requests expire through the resolver registry", () => {
  assert.match(acpRuntimeSource, /takePermissionResolver/);
  assert.match(acpRuntimeSource, /PERMISSION_REQUEST_TIMEOUT_MS/);
  assert.match(acpRuntimeSource, /setTimeout\(/);
  assert.match(acpRuntimeSource, /permission timeout/);
});

test("ACP turns are cancelled when the agent stops producing output", () => {
  assert.match(acpRuntimeSource, /INACTIVITY_TIMEOUT_MS/);
  assert.match(acpRuntimeSource, /const armInactivityTimer/);
  assert.match(acpRuntimeSource, /const disarmInactivityTimer/);
  // The watchdog arms when a prompt turn starts and disarms when it settles,
  // so a single stuck turn (not the whole session lifetime) is bounded.
  const promptBodyIndex = acpRuntimeSource.indexOf("const runPromptOnSession");
  const promptBody = acpRuntimeSource.slice(
    promptBodyIndex,
    acpRuntimeSource.indexOf("};", acpRuntimeSource.indexOf("disarmInactivityTimer();", promptBodyIndex)) + 2
  );
  assert.match(promptBody, /armInactivityTimer\(\);/);
  assert.match(promptBody, /disarmInactivityTimer\(\);/);
  // Every live session/update frame resets the timer, mirroring promptHadContent.
  assert.match(
    acpRuntimeSource,
    /promptHadContent = true;\s*\n\s*armInactivityTimer\(\);/
  );
  // On expiry the run is torn down via the existing cancel+finish path so the
  // workflow runtime observes the standard error+done event pair.
  assert.match(
    acpRuntimeSource,
    /inactivity timeout after [\s\S]*?cancelRun\(\);[\s\S]*?finish\(\s*"failed"/
  );
  // finish() clears the timer so a late fire cannot race a normal completion.
  const finishBody = acpRuntimeSource.slice(
    acpRuntimeSource.indexOf("const finish ="),
    acpRuntimeSource.indexOf("const cancelRun")
  );
  assert.match(finishBody, /disarmInactivityTimer\(\);/);
  assert.ok(
    finishBody.indexOf("disarmInactivityTimer();") <
      finishBody.indexOf('emit({ type: "done"'),
    "inactivity timer is cleared before the terminal done event fires"
  );
});

test("ACP inactivity watchdog probes liveness before cancelling and caps reprieves", () => {
  // Before killing a silent run, the runtime sends a read-only session/list
  // probe. A responsive agent gets extra time (reprieve); an unresponsive one
  // or one that exhausted reprieves is still cancelled.
  assert.match(acpRuntimeSource, /const probeAgentLiveness/);
  assert.match(acpRuntimeSource, /buildSessionListRequest\(probeId\)/);
  assert.match(acpRuntimeSource, /INACTIVITY_PING_TIMEOUT_MS/);
  assert.match(acpRuntimeSource, /MAX_INACTIVITY_REPRIEVES/);
  // Reprieve path increments a counter and re-arms the timer instead of
  // cancelling, so a silent-but-alive sub-agent task isn't killed immediately.
  assert.match(acpRuntimeSource, /inactivityReprieves \+= 1/);
  assert.match(
    acpRuntimeSource,
    /inactivityFired = false;\s*\n\s*disarmInactivityTimer\(\);\s*\n\s*armInactivityTimer\(\);/
  );
  // Reprieves reset per prompt turn.
  const promptBodyIndex = acpRuntimeSource.indexOf("const runPromptOnSession");
  const promptBody = acpRuntimeSource.slice(
    promptBodyIndex,
    acpRuntimeSource.indexOf("};", acpRuntimeSource.indexOf("armInactivityTimer();", promptBodyIndex)) + 2
  );
  assert.match(promptBody, /inactivityReprieves = 0/);
  // The kill path is preserved (probe timed out / unsupported, or reprieves
  // exhausted) and still tears the run down via cancel+finish.
  assert.match(
    acpRuntimeSource,
    /inactivity timeout after [\s\S]*?cancelRun\(\);[\s\S]*?finish\(\s*"failed"/
  );
});

test("CLI runtime records the approval mode with each task start", () => {
  assert.match(runtimeSource, /approvalMode: args\.approvalMode \?\? "default"/);
});

test("ACP terminal output uses the stable exitStatus response shape", () => {
  assert.match(acpRuntimeSource, /buildTerminalOutputResponse\(snap\)/);
});

test("acpRuntime registers workspace FS MCP only for multi-root", () => {
  assert.match(acpRuntimeSource, /registerWorkspaceFsToolSession/);
  assert.match(acpRuntimeSource, /unregisterWorkspaceFsToolSession/);
  assert.match(acpRuntimeSource, /workspaceRoots/);
  assert.match(acpRuntimeSource, /roots\.length\s*>\s*1/);
});

test("cliRun passes workspaceRoots into buildCommand", () => {
  assert.match(runtimeSource, /workspaceRoots:\s*args\.workspaceRoots/);
});

test("cli:run always overwrites renderer workspaceRoots with authoritative resolution", () => {
  assert.match(
    ipcSource,
    /runArgs\s*=\s*\{\s*\.\.\.runArgs,\s*workspaceRoots\s*\}/
  );
  assert.doesNotMatch(
    ipcSource,
    /if\s*\(\s*workspaceRoots\.length\s*\)\s*\{\s*runArgs\s*=\s*\{\s*\.\.\.runArgs,\s*workspaceRoots\s*\}/
  );
});
