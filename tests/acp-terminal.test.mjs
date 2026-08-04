import test from "node:test";
import assert from "node:assert/strict";

import {
  createAcpTerminalManager,
  MAX_TERMINAL_OUTPUT_BYTES
} from "../dist-electron/cli/acpTerminal.js";

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
