import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  broadcastEvent,
  getEventBroadcasterCount,
  hasEventBroadcaster,
  subscribeEventBroadcaster
} from "../dist-electron/eventBus.js";

test("event bus delivers to independent subscriptions and cleans up idempotently", () => {
  const received = [];
  const unsubscribeFirst = subscribeEventBroadcaster((channel, payload) => {
    received.push(["first", channel, payload]);
  });
  const unsubscribeSecond = subscribeEventBroadcaster((channel, payload) => {
    received.push(["second", channel, payload]);
  });

  assert.equal(getEventBroadcasterCount(), 2);
  assert.equal(hasEventBroadcaster(), true);
  broadcastEvent("cli:event", { sequence: 1 });
  unsubscribeFirst();
  unsubscribeFirst();
  broadcastEvent("cli:event", { sequence: 2 });
  unsubscribeSecond();

  assert.deepEqual(received, [
    ["first", "cli:event", { sequence: 1 }],
    ["second", "cli:event", { sequence: 1 }],
    ["second", "cli:event", { sequence: 2 }]
  ]);
  assert.equal(getEventBroadcasterCount(), 0);
  assert.equal(hasEventBroadcaster(), false);
});

test("event bus isolates failures and defines mutation during broadcasts", () => {
  const received = [];
  let unsubscribeSecond;
  let unsubscribeLate;
  const unsubscribeFirst = subscribeEventBroadcaster(() => {
    received.push("first");
    unsubscribeSecond();
    unsubscribeLate ??= subscribeEventBroadcaster(() => received.push("late"));
  });
  unsubscribeSecond = subscribeEventBroadcaster(() => received.push("second"));
  const unsubscribeThrowing = subscribeEventBroadcaster(() => {
    throw new Error("listener failure");
  });
  const unsubscribeHealthy = subscribeEventBroadcaster(() => received.push("healthy"));

  broadcastEvent("cli:event", {});
  broadcastEvent("cli:event", {});

  unsubscribeFirst();
  unsubscribeThrowing();
  unsubscribeHealthy();
  unsubscribeLate();

  assert.deepEqual(received, ["first", "healthy", "first", "healthy", "late"]);
  assert.equal(getEventBroadcasterCount(), 0);
});

test("WebUI owns a disposable event bus subscription", () => {
  const source = fs.readFileSync(
    new URL("./webUIServer.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /subscribeEventBroadcaster/);
  assert.match(source, /unsubscribeWebUIEventBus\?\.\(\)/);
  assert.doesNotMatch(source, /setEventBroadcaster/);
});
