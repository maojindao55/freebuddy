import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AcpProcessPool } from "../dist-electron/cli/acpProcessPool.js";

function connection(conversationId = "chat") {
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, signalCode: null });
  const c = { child, conversationId, fingerprint: "command", sessionId: "native-session", requestId: 10, disposals: 0,
    dispose: () => { c.disposals++; } };
  return c;
}

test("warm checkout preserves the process and request sequence, with no idle listeners left", () => {
  const pool = new AcpProcessPool();
  const c = connection();
  pool.put("owner/chat/agent", c);
  assert.equal(pool.take("owner/chat/agent", "command", "native-session"), c);
  assert.equal(c.requestId, 10);
  assert.equal(c.child.listenerCount("close"), 0);
  assert.equal(c.child.listenerCount("error"), 0);
  assert.equal(pool.take("different-owner/chat/agent", "command", "native-session"), undefined);
  pool.dispose();
  assert.equal(c.disposals, 0); // The active lease is owned by its run.
});

test("configuration, session reset and dead connections invalidate the warm process", () => {
  for (const mode of ["config", "session", "reset", "exit", "stdin"]) {
    const pool = new AcpProcessPool();
    const c = connection(); pool.put("key", c);
    if (mode === "exit") c.child.exitCode = 1;
    if (mode === "stdin") c.child.stdin.end();
    assert.equal(pool.take("key", mode === "config" ? "changed" : "command",
      mode === "reset" ? undefined : mode === "session" ? "another" : "native-session"), undefined);
    assert.equal(c.disposals, 1);
    pool.dispose();
  }
});

test("idle crash, LRU bound, conversation deletion and shutdown dispose connections", () => {
  const pool = new AcpProcessPool(60_000, 2);
  const a = connection("a"), b = connection("b"), c = connection("c");
  pool.put("a", a); pool.put("b", b); pool.put("c", c);
  assert.equal(a.disposals, 1);
  b.child.emit("close", 1);
  assert.equal(b.disposals, 1);
  pool.closeConversation("c");
  assert.equal(c.disposals, 1);
  pool.put("new", connection());
  pool.dispose();
  assert.equal(pool.take("new", "command", "native-session"), undefined);
});

test("idle timeout releases its process and tools", async () => {
  const pool = new AcpProcessPool(10);
  const c = connection(); pool.put("key", c);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(c.disposals, 1);
  assert.equal(pool.take("key", "command", "native-session"), undefined);
});
