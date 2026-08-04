import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

function connectToProxy(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("proxy connection timed out"));
    }, 5_000);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("Windows lightweight sandbox writes only inside the managed workspace", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows srt-win smoke test");
    return;
  }
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }

  const srt = await import("@anthropic-ai/sandbox-runtime");
  const srtWin = srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE });
  const status = await srt.checkWindowsSandboxStatusAsync({ srtWin });
  if (!status.user.provisioned || !status.user.credPresent) {
    t.skip("Windows sandbox is not provisioned on this host");
    return;
  }

  const db = new Database(":memory:");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");
  const { cleanupSandboxCommand, prepareSandboxedSpawn } =
    await import("../dist-electron/cli/sandboxRuntime.js");

  const userId = `windows-sandbox-user-${process.pid}`;
  db.prepare(
    `INSERT INTO remote_users
       (id, username, password_hash, is_owner, created_at, disabled)
     VALUES (?, ?, 'test-only', 0, ?, 0)`
  ).run(userId, "windows-sandbox-user", Date.now());

  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "freebuddy-windows-sandbox-")
  );
  const inside = path.join(workspace, "inside.txt");
  const outside = path.join(
    os.homedir(),
    `.freebuddy-windows-sandbox-denied-${process.pid}-${Date.now()}`
  );
  const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = [
    `[IO.File]::WriteAllText(${quotePowerShell(inside)}, 'inside')`,
    "try {",
    `  [IO.File]::WriteAllText(${quotePowerShell(outside)}, 'outside')`,
    "  [Console]::Out.Write('escaped')",
    "} catch {",
    "  [Console]::Out.Write('denied')",
    "}"
  ].join("; ");
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );

  try {
    const prepared = await runAsCaller(userId, () =>
      prepareSandboxedSpawn({
        adapter: "test-agent",
        bin: powershell,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        cwd: workspace,
        env: { ...process.env }
      })
    );
    const result = spawnSync(prepared.bin, prepared.args, {
      cwd: workspace,
      env: prepared.env,
      encoding: "utf8",
      timeout: 15_000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "denied");
    assert.equal(fs.readFileSync(inside, "utf8"), "inside");
    assert.equal(fs.existsSync(outside), false);
  } finally {
    cleanupSandboxCommand();
    for (let attempt = 0; attempt < 50 && srt.SandboxManager.getConfig(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
    setDbForTest(null);
    db.close();
  }
});

test("macOS lightweight sandbox writes inside the workspace but not the host home", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS Seatbelt smoke test");
    return;
  }
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }

  const db = new Database(":memory:");
  const { migrate, setDbForTest } =
    await import("../dist-electron/cli/db.js");
  const { getRemoteWorkspacesRoot } =
    await import("../dist-electron/cli/windowsSandboxPaths.js");
  migrate(db);
  setDbForTest(db);
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");
  const { prepareSandboxedSpawn } =
    await import("../dist-electron/cli/sandboxRuntime.js");
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");

  const userId = `sandbox-write-user-${process.pid}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-sandbox-"));
  const inside = path.join(workspace, "inside.txt");
  const outside = path.join(
    os.homedir(),
    `.freebuddy-sandbox-denied-${process.pid}-${Date.now()}`
  );
  const sandboxHome = path.join(
    getRemoteWorkspacesRoot(),
    userId,
    "sandbox-home"
  );

  try {
    const prepared = await runAsCaller(userId, () =>
      prepareSandboxedSpawn({
        adapter: "codex",
        bin: "/bin/sh",
        args: [
          "-c",
          `printf inside > "${inside}"; printf outside > "${outside}"`
        ],
        cwd: workspace,
        env: { ...process.env }
      })
    );
    const result = spawnSync(prepared.bin, prepared.args, {
      cwd: workspace,
      env: prepared.env,
      encoding: "utf8"
    });
    assert.equal(fs.readFileSync(inside, "utf8"), "inside");
    assert.equal(fs.existsSync(outside), false);
    assert.equal(
      fs.realpathSync.native(prepared.env.TMPDIR),
      fs.realpathSync.native(path.join(sandboxHome, "tmp"))
    );
    assert.notEqual(
      result.status,
      0,
      "the shell should report the denied host-home write"
    );
  } finally {
    await SandboxManager.reset();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
    fs.rmSync(path.dirname(sandboxHome), { recursive: true, force: true });
    setDbForTest(null);
    db.close();
  }
});

test("macOS lightweight sandbox resolves a user-local launcher before isolation", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS Seatbelt smoke test");
    return;
  }
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }

  const db = new Database(":memory:");
  const { migrate, setDbForTest } =
    await import("../dist-electron/cli/db.js");
  const { getRemoteWorkspacesRoot } =
    await import("../dist-electron/cli/windowsSandboxPaths.js");
  migrate(db);
  setDbForTest(db);
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");
  const { prepareSandboxedSpawn } =
    await import("../dist-electron/cli/sandboxRuntime.js");
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");

  const userId = `sandbox-launcher-user-${process.pid}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-sandbox-"));
  const sandboxUserRoot = path.join(getRemoteWorkspacesRoot(), userId);
  const executableDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "freebuddy-sandbox-executable-")
  );
  const userBinDir = fs.mkdtempSync(
    path.join(os.homedir(), ".freebuddy-sandbox-bin-")
  );
  const executable = path.join(executableDir, "agent-cli");
  const launcher = path.join(userBinDir, "agent-cli");
  fs.writeFileSync(executable, "#!/bin/sh\nprintf launcher-ok\n", {
    mode: 0o700
  });
  fs.symlinkSync(executable, launcher);

  try {
    const prepared = await runAsCaller(userId, () =>
      prepareSandboxedSpawn({
        adapter: "test-agent",
        bin: "agent-cli",
        args: [],
        cwd: workspace,
        env: {
          ...process.env,
          PATH: `${userBinDir}${path.delimiter}${process.env.PATH ?? ""}`
        }
      })
    );
    const result = spawnSync(prepared.bin, prepared.args, {
      cwd: workspace,
      env: prepared.env,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "launcher-ok");
  } finally {
    await SandboxManager.reset();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(sandboxUserRoot, { recursive: true, force: true });
    fs.rmSync(executableDir, { recursive: true, force: true });
    fs.rmSync(userBinDir, { recursive: true, force: true });
    setDbForTest(null);
    db.close();
  }
});

test("macOS lightweight sandbox permits Agent-internal loopback IPC", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS Seatbelt smoke test");
    return;
  }
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }

  const db = new Database(":memory:");
  const { migrate, setDbForTest } =
    await import("../dist-electron/cli/db.js");
  const { getRemoteWorkspacesRoot } =
    await import("../dist-electron/cli/windowsSandboxPaths.js");
  migrate(db);
  setDbForTest(db);
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");
  const { prepareSandboxedSpawn } =
    await import("../dist-electron/cli/sandboxRuntime.js?loopback-ipc");
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");

  const userId = `sandbox-loopback-user-${process.pid}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-sandbox-"));
  const sandboxUserRoot = path.join(getRemoteWorkspacesRoot(), userId);
  const script = path.join(workspace, "loopback.mjs");
  fs.writeFileSync(
    script,
    [
      'import net from "node:net";',
      "const server = net.createServer((socket) => socket.end('ok'));",
      'server.listen({ host: "127.0.0.1", port: 0 }, () => {',
      "  const address = server.address();",
      '  const client = net.connect(address.port, "127.0.0.1");',
      '  client.setEncoding("utf8");',
      '  client.on("data", (chunk) => process.stdout.write(chunk));',
      '  client.on("close", () => server.close());',
      "});"
    ].join("\n")
  );

  try {
    const prepared = await runAsCaller(userId, () =>
      prepareSandboxedSpawn({
        adapter: "codebuddy-acp",
        bin: process.execPath,
        args: [script],
        cwd: workspace,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      })
    );
    assert.equal(
      prepared.args.some((entry) => entry.includes("@localhost:")),
      false
    );
    assert.equal(
      prepared.args.some((entry) => entry.includes("@127.0.0.1:")),
      true
    );
    const result = spawnSync(prepared.bin, prepared.args, {
      cwd: workspace,
      env: prepared.env,
      encoding: "utf8",
      timeout: 5_000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "ok");
  } finally {
    await SandboxManager.reset();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(sandboxUserRoot, { recursive: true, force: true });
    setDbForTest(null);
    db.close();
  }
});

test("Grok reaches SRT through the IPv6 loopback bridge", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS Seatbelt smoke test");
    return;
  }
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }

  const db = new Database(":memory:");
  const { migrate, setDbForTest } =
    await import("../dist-electron/cli/db.js");
  const { getRemoteWorkspacesRoot } =
    await import("../dist-electron/cli/windowsSandboxPaths.js");
  migrate(db);
  setDbForTest(db);
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");
  const { prepareSandboxedSpawn } =
    await import("../dist-electron/cli/sandboxRuntime.js?grok-proxy");
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");

  const userId = `sandbox-grok-user-${process.pid}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-sandbox-"));
  const sandboxUserRoot = path.join(getRemoteWorkspacesRoot(), userId);

  try {
    const prepared = await runAsCaller(userId, () =>
      prepareSandboxedSpawn({
        adapter: "grok-acp",
        bin: process.execPath,
        args: ["--version"],
        cwd: workspace,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      })
    );
    assert.equal(
      prepared.args.some((entry) => entry.includes("@localhost:")),
      false
    );
    assert.equal(
      prepared.args.some((entry) => entry.includes("@[::1]:")),
      true
    );
    const proxyPort = SandboxManager.getProxyPort();
    assert.ok(proxyPort);
    await connectToProxy("::1", proxyPort);
  } finally {
    await SandboxManager.reset();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(sandboxUserRoot, { recursive: true, force: true });
    setDbForTest(null);
    db.close();
  }
});

test("Qoder and Claude receive isolated writable temp paths", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS Seatbelt smoke test");
    return;
  }
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }

  const db = new Database(":memory:");
  const { migrate, setDbForTest } =
    await import("../dist-electron/cli/db.js");
  const { getRemoteWorkspacesRoot } =
    await import("../dist-electron/cli/windowsSandboxPaths.js");
  migrate(db);
  setDbForTest(db);
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");
  // Previous tests reset the SandboxManager singleton. Import a fresh runtime
  // instance so its one-time initialization state matches that reset manager.
  const { prepareSandboxedSpawn } =
    await import("../dist-electron/cli/sandboxRuntime.js?qoder-proxy");
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");

  const userId = `sandbox-qoder-user-${process.pid}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-sandbox-"));
  const sandboxHome = path.join(
    getRemoteWorkspacesRoot(),
    userId,
    "sandbox-home"
  );
  const qoderSharedRoot = path.join(
    fs.realpathSync.native("/tmp"),
    `qoder-cli-${process.getuid()}`
  );
  const qoderWorkspaceRoot = path.join(
    qoderSharedRoot,
    workspace.replace(/[^a-zA-Z0-9]/g, "-")
  );
  const qoderOutput = path.join(
    qoderWorkspaceRoot,
    "test-session",
    "tasks",
    "tool.output"
  );
  const forbiddenQoderRoot = path.join(
    qoderSharedRoot,
    `forbidden-${userId}`
  );

  try {
    const prepared = await runAsCaller(userId, () =>
      prepareSandboxedSpawn({
        adapter: "qoder-acp",
        bin: "/bin/sh",
        args: [
          "-c",
          'realpath "$HOME"; printf "%s\\n" "$QODER_CONFIG_DIR"; realpath "$TMPDIR"; printf agent-tmp > "$TMPDIR/qoder-tool.tmp"; mkdir -p "$(dirname "$QODER_OUTPUT_TEST_PATH")"; printf qoder-output > "$QODER_OUTPUT_TEST_PATH"; (mkdir -p "$QODER_FORBIDDEN_TEST_PATH" && printf forbidden > "$QODER_FORBIDDEN_TEST_PATH/output") 2>/dev/null || true'
        ],
        cwd: workspace,
        env: {
          ...process.env,
          QODER_OUTPUT_TEST_PATH: qoderOutput,
          QODER_FORBIDDEN_TEST_PATH: forbiddenQoderRoot
        }
      })
    );
    const result = spawnSync(prepared.bin, prepared.args, {
      cwd: workspace,
      env: prepared.env,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const outputLines = result.stdout.trim().split("\n");
    assert.equal(outputLines[0], fs.realpathSync.native(sandboxHome));
    const hostQoderConfig = path.join(os.homedir(), ".qoder");
    if (fs.existsSync(hostQoderConfig)) {
      assert.equal(outputLines[1], hostQoderConfig);
    } else {
      assert.equal(prepared.env.QODER_CONFIG_DIR, undefined);
    }
    assert.equal(
      outputLines[2],
      fs.realpathSync.native(path.join(sandboxHome, "tmp"))
    );
    assert.equal(
      fs.readFileSync(path.join(sandboxHome, "tmp", "qoder-tool.tmp"), "utf8"),
      "agent-tmp"
    );
    assert.equal(fs.readFileSync(qoderOutput, "utf8"), "qoder-output");
    assert.equal(
      fs.existsSync(forbiddenQoderRoot),
      false,
      "Qoder must not write another workspace's fixed temp subtree"
    );
    assert.notEqual(prepared.env.HOME, os.homedir());
    const proxyPort = SandboxManager.getProxyPort();
    assert.ok(proxyPort);
    await connectToProxy("::1", proxyPort);

    const claudePrepared = await runAsCaller(userId, () =>
      prepareSandboxedSpawn({
        adapter: "claude-agent-acp",
        bin: "/bin/sh",
        args: [
          "-c",
          'printf claude-tmp > "$CLAUDE_CODE_TMPDIR/claude-tool.tmp"'
        ],
        cwd: workspace,
        env: { ...process.env }
      })
    );
    const claudeResult = spawnSync(claudePrepared.bin, claudePrepared.args, {
      cwd: workspace,
      env: claudePrepared.env,
      encoding: "utf8"
    });
    assert.equal(claudeResult.status, 0, claudeResult.stderr);
    assert.equal(
      fs.realpathSync.native(claudePrepared.env.CLAUDE_CODE_TMPDIR),
      fs.realpathSync.native(path.join(sandboxHome, "tmp"))
    );
    assert.equal(
      fs.readFileSync(path.join(sandboxHome, "tmp", "claude-tool.tmp"), "utf8"),
      "claude-tmp"
    );
  } finally {
    await SandboxManager.reset();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(qoderWorkspaceRoot, { recursive: true, force: true });
    fs.rmSync(forbiddenQoderRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(sandboxHome), { recursive: true, force: true });
    setDbForTest(null);
    db.close();
  }
});

test("Windows sandbox launches Node agents below AppData through a safe alias", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows srt-win Node alias smoke test");
    return;
  }
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }

  const nodeExecutable = path.join(
    process.env.ProgramFiles || "C:\\Program Files",
    "nodejs",
    "node.exe"
  );
  if (!fs.existsSync(nodeExecutable)) {
    t.skip("system Node.js executable unavailable");
    return;
  }

  const srt = await import("@anthropic-ai/sandbox-runtime");
  const srtWin = srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE });
  const status = await srt.checkWindowsSandboxStatusAsync({ srtWin });
  if (!status.user.provisioned || !status.user.credPresent) {
    t.skip("Windows sandbox is not provisioned on this host");
    return;
  }

  const db = new Database(":memory:");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");
  const { cleanupSandboxCommand, prepareSandboxedSpawn } =
    await import("../dist-electron/cli/sandboxRuntime.js");

  const userId = `windows-node-alias-user-${process.pid}`;
  db.prepare(
    `INSERT INTO remote_users
       (id, username, password_hash, is_owner, created_at, disabled)
     VALUES (?, ?, 'test-only', 0, ?, 0)`
  ).run(userId, "windows-node-alias-user", Date.now());

  const agentDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "freebuddy-node-agent-")
  );
  const entry = path.join(agentDirectory, "main.js");
  const launcher = path.join(agentDirectory, "fake-agent.cmd");
  fs.writeFileSync(
    entry,
    'process.stdin.once("data", (chunk) => process.stdout.write(`node-alias-${chunk.toString()}`));\n'
  );
  fs.writeFileSync(
    launcher,
    `@echo off\r\n"${nodeExecutable}" "%~dp0main.js"\r\n`
  );

  try {
    const prepared = await runAsCaller(userId, () =>
      prepareSandboxedSpawn({
        adapter: "test-node-agent-acp",
        bin: launcher,
        args: [],
        cwd: agentDirectory,
        env: { ...process.env }
      })
    );
    assert.ok(prepared.stdinPath);
    fs.appendFileSync(prepared.stdinPath, "ok");
    const result = spawnSync(prepared.bin, prepared.args, {
      cwd: agentDirectory,
      env: prepared.env,
      encoding: "utf8",
      timeout: 15_000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "node-alias-ok", result.stderr);
    assert.match(prepared.stdinPath, /sandbox-home/);
  } finally {
    cleanupSandboxCommand();
    for (
      let attempt = 0;
      attempt < 100 && srt.SandboxManager.getConfig();
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    fs.rmSync(agentDirectory, { recursive: true, force: true });
    setDbForTest(null);
    db.close();
  }
});

test("Windows sandbox keeps the installed Qoder ACP process alive", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Qoder ACP smoke test");
    return;
  }
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }

  const qoder = path.join(
    os.homedir(),
    "AppData",
    "Roaming",
    "npm",
    "qodercli.cmd"
  );
  if (!fs.existsSync(qoder)) {
    t.skip("Qoder CLI is not installed");
    return;
  }

  const srt = await import("@anthropic-ai/sandbox-runtime");
  const srtWin = srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE });
  const status = await srt.checkWindowsSandboxStatusAsync({ srtWin });
  if (!status.user.provisioned || !status.user.credPresent) {
    t.skip("Windows sandbox is not provisioned on this host");
    return;
  }

  const db = new Database(":memory:");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");
  const { cleanupSandboxCommand, prepareSandboxedSpawn } =
    await import("../dist-electron/cli/sandboxRuntime.js");
  const userId = `windows-qoder-acp-user-${process.pid}`;
  db.prepare(
    `INSERT INTO remote_users
       (id, username, password_hash, is_owner, created_at, disabled)
     VALUES (?, ?, 'test-only', 0, ?, 0)`
  ).run(userId, "windows-qoder-acp-user", Date.now());

  let child;
  try {
    const prepared = await runAsCaller(userId, () =>
      prepareSandboxedSpawn({
        adapter: "qoder-acp",
        bin: qoder,
        args: ["--acp"],
        cwd: process.cwd(),
        env: { ...process.env }
      })
    );
    child = spawn(prepared.bin, prepared.args, {
      cwd: process.cwd(),
      env: prepared.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const response = await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(
        () => reject(new Error(`Qoder initialize timed out: ${stderr}`)),
        20_000
      );
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const line = stdout.split(/\r?\n/).find((entry) => entry.trim());
        if (!line) return;
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        if (stdout.trim()) return;
        clearTimeout(timer);
        reject(
          new Error(`Qoder exited before initialize response (${code}): ${stderr}`)
        );
      });
      child.on("error", reject);
      const initialize = `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: { terminal: true, auth: { terminal: true } },
          clientInfo: { name: "freebuddy-smoke", version: "0.6.8" }
        }
      })}\n`;
      if (prepared.stdinPath) {
        fs.appendFileSync(prepared.stdinPath, initialize);
      } else {
        child.stdin.write(initialize);
      }
    });
    assert.equal(response.id, 1);
    assert.equal(response.result?.protocolVersion, 1);
    assert.equal(child.exitCode, null, "Qoder must remain alive after initialize");
  } finally {
    if (child?.exitCode === null) child.kill();
    await new Promise((resolve) => setTimeout(resolve, 200));
    cleanupSandboxCommand();
    for (
      let attempt = 0;
      attempt < 100 && srt.SandboxManager.getConfig();
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    setDbForTest(null);
    db.close();
  }
});

test("Windows sandbox keeps the installed Grok ACP process alive", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Grok ACP smoke test");
    return;
  }
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }

  const grok = path.join(os.homedir(), ".grok", "bin", "grok.exe");
  if (!fs.existsSync(grok)) {
    t.skip("Grok CLI is not installed");
    return;
  }

  const srt = await import("@anthropic-ai/sandbox-runtime");
  const srtWin = srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE });
  const status = await srt.checkWindowsSandboxStatusAsync({ srtWin });
  if (!status.user.provisioned || !status.user.credPresent) {
    t.skip("Windows sandbox is not provisioned on this host");
    return;
  }

  const db = new Database(":memory:");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const { runAsCaller } = await import("../dist-electron/cli/callerContext.js");
  const { cleanupSandboxCommand, prepareSandboxedSpawn } =
    await import("../dist-electron/cli/sandboxRuntime.js");
  const userId = `windows-grok-acp-user-${process.pid}`;
  db.prepare(
    `INSERT INTO remote_users
       (id, username, password_hash, is_owner, created_at, disabled)
     VALUES (?, ?, 'test-only', 0, ?, 0)`
  ).run(userId, "windows-grok-acp-user", Date.now());

  let child;
  try {
    const prepared = await runAsCaller(userId, () =>
      prepareSandboxedSpawn({
        adapter: "grok-acp",
        bin: grok,
        args: ["agent", "stdio"],
        cwd: process.cwd(),
        env: { ...process.env }
      })
    );
    assert.ok(prepared.stdinPath, "Grok must use the Windows ACP stdin bridge");
    assert.match(prepared.env.GROK_HOME, /sandbox-home/);
    assert.ok(fs.existsSync(path.join(prepared.env.GROK_HOME, "auth.json")));

    child = spawn(prepared.bin, prepared.args, {
      cwd: process.cwd(),
      env: prepared.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const sessionResponse = await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(
        () => reject(new Error(`Grok session/new timed out: ${stderr}`)),
        20_000
      );
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        for (;;) {
          const newline = stdout.indexOf("\n");
          if (newline < 0) break;
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.id === 1) {
            assert.equal(message.result?.protocolVersion, 1);
            fs.appendFileSync(
              prepared.stdinPath,
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "session/new",
                params: { cwd: process.cwd(), mcpServers: [] }
              })}\n`
            );
          } else if (message.id === 2) {
            clearTimeout(timer);
            resolve(message);
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        reject(
          new Error(`Grok exited before session/new response (${code}): ${stderr}`)
        );
      });
      child.on("error", reject);
      fs.appendFileSync(
        prepared.stdinPath,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: { terminal: true, auth: { terminal: true } },
            clientInfo: { name: "freebuddy-smoke", version: "0.6.8" }
          }
        })}\n`
      );
    });
    assert.equal(sessionResponse.id, 2);
    assert.ok(
      sessionResponse.result?.sessionId,
      `Grok session/new failed: ${JSON.stringify(sessionResponse.error)}`
    );
    assert.equal(child.exitCode, null, "Grok must remain alive after session/new");
  } finally {
    if (child?.exitCode === null) child.kill();
    await new Promise((resolve) => setTimeout(resolve, 200));
    cleanupSandboxCommand();
    for (
      let attempt = 0;
      attempt < 100 && srt.SandboxManager.getConfig();
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    setDbForTest(null);
    db.close();
  }
});
