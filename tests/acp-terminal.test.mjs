import test from "node:test";
import assert from "node:assert/strict";

import { createAcpTerminalManager } from "../dist-electron/cli/acpTerminal.js";

test("terminal manager streams output and reports exit status", async () => {
  const events = [];
  const manager = createAcpTerminalManager({
    onOutput: (terminalId, snap) => {
      events.push({ terminalId, ...snap });
    }
  });

  const { terminalId } = manager.create({
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
  const { terminalId } = manager.create({
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

test("terminal manager truncates UTF-8 output at character boundaries", async () => {
  const manager = createAcpTerminalManager({});
  const { terminalId } = manager.create({
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
