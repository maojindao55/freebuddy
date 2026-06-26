import { create } from "zustand";

import { cliClient } from "@/services/cli/client";

export interface DraftPreviewEntry {
  cwd: string;
  /** Auto-detected entry relative path (e.g. "index.html"). null if none. */
  entryRel: string | null;
  /** User-overridden entry relative path; takes precedence over entryRel. */
  manualEntry?: string;
  /** Entry resolution finished (entry may still be null). */
  ready: boolean;
  /** Bumped to force the iframe to reload (url embeds it). */
  reloadNonce: number;
  /** Fully composed freebuddy-draft:// url, empty when no entry. */
  url: string;
}

interface DraftPreviewState {
  byConv: Record<string, DraftPreviewEntry>;
  timers: Record<string, ReturnType<typeof setTimeout>>;
  ensureFor(convId: string, cwd: string | undefined): Promise<void>;
  setManualEntry(convId: string, rel: string): void;
  reload(convId: string): void;
  scheduleReload(convId: string, delay?: number): void;
}

function composeUrl(
  cwd: string,
  entryRel: string | null | undefined,
  nonce: number
): string {
  if (!cwd || !entryRel) return "";
  const rel = entryRel.split("/").map(encodeURIComponent).join("/");
  return `freebuddy-draft://render/${rel}?root=${encodeURIComponent(cwd)}&v=${nonce}`;
}

function entryOf(entry: DraftPreviewEntry | undefined): string | null | undefined {
  if (!entry) return null;
  return entry.manualEntry ?? entry.entryRel;
}

export const useDraftPreviewStore = create<DraftPreviewState>((set, get) => ({
  byConv: {},
  timers: {},

  async ensureFor(convId, cwd) {
    if (!cwd) {
      set((s) => ({
        byConv: {
          ...s.byConv,
          [convId]: { cwd: "", entryRel: null, ready: true, reloadNonce: 0, url: "" }
        }
      }));
      return;
    }
    const prev = get().byConv[convId];
    if (prev && prev.cwd === cwd && prev.ready) return;
    let entryRel: string | null = null;
    try {
      if (cliClient.isAvailable()) {
        entryRel = await cliClient.resolveDraftEntry(cwd);
      }
    } catch {
      entryRel = null;
    }
    set((s) => {
      const existing = s.byConv[convId];
      const manualEntry = existing?.manualEntry;
      return {
        byConv: {
          ...s.byConv,
          [convId]: {
            cwd,
            entryRel,
            manualEntry,
            ready: true,
            reloadNonce: existing?.reloadNonce ?? 0,
            url: composeUrl(cwd, manualEntry ?? entryRel, existing?.reloadNonce ?? 0)
          }
        }
      };
    });
  },

  setManualEntry(convId, rel) {
    set((s) => {
      const entry = s.byConv[convId];
      const cwd = entry?.cwd ?? "";
      const nonce = (entry?.reloadNonce ?? 0) + 1;
      return {
        byConv: {
          ...s.byConv,
          [convId]: {
            cwd,
            entryRel: entry?.entryRel ?? null,
            manualEntry: rel,
            ready: true,
            reloadNonce: nonce,
            url: composeUrl(cwd, rel, nonce)
          }
        }
      };
    });
  },

  reload(convId) {
    set((s) => {
      const entry = s.byConv[convId];
      if (!entry || !entry.url) return s;
      const nonce = entry.reloadNonce + 1;
      return {
        byConv: {
          ...s.byConv,
          [convId]: {
            ...entry,
            reloadNonce: nonce,
            url: composeUrl(entry.cwd, entryOf(entry), nonce)
          }
        }
      };
    });
  },

  scheduleReload(convId, delay = 300) {
    const timers = get().timers;
    if (timers[convId]) clearTimeout(timers[convId]);
    const t = setTimeout(() => {
      set((s) => {
        const next = { ...s.timers };
        delete next[convId];
        return { timers: next };
      });
      get().reload(convId);
    }, delay);
    set((s) => ({ timers: { ...s.timers, [convId]: t } }));
  }
}));
