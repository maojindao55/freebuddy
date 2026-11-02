import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  docStudioUnwatch,
  docStudioWatchFile,
  DOCSTUDIO_WATCH_DEBOUNCE_MS,
  setDocStudioWatchSubscriberLookup
} from "../dist-electron/docStudioWatchers.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFakeSender(id) {
  const destroyedListeners = [];
  return {
    id,
    destroyedListeners,
    once(event, listener) {
      if (event === "destroyed") destroyedListeners.push(listener);
      return this;
    },
    destroy() {
      for (const listener of destroyedListeners.splice(0)) listener();
    }
  };
}

function makeFakeSubscriber(id) {
  const events = [];
  return {
    id,
    events,
    isDestroyed: () => false,
    send(channel, payload) {
      events.push({ channel, payload });
    }
  };
}

// Regression: the second window to subscribe to an already-watched file used
// to return before the destroyed hook was registered, so its id stayed in the
// subscriber set after its webContents died and the shared watcher never
// reached its last-subscriber cleanup.
test("every subscriber of a shared watcher gets a destroyed hook; destroying all senders closes the watcher", (t) => {
  const watchCalls = [];
  const fakeWatcher = {
    closeCount: 0,
    close() {
      this.closeCount += 1;
    },
    on() {}
  };
  t.mock.method(fs, "watch", (filePath, listener) => {
    watchCalls.push({ filePath, listener });
    return fakeWatcher;
  });
  const file = path.join(os.tmpdir(), "freebuddy-shared-watch.docx");

  const senderA = makeFakeSender(101);
  const senderB = makeFakeSender(102);

  // First subscriber arms the shared watcher.
  assert.equal(docStudioWatchFile(senderA, file), true);
  assert.equal(watchCalls.length, 1);
  assert.equal(senderA.destroyedListeners.length, 1);

  // Second window joins the SAME file: no second fs.watch, but it must still
  // get its own destroyed hook (this was the bug — it got none).
  assert.equal(docStudioWatchFile(senderB, file), true);
  assert.equal(watchCalls.length, 1, "the shared watcher is reused, not re-armed");
  assert.equal(senderB.destroyedListeners.length, 1, "joining subscriber gets a destroyed hook");

  // First window going away must not close the watcher: B still subscribes.
  senderA.destroy();
  assert.equal(fakeWatcher.closeCount, 0);

  // Both senders destroyed: the watcher closes and its entry is dropped —
  // a later subscriber re-arms a fresh watcher instead of joining a stale one.
  senderB.destroy();
  assert.equal(fakeWatcher.closeCount, 1, "watcher closed after the last subscriber died");

  const senderC = makeFakeSender(103);
  assert.equal(docStudioWatchFile(senderC, file), true);
  assert.equal(watchCalls.length, 2, "stale entry was cleaned up: a fresh watcher is armed");
  senderC.destroy();
  assert.equal(fakeWatcher.closeCount, 2);
});

test("a shared watcher fans changes out to exactly its subscribers and unwatch closes it at zero", async (t) => {
  const watchCalls = [];
  const fakeWatcher = {
    closeCount: 0,
    close() {
      this.closeCount += 1;
    },
    on() {}
  };
  t.mock.method(fs, "watch", (filePath, listener) => {
    watchCalls.push({ filePath, listener });
    return fakeWatcher;
  });

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "freebuddy-watchers-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "draft.docx");
  await fsp.writeFile(file, "x");

  const subscribers = new Map();
  const senderA = makeFakeSender(201);
  const senderB = makeFakeSender(202);
  for (const sender of [senderA, senderB]) {
    const subscriber = makeFakeSubscriber(sender.id);
    subscribers.set(sender.id, subscriber);
  }
  setDocStudioWatchSubscriberLookup((wcId) => subscribers.get(wcId));
  t.after(() => setDocStudioWatchSubscriberLookup(null));

  assert.equal(docStudioWatchFile(senderA, file), true);
  assert.equal(docStudioWatchFile(senderB, file), true);
  assert.equal(watchCalls.length, 1, "one shared watcher serves both panes");

  // Simulate an on-disk change: the debounced fan-out must reach both
  // subscribers and nothing else.
  watchCalls[0].listener("change");
  await sleep(DOCSTUDIO_WATCH_DEBOUNCE_MS + 150);
  const eventA = subscribers.get(201).events.at(-1);
  const eventB = subscribers.get(202).events.at(-1);
  assert.deepEqual(eventA, { channel: "docStudio:fileChanged", payload: { filePath: file } });
  assert.deepEqual(eventB, { channel: "docStudio:fileChanged", payload: { filePath: file } });

  // The first pane unsubscribing keeps the watcher alive for the second.
  docStudioUnwatch(201, file);
  assert.equal(fakeWatcher.closeCount, 0);
  docStudioUnwatch(202, file);
  assert.equal(fakeWatcher.closeCount, 1, "watcher closes when its last subscriber unsubscribes");
});
