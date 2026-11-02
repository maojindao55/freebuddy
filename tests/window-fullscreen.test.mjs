import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("../electron/shared/windowFullscreen.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText;
const { setWindowFullscreen, getWindowFullscreenState } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

class AnimatedWindow extends EventEmitter {
  fullscreen = false;
  destroyed = false;
  requests = [];
  constructor(fullscreen = false) { super(); this.fullscreen = fullscreen; }
  isDestroyed() { return this.destroyed; }
  isFullScreen() { return this.fullscreen; }
  setFullScreen(target) { this.requests.push(target); }
  finish(target) {
    this.fullscreen = target;
    this.emit(target ? "enter-full-screen" : "leave-full-screen");
  }
  close() { this.destroyed = true; this.emit("closed"); }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test("an immediate exit waits for native entry before requesting restoration", async () => {
  const win = new AnimatedWindow();
  let entered = false;
  const enter = setWindowFullscreen(win, true).then((result) => { entered = true; return result; });
  const exit = setWindowFullscreen(win, false);
  await flush();
  assert.deepEqual(win.requests, [true]);
  assert.equal(entered, false, "IPC must not acknowledge entry before the native event");
  assert.equal(win.isFullScreen(), false, "macOS may still report the old state during animation");
  win.finish(true);
  await flush();
  assert.deepEqual(win.requests, [true, false]);
  win.finish(false);
  assert.deepEqual(await Promise.all([enter, exit]), [true, true]);
  assert.equal(await getWindowFullscreenState(win), false);
  win.close();
});

test("an already fullscreen window is preserved without another native transition", async () => {
  const win = new AnimatedWindow(true);
  assert.equal(await getWindowFullscreenState(win), true);
  assert.equal(await setWindowFullscreen(win, true), true);
  assert.deepEqual(win.requests, []);
  assert.equal(win.isFullScreen(), true);
  win.close();
});

test("snapshot queries wait for an earlier queued restoration", async () => {
  const win = new AnimatedWindow(true);
  const exit = setWindowFullscreen(win, false);
  let snapshotFinished = false;
  const snapshot = getWindowFullscreenState(win).then((value) => { snapshotFinished = true; return value; });
  await flush();
  assert.equal(snapshotFinished, false);
  win.finish(false);
  assert.equal(await exit, true);
  assert.equal(await snapshot, false);
  win.close();
});

test("destroying a window settles both active and queued requests", async () => {
  const win = new AnimatedWindow();
  const enter = setWindowFullscreen(win, true);
  const exit = setWindowFullscreen(win, false);
  await flush();
  win.close();
  assert.deepEqual(await Promise.all([enter, exit]), [false, false]);
  assert.deepEqual(win.requests, [true]);
  assert.equal(win.listenerCount("enter-full-screen"), 0);
  assert.equal(win.listenerCount("leave-full-screen"), 0);
});

test("a missing native event times out and a late entry restores the newest target", async () => {
  const win = new AnimatedWindow();
  const enter = setWindowFullscreen(win, true, 20);
  const exit = setWindowFullscreen(win, false, 20);
  assert.deepEqual(await Promise.all([enter, exit]), [false, true]);
  assert.deepEqual(win.requests, [true]);
  // The timed-out native animation completes after the user returned to list.
  win.finish(true);
  await flush();
  assert.deepEqual(win.requests, [true, false]);
  win.finish(false);
  await flush();
  assert.equal(await getWindowFullscreenState(win), false);
  win.close();
});

test("native transitions in separate windows do not block each other", async () => {
  const first = new AnimatedWindow();
  const second = new AnimatedWindow();
  const one = setWindowFullscreen(first, true);
  const two = setWindowFullscreen(second, true);
  await flush();
  assert.deepEqual(first.requests, [true]);
  assert.deepEqual(second.requests, [true]);
  second.finish(true);
  assert.equal(await two, true);
  first.close();
  assert.equal(await one, false);
  second.close();
});
