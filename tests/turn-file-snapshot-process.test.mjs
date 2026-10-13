import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
const { SnapshotScanClient } = await import("../dist-electron/cli/turnFileSnapshotProcess.js");
const { DEFAULT_LIMITS, SNAPSHOT_BATCH_ENTRIES, SNAPSHOT_BATCH_BYTES } = await import("../dist-electron/cli/turnFileSnapshotScan.js");
const workerEntry = fileURLToPath(new URL("../dist-electron/cli/turnFileSnapshotWorker.js", import.meta.url));

function launchNodeWorker(children, diagnostics) {
  const child = fork(workerEntry, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced", execArgv: [] });
  children.push(child);
  const state = { pid: child.pid, messages: 0, lastMessage: undefined, stderr: "" };
  diagnostics.push(state);
  child.stderr.on("data", chunk => { state.stderr = (state.stderr + chunk.toString("utf8")).slice(-4096); });
  child.on("message", message => { state.messages++; state.lastMessage = message?.kind; });
  child.on("exit", (code, signal) => { state.exitCode = code; state.signal = signal; });
  return {
    send: message => child.send(message),
    onMessage(handler) { child.on("message", handler); return () => child.off("message", handler); },
    onExit(handler) { child.on("exit", handler); return () => child.off("exit", handler); },
    onError(handler) { child.on("error", handler); return () => child.off("error", handler); },
    kill: () => child.kill()
  };
}
function fakeWorker(onSend) {
  const events = new EventEmitter();
  const worker = {
    sends: [], killed: false,
    send(message) { worker.sends.push(message); onSend?.(message, events); },
    onMessage(handler) { events.on("message", handler); return () => events.off("message", handler); },
    onExit(handler) { events.on("exit", handler); return () => events.off("exit", handler); },
    onError(handler) { events.on("error", handler); return () => events.off("error", handler); },
    kill() { worker.killed = true; queueMicrotask(() => events.emit("exit", 1)); }
  };
  queueMicrotask(() => events.emit("message", { kind: "ready" }));
  return worker;
}
const request = (root = "/project") => ({ phase: "before", roots: [{ path: root, complete: false }], owner: "alice", complete: true,
  limits: { ...DEFAULT_LIMITS, milliseconds: 10000 } });

// Three scans run in sequence, each allowing 10s plus the client's 5s grace.
// The test's wall-clock timeout must cover all three, setup and worker teardown.
test("a separate process captures bounded UTF-8 batches, waits for persistence and is reused", { timeout: 60000 }, async t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-snapshot-process-"));
  // Windows TEMP may use an 8.3 path. Match the native realpath used by the
  // production capture preparation and the worker's workspace boundary checks.
  const root = await fs.promises.realpath(temporaryRoot);
  const syncRoot = fs.realpathSync(temporaryRoot);
  if (syncRoot !== root) t.diagnostic(`Canonical test root: sync=${syncRoot}; native=${root}`);
  const children = [], diagnostics = [];
  let phase = "fixture setup", finished = false, release;
  const client = new SnapshotScanClient(() => launchNodeWorker(children, diagnostics));
  t.after(async () => {
    release?.();
    const exits = children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise(resolve => child.once("exit", resolve)));
    client.dispose(); await Promise.all(exits);
    if (!finished) t.diagnostic(`Snapshot phase: ${phase}; workers: ${JSON.stringify(diagnostics)}`);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let index = 0; index < 80; index++) fs.writeFileSync(path.join(root, `${index}.md`), `# 文件 ${index}\n` + "内容\n".repeat(9000));
  const before = [], packets = [];
  let capturedRoots, announce;
  const holding = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { announce = resolve; });
  let blocked = false, callbackCount = 0, ticks = 0;
  const timer = setInterval(() => ticks++, 1); t.after(() => clearInterval(timer));
  const first = client.run(request(root), async event => {
    callbackCount++;
    if (event.kind === "roots") { capturedRoots = event.roots; return; }
    if (!blocked) { blocked = true; announce(); await holding; }
    packets.push(event.entries);
    before.push(...event.entries.map(entry => ({ path: entry.path, identity: entry.identity, before_version: JSON.stringify(entry.before) })));
    for (const entry of event.entries) assert.equal(Buffer.from(entry.body).toString("utf8"), fs.readFileSync(entry.path, "utf8"));
  });
  phase = "waiting for first batch";
  await Promise.race([arrived, first.then(() => { throw new Error("Snapshot scan completed without producing a batch"); })]);
  phase = "checking persistence backpressure";
  const callbacksWhileBlocked = callbackCount;
  const secondEvents = [];
  const second = client.run(request(root), event => secondEvents.push(event));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(callbackCount, callbacksWhileBlocked, "worker cannot outrun persistence acknowledgements");
  assert.equal(secondEvents.length, 0, "another job waits for the active scan");
  phase = "completing initial and queued scans";
  release(); assert.equal(await first, true); assert.equal(await second, true);
  assert.equal(children.length, 1); assert.notEqual(children[0].pid, process.pid);
  assert.equal(before.length, 80); assert.ok(packets.length > 1); assert.ok(ticks > 0);
  for (const entries of packets) {
    assert.ok(entries.length <= SNAPSHOT_BATCH_ENTRIES);
    assert.ok(entries.reduce((bytes, entry) => bytes + entry.body.byteLength, 0) <= SNAPSHOT_BATCH_BYTES);
  }
  fs.appendFileSync(path.join(root, "0.md"), "最后修改\n");
  const ending = [];
  phase = "capturing ending versions";
  const complete = await client.run({ ...request(root), phase: "after", roots: capturedRoots, before }, event => {
    if (event.kind === "batch") ending.push(...event.entries);
  });
  assert.equal(complete, true); assert.equal(ending.filter(entry => !entry.same).length, 1);
  assert.ok(ending.filter(entry => entry.same).every(entry => entry.body === undefined));
  assert.equal(Buffer.from(ending.find(entry => !entry.same).body).toString("utf8"), fs.readFileSync(path.join(root, "0.md"), "utf8"));
  finished = true;
});

test("worker exit rejects the scan and the next job starts a fresh process", async t => {
  const workers = [];
  const client = new SnapshotScanClient(() => {
    const fail = workers.length === 0;
    const worker = fakeWorker((message, events) => {
      if (message.kind !== "scan") return;
      queueMicrotask(() => fail ? events.emit("exit", 9) : events.emit("message", { kind: "done", id: message.id, complete: false }));
    });
    workers.push(worker); return worker;
  });
  t.after(() => client.dispose());
  await assert.rejects(client.run(request(), () => {}), /exited \(9\)/);
  assert.equal(await client.run(request(), () => {}), false); assert.equal(workers.length, 2);
});

test("hung workers have a hard timeout and cannot deliver stale capture batches", async t => {
  let worker;
  const client = new SnapshotScanClient(() => worker = fakeWorker(), 30);
  t.after(() => client.dispose());
  await assert.rejects(client.run({ ...request(), limits: { ...DEFAULT_LIMITS, milliseconds: 0 } }, () => assert.fail("no batches expected")), /timed out/);
  assert.equal(worker.killed, true);
});

test("failed persistence kills the scan without acknowledging or publishing completion", async t => {
  let worker;
  const client = new SnapshotScanClient(() => worker = fakeWorker((message, events) => {
    if (message.kind === "scan") queueMicrotask(() => events.emit("message", { kind: "batch", id: message.id, entries: [] }));
  }));
  t.after(() => client.dispose());
  await assert.rejects(client.run(request(), () => { throw new Error("database unavailable"); }), /database unavailable/);
  assert.equal(worker.killed, true); assert.equal(worker.sends.some(message => message.kind === "ack"), false);
});

test("invalid worker batches cannot reach the database consumer", async t => {
  const client = new SnapshotScanClient(() => fakeWorker((message, events) => {
    if (message.kind === "scan") queueMicrotask(() => events.emit("message", { kind: "roots", id: message.id, roots: null }));
  }));
  t.after(() => client.dispose());
  await assert.rejects(client.run(request(), () => assert.fail("invalid roots cannot be consumed")), /Invalid file capture batch/);
});

test("shutdown rejects queued scans instead of restarting the capture process", async () => {
  let worker, launched = 0, started;
  const start = new Promise(resolve => { started = resolve; });
  const client = new SnapshotScanClient(() => {
    launched++; return worker = fakeWorker(message => { if (message.kind === "scan") started(); });
  });
  const first = client.run(request(), () => {});
  const queued = client.run(request(), () => {});
  const rejected = [assert.rejects(first, /exited/), assert.rejects(queued, /shutting down/)];
  await start; client.dispose(); await Promise.all(rejected);
  assert.equal(worker.killed, true); assert.equal(launched, 1);
});
