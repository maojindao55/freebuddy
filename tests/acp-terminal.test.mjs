import test from "node:test";
import assert from "node:assert/strict";
import { resolveWindowsPowerShell } from "../dist-electron/cli/windowsEnv.js";

import {
  createAcpTerminalManager,
  MAX_TERMINAL_OUTPUT_BYTES
} from "../dist-electron/cli/acpTerminal.js";

test("terminal commands inherit noninteractive Git policy even if requested env enables prompts", async t => {
  const manager = createAcpTerminalManager({});
  t.after(() => manager.dispose());
  const { terminalId } = await manager.create({ sessionId: "env", command: process.execPath,
    args: ["-e", "console.log(JSON.stringify([process.env.GCM_INTERACTIVE,process.env.GIT_TERMINAL_PROMPT]))"],
    env: [{ name: "GCM_INTERACTIVE", value: "true" }, { name: "GIT_TERMINAL_PROMPT", value: "1" }] });
  assert.equal((await manager.waitForExit(terminalId)).exitCode, 0);
  assert.deepEqual(JSON.parse(manager.output(terminalId).output.trim()), ["0", "0"]);
});

test("PowerShell missing mandatory arguments return an error without waiting for input", { skip: process.platform !== "win32", timeout: 10000 }, async t => {
  const manager = createAcpTerminalManager({});
  t.after(() => manager.dispose());
  const { terminalId } = await manager.create({ sessionId: "powershell", command: resolveWindowsPowerShell(process.env),
    // PowerShell 7's default ConciseView omits the error identifier.
    args: ["-NoProfile", "-Command", "$ErrorView = 'NormalView'; Test-Path"] });
  assert.notEqual((await manager.waitForExit(terminalId)).exitCode, 0);
  assert.match(manager.output(terminalId).output, /MissingMandatoryParameter|NonInteractive/);
});

test("Windows terminal cancellation reaps grandchildren and releases exit waiters", { skip: process.platform !== "win32", timeout: 10000 }, async t => {
  const manager = createAcpTerminalManager({});
  let descendant;
  t.after(() => {
    manager.dispose();
    if (descendant) { try { process.kill(descendant); } catch { /* already reaped */ } }
  });
  const { terminalId } = await manager.create({ sessionId: "tree", command: process.execPath,
    args: ["-e", "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});console.log(child.pid);setInterval(()=>{},1000)"] });
  for (let tries = 0; tries < 100; tries++) {
    const match = manager.output(terminalId).output.match(/\d+/);
    if (match) { descendant = Number(match[0]); break; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(descendant, "descendant started");
  const waiting = manager.waitForExit(terminalId);
  manager.kill(terminalId);
  await waiting;
  assert.equal(manager.output(terminalId).exited, true);
  assert.throws(() => process.kill(descendant, 0), /ESRCH/);
});

test("terminal manager streams output and reports exit status", async () => {
  const events = [];
  const manager = createAcpTerminalManager({
    onOutput: (terminalId, snap) => {
      events.push({ terminalId, ...snap });
    }
  });

  const { terminalId } = await manager.create({
    sessionId: "sess-1",
    command: process.platform === "win32" ? "cmd" : "sh",
    args:
      process.platform === "win32"
        ? ["/c", "echo hello&& exit 0"]
        : ["-c", "printf 'hello\\n'; exit 0"]
  });

  const exit = await manager.waitForExit(terminalId);
  const snap = manager.output(terminalId);

  assert.equal(exit.exitCode, 0);
  assert.match(snap.output, /hello/);
  assert.equal(snap.exited, true);
  assert.ok(events.some((event) => event.terminalId === terminalId && /hello/.test(event.output)));

  manager.release(terminalId);
});

test("terminal manager enforces output byte limits", async () => {
  const manager = createAcpTerminalManager({});
  const { terminalId } = await manager.create({
    sessionId: "sess-2",
    command: process.execPath,
    args: ["-e", "process.stdout.write('prefix-' + 'x'.repeat(200) + '-tail')"],
    outputByteLimit: 32
  });

  await manager.waitForExit(terminalId);
  const snap = manager.output(terminalId);

  assert.equal(snap.truncated, true);
  assert.ok(Buffer.byteLength(snap.output, "utf8") <= 32);
  assert.match(snap.output, /-tail$/);
  assert.doesNotMatch(snap.output, /^prefix-/);

  manager.release(terminalId);
});

test("terminal manager caps agent-requested output limits", async () => {
  const manager = createAcpTerminalManager({});
  const { terminalId } = await manager.create({
    sessionId: "sess-hard-cap",
    command: process.execPath,
    args: [
      "-e",
      `process.stdout.write('head-' + 'x'.repeat(${MAX_TERMINAL_OUTPUT_BYTES + 1024}) + '-tail')`
    ],
    outputByteLimit: MAX_TERMINAL_OUTPUT_BYTES * 8
  });

  await manager.waitForExit(terminalId);
  const snap = manager.output(terminalId);

  assert.equal(snap.truncated, true);
  assert.ok(
    Buffer.byteLength(snap.output, "utf8") <= MAX_TERMINAL_OUTPUT_BYTES
  );
  assert.match(snap.output, /-tail$/);

  manager.release(terminalId);
});

test("terminal manager truncates UTF-8 output at character boundaries", async () => {
  const manager = createAcpTerminalManager({});
  const { terminalId } = await manager.create({
    sessionId: "sess-3",
    command: process.execPath,
    args: ["-e", "process.stdout.write('前缀内容🙂最终')"],
    outputByteLimit: 10
  });

  await manager.waitForExit(terminalId);
  const snap = manager.output(terminalId);

  assert.equal(snap.truncated, true);
  assert.ok(Buffer.byteLength(snap.output, "utf8") <= 10);
  assert.match(snap.output, /最终$/);
  assert.doesNotMatch(snap.output, /�/);

  manager.release(terminalId);
});

test(
  "terminal manager executes adapter-provided shell command lines",
  { skip: process.platform === "win32" },
  async () => {
    let preparedInput;
    const manager = createAcpTerminalManager({
      commandIsShellLine: true,
      prepareSpawn: async (input) => {
        preparedInput = input;
        return input;
      }
    });
    const { terminalId } = await manager.create({
      sessionId: "sess-shell-line",
      command: `/bin/bash -lc 'printf "%s" "$PWD"; printf ":%s" "quoted value"'`
    });

    const exit = await manager.waitForExit(terminalId);
    const snap = manager.output(terminalId);

    assert.equal(exit.exitCode, 0);
    assert.equal(preparedInput.command, "/bin/sh");
    assert.deepEqual(preparedInput.args, [
      "-c",
      `/bin/bash -lc 'printf "%s" "$PWD"; printf ":%s" "quoted value"'`
    ]);
    assert.match(snap.output, /:quoted value$/);

    manager.release(terminalId);
  }
);

test(
  "terminal manager auto-routes whitespace command lines through the shell",
  { skip: process.platform === "win32" },
  async () => {
    // CodeBuddy-style request: a full command line in `command` with no
    // `args` and no commandIsShellLine flag. Without the heuristic this would
    // spawn the literal string "printf codebuddy-shell-line" (ENOENT).
    const manager = createAcpTerminalManager({});
    const { terminalId } = await manager.create({
      sessionId: "sess-codebuddy-shell-line",
      command: `printf '%s' "codebuddy-shell-line"`
    });

    const exit = await manager.waitForExit(terminalId);
    const snap = manager.output(terminalId);

    assert.equal(exit.exitCode, 0);
    assert.equal(snap.output, "codebuddy-shell-line");

    manager.release(terminalId);
  }
);

test("terminal manager surfaces spawn failures instead of silent exit 1", async () => {
  const errors = [];
  const manager = createAcpTerminalManager({
    onSpawnError: (info) => errors.push(info)
  });
  // A single nonexistent binary (no whitespace) so the heuristic does not kick
  // in; cross-spawn emits "error" (ENOENT) which must be captured.
  const { terminalId } = await manager.create({
    sessionId: "sess-spawn-error",
    command: "/definitely/not/a/real/binary-freebuddy-0xCAFEBABE",
    args: []
  });

  const exit = await manager.waitForExit(terminalId);
  const snap = manager.output(terminalId);

  assert.equal(exit.exitCode, 1);
  assert.match(snap.output, /terminal spawn failed/i);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /ENOENT|not found|spawn/i);

  manager.release(terminalId);
});
