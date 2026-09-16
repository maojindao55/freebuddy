/**
 * W3 resume/sequence unit tests.
 *
 * These prove the rules the pages will depend on, without any transport: the sequence gate is a
 * pure function of (host, seq, snapshot) plus the persistence seam, so it can be tested exactly.
 * The transport-facing half of the same rules lives in `admin-state.test.ts` (fake socket) and
 * `relay-resume.integration.test.ts` (real Go Relay).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createResumeManager } from "../miniprogram/services/resumeManager";
import {
  createMemoryResumeCursorStorage,
  sanitizeResumeCursorMap,
  type ResumeCursorMap
} from "../miniprogram/services/resumeCursorStorage";

const HOST = "host-1";
const OTHER = "host-2";

function primed(seq: number, storage = createMemoryResumeCursorStorage()) {
  const manager = createResumeManager({ storage });
  assert.equal(manager.applySnapshot(HOST, seq), true);
  return manager;
}

describe("sequence application", () => {
  test("consecutive sequences apply; a repeat is idempotent", () => {
    const manager = primed(10);
    assert.deepEqual(manager.observe(HOST, 11), { kind: "applied", hostId: HOST, seq: 11 });
    assert.deepEqual(manager.observe(HOST, 12), { kind: "applied", hostId: HOST, seq: 12 });

    const duplicate = manager.observe(HOST, 12);
    assert.equal(duplicate.kind, "duplicate");
    // The duplicate must not move the cursor: otherwise the next real event looks like a gap.
    assert.equal(manager.state(HOST).lastSeq, 12);
    assert.deepEqual(manager.observe(HOST, 13), { kind: "applied", hostId: HOST, seq: 13 });
    assert.equal(manager.state(HOST).duplicateCount, 1);
  });

  test("the snapshot baseline itself is a duplicate, not a gap", () => {
    const manager = primed(10);
    assert.equal(manager.observe(HOST, 10).kind, "duplicate");
    assert.equal(manager.needsSnapshot(HOST), false);
  });

  test("a gap blocks the stream until a snapshot arrives", () => {
    const manager = primed(10);
    const gap = manager.observe(HOST, 15);
    assert.deepEqual(gap, { kind: "gap", hostId: HOST, expected: 11, received: 15 });
    assert.equal(manager.needsSnapshot(HOST), true);
    assert.equal(manager.resumeFrom(HOST), null, "有缺口时不得用旧游标 resume");

    // Everything that follows is untrusted until the authoritative state lands.
    assert.equal(manager.observe(HOST, 16).kind, "awaiting_snapshot");
    assert.equal(manager.observe(HOST, 11).kind, "awaiting_snapshot");
    assert.equal(manager.state(HOST).lastSeq, 10, "缺口期间游标不得前进");

    assert.equal(manager.applySnapshot(HOST, 20), true);
    assert.equal(manager.needsSnapshot(HOST), false);
    assert.equal(manager.resumeFrom(HOST), 20);
    assert.deepEqual(manager.observe(HOST, 21), { kind: "applied", hostId: HOST, seq: 21 });
    assert.equal(manager.state(HOST).gapCount, 1);
  });

  test("invalid sequences are rejected without touching the cursor", () => {
    const manager = primed(10);
    for (const bad of ["11", -1, 1.5, null, undefined, Number.NaN]) {
      assert.equal(manager.observe(HOST, bad).kind, "invalid");
    }
    assert.equal(manager.state(HOST).lastSeq, 10);
  });
});

describe("cold start and materialization", () => {
  test("before any snapshot there is nothing to apply an event onto", () => {
    const manager = createResumeManager();
    assert.equal(manager.observe(HOST, 1).kind, "unprimed");
    assert.equal(manager.needsSnapshot(HOST), true);
    assert.equal(manager.resumeFrom(HOST), null, "冷启动必须走快照，不能用空游标 resume");
    assert.equal(manager.state(HOST).lastSeq, null);
  });

  test("a snapshot makes the cursor usable and the events after it apply", () => {
    const manager = createResumeManager();
    assert.equal(manager.resumeFrom(HOST), null);
    manager.applySnapshot(HOST, 0);
    assert.equal(manager.resumeFrom(HOST), 0);
    assert.equal(manager.observe(HOST, 1).kind, "applied");
    assert.equal(manager.resumeFrom(HOST), 1);
  });

  test("losing the entity cache withdraws the right to resume", () => {
    const manager = primed(10);
    assert.equal(manager.observe(HOST, 11).kind, "applied");
    const before = manager.state(HOST).lastSeq;

    manager.dematerialize(HOST);

    assert.equal(manager.resumeFrom(HOST), null, "游标没有可重建的实体支撑时不得 resume");
    assert.equal(manager.needsSnapshot(HOST), true);
    // The number is kept for diagnostics, but it no longer authorises anything.
    assert.equal(manager.state(HOST).lastSeq, before);
    assert.equal(manager.observe(HOST, 12).kind, "unprimed");
  });

  test("a snapshot is applied atomically: cursor and entities move together", () => {
    const manager = primed(10);
    assert.equal(manager.observe(HOST, 11).kind, "applied");
    manager.applySnapshot(HOST, 42);
    const state = manager.state(HOST);
    assert.equal(state.baseSeq, 42);
    assert.equal(state.lastSeq, 42);
    assert.equal(state.materialized, true);
    assert.equal(state.snapshotCount, 2);
  });
});

describe("stale and future cursors", () => {
  test("a sequence below the snapshot baseline means the host restarted", () => {
    const manager = primed(100);
    assert.equal(manager.observe(HOST, 99).kind, "stale");
    assert.equal(manager.needsSnapshot(HOST), true);
    assert.equal(manager.state(HOST).staleCount, 1);
  });

  test("a cursor ahead of the host is reset by the authoritative snapshot", () => {
    const storage = createMemoryResumeCursorStorage({ [HOST]: { baseSeq: 480, lastSeq: 500 } });
    // Simulated restart: the cursor survived, the entities did not.
    const restarted = createResumeManager({ storage });
    assert.equal(restarted.state(HOST).lastSeq, 500);
    assert.equal(restarted.resumeFrom(HOST), null, "只有游标没有实体时不得跳过初始快照");

    // The host's own sequence restarted near zero: the snapshot wins and the cursor follows.
    assert.equal(restarted.applySnapshot(HOST, 5), true);
    assert.equal(restarted.state(HOST).lastSeq, 5);
    assert.equal(restarted.resumeFrom(HOST), 5);
    assert.equal(restarted.observe(HOST, 6).kind, "applied");
  });

  test("an unusable snapshot leaves the previous state untouched", () => {
    const manager = primed(10);
    for (const bad of ["20", -3, null, undefined, 2.5]) {
      assert.equal(manager.applySnapshot(HOST, bad), false);
    }
    assert.equal(manager.state(HOST).baseSeq, 10);
    assert.equal(manager.needsSnapshot(HOST), false);
  });
});

describe("cursor persistence", () => {
  test("a snapshot persists the baseline; flush persists the applied cursor", () => {
    const storage = createMemoryResumeCursorStorage();
    const manager = createResumeManager({ storage });

    manager.applySnapshot(HOST, 30);
    assert.deepEqual(storage.snapshot(), { [HOST]: { baseSeq: 30, lastSeq: 30 } });

    manager.observe(HOST, 31);
    manager.observe(HOST, 32);
    assert.deepEqual(storage.snapshot()[HOST], { baseSeq: 30, lastSeq: 30 }, "未 flush 前不写盘");

    manager.flush();
    assert.deepEqual(storage.snapshot()[HOST], { baseSeq: 30, lastSeq: 32 });
  });

  test("a new manager loads the cursor but never as a resume permission", () => {
    const storage = createMemoryResumeCursorStorage();
    const first = createResumeManager({ storage });
    first.applySnapshot(HOST, 30);
    first.observe(HOST, 31);
    first.flush();

    const second = createResumeManager({ storage });
    assert.deepEqual(second.state(HOST).lastSeq, 31);
    assert.equal(second.state(HOST).materialized, false);
    assert.equal(second.resumeFrom(HOST), null);
    assert.equal(second.needsSnapshot(HOST), true);
    assert.equal(second.observe(HOST, 32).kind, "unprimed");
  });

  test("reset forgets one host and rewrites storage; reset() clears it", () => {
    const storage = createMemoryResumeCursorStorage();
    const manager = createResumeManager({ storage });
    manager.applySnapshot(HOST, 1);
    manager.applySnapshot(OTHER, 2);

    manager.reset(HOST);
    assert.equal(manager.state(HOST).lastSeq, null);
    assert.equal(manager.state(OTHER).lastSeq, 2, "其他主机的游标必须隔离保留");
    assert.deepEqual(Object.keys(storage.snapshot()), [OTHER]);

    manager.reset();
    assert.deepEqual(storage.snapshot(), {}, "注销/清理必须清掉持久化游标");
    assert.deepEqual(manager.states(), []);
  });

  test("host state is isolated", () => {
    const manager = createResumeManager();
    manager.applySnapshot(HOST, 10);
    manager.applySnapshot(OTHER, 100);
    assert.equal(manager.observe(HOST, 11).kind, "applied");
    assert.equal(manager.observe(OTHER, 11).kind, "stale");
    assert.equal(manager.resumeFrom(HOST), 11);
    // The stale event only poisons the host it arrived for.
    assert.equal(manager.resumeFrom(OTHER), null);
    assert.equal(manager.needsSnapshot(OTHER), true);
  });

  test("drifted or hostile storage is sanitised, never trusted", () => {
    const cleaned = sanitizeResumeCursorMap({
      [HOST]: { baseSeq: 1, lastSeq: 2 },
      bad: { baseSeq: "3", lastSeq: -1 },
      worse: "not an object",
      extra: { baseSeq: 4, lastSeq: 5, accessToken: "secret" }
    } as unknown as ResumeCursorMap);

    assert.deepEqual(cleaned, {
      [HOST]: { baseSeq: 1, lastSeq: 2 },
      bad: { baseSeq: null, lastSeq: null },
      extra: { baseSeq: 4, lastSeq: 5 }
    });
    assert.deepEqual(sanitizeResumeCursorMap("nope"), {});
    assert.deepEqual(sanitizeResumeCursorMap(null), {});

    const storage = createMemoryResumeCursorStorage(cleaned);
    const manager = createResumeManager({ storage });
    assert.equal(manager.resumeFrom("extra"), null);
    assert.equal(manager.state("extra").lastSeq, 5);
  });
});
