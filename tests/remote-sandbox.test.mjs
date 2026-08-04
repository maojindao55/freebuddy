import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("remote runs and ACP terminal commands use the lightweight sandbox", () => {
  const runtime = fs.readFileSync(
    new URL("../electron/cli/runtime.ts", import.meta.url),
    "utf8"
  );
  const acpRuntime = fs.readFileSync(
    new URL("../electron/cli/acpRuntime.ts", import.meta.url),
    "utf8"
  );
  const sandbox = fs.readFileSync(
    new URL("../electron/cli/sandboxRuntime.ts", import.meta.url),
    "utf8"
  );

  assert.match(runtime, /prepareSandboxedSpawn/);
  assert.match(runtime, /isRemoteIsolatedCaller/);
  assert.match(runtime, /shouldSandboxCurrentCaller/);
  assert.match(
    runtime,
    /const remoteIsolated = isRemoteIsolatedCaller\(\)/,
    "workspace isolation must follow the remote caller, not strict process sandbox"
  );
  assert.match(
    runtime,
    /const processSandboxed = shouldSandboxCurrentCaller\(\)/,
    "OS process sandbox must be gated separately from workspace isolation"
  );
  assert.match(
    runtime,
    /await isolateRemoteCwdForCaller\(effectiveArgs\.cwd\)/,
    "every remote agent run must map its cwd to a managed clone"
  );
  assert.match(
    runtime,
    /if \(processSandboxed\) \{\s*try \{\s*spawnCommand = await prepareSandboxedSpawn/,
    "prepareSandboxedSpawn runs only when the shared user enabled strict isolation"
  );
  assert.match(acpRuntime, /const remoteIsolated = isRemoteIsolatedCaller\(\)/);
  assert.match(acpRuntime, /const processSandboxed = shouldSandboxCurrentCaller\(\)/);
  assert.match(acpRuntime, /prepareSpawn:\s*processSandboxed/);
  assert.match(acpRuntime, /forbidden_path: terminal cwd/);
  assert.match(
    sandbox,
    /getUserById\(userId\)\?\.strictIsolation === true/,
    "process sandbox requires the per-user strictIsolation flag"
  );
  assert.match(sandbox, /allowAppleEvents:\s*false/);
  assert.match(sandbox, /allowUnixSockets:\s*\[\]/);
  assert.match(sandbox, /allowLocalBinding:\s*true/);
  assert.match(sandbox, /remote_sandbox_unavailable/);
  assert.doesNotMatch(
    sandbox,
    /Windows lightweight sandbox setup is not included/,
    "Windows WebUI runs must use srt-win instead of a hard-coded rejection"
  );
  assert.match(sandbox, /VENDORED_SRT_WIN_EXE/);
  assert.match(sandbox, /grantWindowsAcl/);
  assert.match(sandbox, /revokeWindowsHelperAccess/);
  assert.match(sandbox, /getWindowsAgentLinksRoot/);
  assert.match(sandbox, /getRemoteWorkspacesRoot/);
  assert.match(sandbox, /getWindowsManagedRoot/);
  const windowsPaths = fs.readFileSync(
    new URL("../electron/cli/windowsSandboxPaths.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    windowsPaths,
    /ProgramData/,
    "Windows managed sandbox paths must live under ProgramData, not AppData"
  );
  const remoteWorkspaces = fs.readFileSync(
    new URL("../electron/cli/remoteWorkspaces.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    remoteWorkspaces,
    /isHostAppDataPath/,
    "Windows must rematerialize legacy AppData remote workspaces outside AppData"
  );
  assert.match(sandbox, /--preserve-symlinks-main/);
  assert.match(sandbox, /windowsNodeLauncherEntry/);
  assert.match(sandbox, /windowsNativeLauncherBinary/);
  assert.match(sandbox, /ensureWindowsNativeBinaryStage/);
  assert.match(
    sandbox,
    /opencode\.exe must be spawned/,
    "Windows must spawn native CLI shims such as OpenCode instead of importing them"
  );
  assert.match(
    sandbox,
    /XDG_CONFIG_HOME:\s*path\.join\(hostHome,\s*"\.config"\)/,
    "Windows OpenCode must read host config without inheriting host AppData"
  );
  assert.match(
    sandbox,
    /HOMEDRIVE:\s*sandboxHomeDrive\.HOMEDRIVE/,
    "Windows OpenCode must override HOMEDRIVE/HOMEPATH or Bun still probes host AppData"
  );
  assert.match(sandbox, /function windowsHomeDrivePath/);
  assert.match(
    sandbox,
    /function withLocalhostNoProxy/,
    "OpenCode ACP localhost SDK calls must bypass the SRT HTTP proxy"
  );
  assert.match(
    sandbox,
    /adapter\.includes\("opencode"\)\s*\?\s*withLocalhostNoProxy\(env\)/,
    "OpenCode sandboxed env must set NO_PROXY for 127.0.0.1/localhost"
  );
  assert.match(
    sandbox,
    /prepareOpencodeSandboxHome/,
    "Windows OpenCode must seed host auth.json into the sandbox data home"
  );
  assert.match(sandbox, /models\.dev/);
  assert.match(sandbox, /native-\$\{label\}-\$\{digest\}/);
  assert.match(sandbox, /windowsStdinPath/);
  assert.match(sandbox, /Object\.defineProperty\(process,'stdin'/);
  assert.match(sandbox, /input\.adapter\.includes\("acp"\)/);
  assert.match(sandbox, /spawn\(p\.bin,p\.args/);
  assert.match(sandbox, /prepareGrokSandboxHome/);
  assert.match(sandbox, /GROK_HOME:\s*grokHome/);
  assert.match(sandbox, /cleanupWindowsBinaryAliases/);
  assert.match(runtime, /attachSandboxStdin/);
  assert.match(sandbox, /remote_sandbox_busy/);
  assert.match(
    sandbox,
    /windowsActiveCommands > 0[\s\S]*remote_sandbox_busy/,
    "remote_sandbox_busy must only fire while another Windows agent command is still active"
  );
  assert.match(
    sandbox,
    /windowsActiveCommands > 0[\s\S]*await startWindowsReset\(\);[\s\S]*materializeWindowsLaunch/,
    "idle incompatible Windows sandbox configs must recycle instead of failing the next WebUI agent"
  );
  const prepareSpawn = sandbox.slice(
    sandbox.indexOf("export async function prepareSandboxedSpawn"),
    sandbox.indexOf("export function cleanupSandboxCommand")
  );
  const beforeWindowsLock = prepareSpawn.slice(
    0,
    prepareSpawn.indexOf("withWindowsPrepareLock")
  );
  const windowsPrepare = prepareSpawn.slice(
    prepareSpawn.indexOf("withWindowsPrepareLock"),
    prepareSpawn.indexOf("const allowedRead = existing([")
  );
  assert.equal(
    beforeWindowsLock.includes("ensureWindowsBinaryAlias(binary"),
    false,
    "creating agent junctions before the Windows prepare lock races with reset cleanup"
  );
  const resetAwaitAt = windowsPrepare.indexOf(
    "if (windowsReset) await windowsReset"
  );
  const aliasCreateAt = windowsPrepare.indexOf(
    "ensureWindowsBinaryAlias(binary"
  );
  const stdinBridgeAt = windowsPrepare.indexOf("windowsStdinBridgePaths.add");
  assert.ok(
    resetAwaitAt >= 0 && aliasCreateAt > resetAwaitAt,
    "Windows agent junctions must be created only after an in-flight sandbox reset finishes"
  );
  assert.ok(
    resetAwaitAt >= 0 && stdinBridgeAt > resetAwaitAt,
    "Windows ACP stdin bridges must be registered only after an in-flight sandbox reset finishes"
  );
  assert.ok(
    !windowsPrepare.includes("applicationRuntimeReadPaths"),
    "Windows must not attempt to rewrite ACLs on protected system runtime paths"
  );
  assert.match(
    prepareSpawn,
    /applicationRuntimeReadPaths\(\)/,
    "non-Windows sandboxes still expose the Electron runtime read paths"
  );
  assert.match(
    sandbox,
    /windowsOuterSpawnEnvironment\(\s*input\.env,\s*wrapped\.env,\s*adapterSandbox\.env\s*\)/,
    "Windows outer srt-win spawn must keep host LOCALAPPDATA for the credential DB"
  );
  assert.match(
    sandbox,
    /WINDOWS_INNER_ONLY_ENV/,
    "Windows must not forward isolated profile env vars to the outer srt-win broker"
  );
  assert.match(
    sandbox,
    /env:\s*\{\s*\.\.\.input\.env,\s*\.\.\.wrapped\.env,\s*\.\.\.adapterSandbox\.env\s*\}/,
    "non-Windows sandbox proxy environment must override inherited host proxy settings before fixed adapter paths"
  );
  assert.match(sandbox, /\{\s*HOME:\s*sandboxHome\s*\}/);
  assert.match(sandbox, /QODER_CONFIG_DIR:\s*qoderConfig/);
  assert.match(sandbox, /TMPDIR:\s*sandboxTmp/);
  assert.match(sandbox, /CLAUDE_CODE_TMPDIR:\s*sandboxTmp/);
  assert.match(sandbox, /qoderProjectIdentifier/);
  assert.match(sandbox, /qoder-cli-\$\{uid\}/);
  assert.match(sandbox, /remote_sandbox_unsafe_qoder_workspace_temp/);
  assert.match(sandbox, /\.local",\s*"share",\s*"opencode"/);
  assert.match(sandbox, /\.kimi-code/);
  assert.match(sandbox, /CodeBuddyExtension/);
  assert.match(sandbox, /\.grok/);
  assert.match(sandbox, /applicationRuntimeReadPaths/);
  assert.match(sandbox, /host:\s*"::1"/);
  assert.match(sandbox, /entry\.replaceAll\("@localhost:",\s*"@\[::1\]:"\)/);
  assert.match(
    sandbox,
    /entry\.replaceAll\("@localhost:",\s*"@127\.0\.0\.1:"\)/,
    "native Agents must not perform a blocked localhost DNS lookup for the SRT proxy"
  );
  assert.match(
    acpRuntime,
    /if \(args\.conversationId && !remoteIsolated\)/,
    "remote WebUI sessions must not receive desktop-only Draft/Browser MCP servers"
  );

  const acpBranch = runtime.slice(
    runtime.indexOf('if (built.protocol === "acp")'),
    runtime.indexOf("runLegacyCliAgent({")
  );
  assert.match(acpBranch, /finally\s*{\s*if \(processSandboxed\) cleanupSandboxCommand\(\)/);
  assert.doesNotMatch(acpBranch, /restarted\.once\("close", cleanupSandboxCommand\)/);
  assert.match(
    acpRuntime,
    /remoteIsolated && args\.adapter\.includes\("grok"\)/
  );
});

test("remote terminal events are broadcast before their session owner is cleared", () => {
  const acpRuntime = fs.readFileSync(
    new URL("../electron/cli/acpRuntime.ts", import.meta.url),
    "utf8"
  );
  const legacyRuntime = fs.readFileSync(
    new URL("../electron/cli/legacyRuntime.ts", import.meta.url),
    "utf8"
  );

  const acpFinish = acpRuntime.slice(
    acpRuntime.indexOf("const finish ="),
    acpRuntime.indexOf("const cancelRun")
  );
  assert.ok(
    acpFinish.indexOf('emit({ type: "done"') <
      acpFinish.indexOf("clearSessionOwner(args.sessionId)"),
    "ACP done must retain the owner mapping while the WebUI broadcaster routes it"
  );

  const legacyClose = legacyRuntime.slice(
    legacyRuntime.indexOf('child.on("close"'),
    legacyRuntime.indexOf("capturedSessions.delete")
  );
  assert.ok(
    legacyClose.indexOf('emit({ type: "done"') <
      legacyClose.indexOf("clearSessionOwner(args.sessionId)"),
    "legacy done must retain the owner mapping while the WebUI broadcaster routes it"
  );
});

test("remote callers cannot resume renderer-supplied desktop agent sessions", () => {
  const runtime = fs.readFileSync(
    new URL("../electron/cli/runtime.ts", import.meta.url),
    "utf8"
  );
  const selection = runtime.slice(
    runtime.indexOf("const remoteIsolated = isRemoteIsolatedCaller()"),
    runtime.indexOf("insertTask(")
  );
  const remoteBranch = selection.slice(
    selection.indexOf("if (remoteIsolated)"),
    selection.indexOf("} else {")
  );
  assert.match(remoteBranch, /prev\?\.adapter === args\.adapter/);
  assert.doesNotMatch(
    remoteBranch,
    /args\.toolSessionId/,
    "a WebUI-supplied session id must not cross the owner/workspace boundary"
  );
});

test("remote sessions gate task control and interactive decisions by owner", () => {
  const ipc = fs.readFileSync(
    new URL("../electron/cli/ipc.ts", import.meta.url),
    "utf8"
  );
  for (const channel of [
    "cli:kill",
    "cli:permissionDecision",
    "cli:authenticationDecision",
    "cli:authenticationTerminalInput",
    "cli:authenticationTerminalCancel"
  ]) {
    const start = ipc.indexOf(`"${channel}"`);
    assert.notEqual(start, -1, `${channel} handler missing`);
    assert.match(
      ipc.slice(start, start + 1_000),
      /callerCanControlSession/,
      `${channel} must verify the session owner`
    );
  }
});
