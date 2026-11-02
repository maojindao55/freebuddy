type FullscreenEvent = "enter-full-screen" | "leave-full-screen" | "closed";

export interface FullscreenWindow {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(fullscreen: boolean): void;
  on(event: FullscreenEvent, listener: () => void): unknown;
  off(event: FullscreenEvent, listener: () => void): unknown;
}

interface FullscreenQueue {
  tail: Promise<boolean>;
  pending: number;
  latestTarget: boolean;
  timedOut: boolean;
}

const queues = new WeakMap<FullscreenWindow, FullscreenQueue>();
const FULLSCREEN_TIMEOUT_MS = 5000;

function queueFor(win: FullscreenWindow): FullscreenQueue {
  const existing = queues.get(win);
  if (existing) return existing;
  const queue: FullscreenQueue = {
    tail: Promise.resolve(true), pending: 0, latestTarget: win.isFullScreen(), timedOut: false
  };
  queues.set(win, queue);
  // A native transition may finish after our timeout. Reconcile that late event
  // with the latest requested state rather than reviving a cancelled entry.
  const onNativeChange = () => {
    if (!queue.timedOut || win.isDestroyed()) return;
    if (win.isFullScreen() === queue.latestTarget) {
      queue.timedOut = false;
      return;
    }
    if (queue.pending) return;
    queue.timedOut = false;
    if (win.isFullScreen() !== queue.latestTarget) {
      void setWindowFullscreen(win, queue.latestTarget);
    }
  };
  const onClosed = () => {
    win.off("enter-full-screen", onNativeChange);
    win.off("leave-full-screen", onNativeChange);
    win.off("closed", onClosed);
    queues.delete(win);
  };
  win.on("enter-full-screen", onNativeChange);
  win.on("leave-full-screen", onNativeChange);
  win.on("closed", onClosed);
  return queue;
}

function transition(win: FullscreenWindow, target: boolean, queue: FullscreenQueue, timeoutMs: number): Promise<boolean> {
  if (win.isDestroyed()) return Promise.resolve(false);
  if (win.isFullScreen() === target) return Promise.resolve(true);
  return new Promise((resolve) => {
    const event: FullscreenEvent = target ? "enter-full-screen" : "leave-full-screen";
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.off(event, onTransition);
      win.off("closed", onClosed);
      resolve(success);
    };
    const onTransition = () => finish(!win.isDestroyed() && win.isFullScreen() === target);
    const onClosed = () => finish(false);
    const timer = setTimeout(() => {
      queue.timedOut = true;
      finish(!win.isDestroyed() && win.isFullScreen() === target);
    }, timeoutMs);
    win.on(event, onTransition);
    win.on("closed", onClosed);
    try {
      // On macOS this starts an animation. Only its native event completes the
      // request, so an immediately queued exit cannot be skipped as "already off".
      win.setFullScreen(target);
    } catch {
      finish(false);
    }
  });
}

/** Per-window serialization covers enter → immediate exit during native animation. */
export function setWindowFullscreen(
  win: FullscreenWindow,
  target: boolean,
  timeoutMs = FULLSCREEN_TIMEOUT_MS
): Promise<boolean> {
  if (win.isDestroyed()) return Promise.resolve(false);
  const queue = queueFor(win);
  queue.latestTarget = target;
  queue.pending += 1;
  const request = queue.tail.then(() => transition(win, target, queue, timeoutMs));
  queue.tail = request;
  void request.then(() => { queue.pending -= 1; });
  return request;
}

/** A new panel snapshots the state after any earlier queued restoration settles. */
export async function getWindowFullscreenState(win: FullscreenWindow): Promise<boolean> {
  await queues.get(win)?.tail;
  return !win.isDestroyed() && win.isFullScreen();
}
