// Shared per-file watchers for the DocStudio live-reload feature. One fs.watch
// per file fans out to exactly the webContents that subscribed to it, so each
// renderer only learns about files it explicitly watches — changes are never
// broadcast to every DocStudio-capable renderer.
//
// Keep this module Electron-free (mirroring docStudioWindowRegistry): the
// watcher lifecycle is exercised by plain Node tests with a mocked fs.watch
// and fake senders; the bridge injects the real webContents lookup.
import fs from "node:fs";
import { stat } from "node:fs/promises";

export interface DocStudioWatchSender {
  id: number;
  once(event: "destroyed", listener: () => void): unknown;
}

interface DocStudioWatchSubscriber {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

type DocStudioSubscriberLookup = (wcId: number) => DocStudioWatchSubscriber | undefined;

interface DocStudioWatchEntry {
  watcher: fs.FSWatcher;
  timer?: NodeJS.Timeout;
  needsRearm: boolean;
  subscribers: Set<number>;
}

const docStudioWatchers = new Map<string, DocStudioWatchEntry>();
const docStudioWatchersWithDestroyHook = new WeakSet<DocStudioWatchSender>();
export const DOCSTUDIO_WATCH_DEBOUNCE_MS = 300;
const DOCSTUDIO_FILE_CHANGED_CHANNEL = "docStudio:fileChanged";

let subscriberLookup: DocStudioSubscriberLookup | null = null;

export function setDocStudioWatchSubscriberLookup(lookup: DocStudioSubscriberLookup | null): void {
  subscriberLookup = lookup;
}

function docStudioNotifySubscribers(filePath: string): void {
  const entry = docStudioWatchers.get(filePath);
  if (!entry || !subscriberLookup) return;
  for (const wcId of entry.subscribers) {
    const subscriber = subscriberLookup(wcId);
    if (subscriber && !subscriber.isDestroyed()) {
      subscriber.send(DOCSTUDIO_FILE_CHANGED_CHANNEL, { filePath });
    }
  }
}

function docStudioCloseWatcher(filePath: string): void {
  const entry = docStudioWatchers.get(filePath);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  try {
    entry.watcher.close();
  } catch {
    /* already closed */
  }
  docStudioWatchers.delete(filePath);
}

export function docStudioUnwatch(wcId: number, filePath: string): void {
  const entry = docStudioWatchers.get(filePath);
  if (!entry) return;
  entry.subscribers.delete(wcId);
  if (entry.subscribers.size === 0) docStudioCloseWatcher(filePath);
}

function docStudioUnwatchAll(wcId: number): void {
  for (const filePath of [...docStudioWatchers.keys()]) docStudioUnwatch(wcId, filePath);
}

export function docStudioWatchFile(sender: DocStudioWatchSender, filePath: string): boolean {
  const wcId = sender.id;
  // Clean up this sender's subscriptions whenever its webContents goes away,
  // mirroring the lifetime of watchFile/unwatchFile registration. This must
  // happen for EVERY subscriber — including one that joins an existing
  // watcher: the join path used to return first, so a second window sharing
  // an already-watched file never got a destroyed hook, its id stayed in the
  // subscriber set after its webContents died and the watcher never reached
  // its last-subscriber cleanup.
  if (!docStudioWatchersWithDestroyHook.has(sender)) {
    docStudioWatchersWithDestroyHook.add(sender);
    sender.once("destroyed", () => docStudioUnwatchAll(wcId));
  }
  const existing = docStudioWatchers.get(filePath);
  if (existing) {
    existing.subscribers.add(wcId);
    return true;
  }
  const entry: DocStudioWatchEntry = {
    watcher: undefined as never,
    needsRearm: false,
    subscribers: new Set([wcId])
  };
  docStudioWatchers.set(filePath, entry);
  const arm = () => {
    const live = docStudioWatchers.get(filePath);
    if (!live) return;
    try {
      live.watcher = fs.watch(filePath, (eventType) => {
        const current = docStudioWatchers.get(filePath);
        if (!current) return;
        if (eventType === "rename") current.needsRearm = true;
        if (current.timer) clearTimeout(current.timer);
        current.timer = setTimeout(() => {
          void (async () => {
            try {
              await stat(filePath);
              docStudioNotifySubscribers(filePath);
            } catch {
              /* file may be gone */
            }
          })();
          if (current.needsRearm) {
            current.needsRearm = false;
            try {
              current.watcher.close();
            } catch {
              /* already closed */
            }
            arm();
          }
        }, DOCSTUDIO_WATCH_DEBOUNCE_MS);
      });
      live.watcher.on("error", () => {});
    } catch {
      // The path vanished between registration and watch: drop the entry so a
      // later watchFile call re-arms it.
      docStudioWatchers.delete(filePath);
    }
  };
  arm();
  return true;
}
