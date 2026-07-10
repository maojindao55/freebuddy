import { create } from "zustand";

import type { DraftLoadState } from "@/services/cli/types";

export interface DraftPreviewEntry {
  cwd: string;
  /** User/agent-set preview target: relative path, local file, or HTTP(S) URL. */
  manualEntry?: string;
  /** Entry resolution finished. */
  ready: boolean;
  /** Bumped to force the iframe to reload (url embeds it). */
  reloadNonce: number;
  /** Fully composed preview url, empty when no target. */
  url: string;
  /** Renderer-observed load state used by the Draft MCP tool. */
  loadState: DraftLoadState;
  error?: string;
  updatedAt: string;
}

interface DraftPreviewState {
  byConv: Record<string, DraftPreviewEntry>;
  timers: Record<string, ReturnType<typeof setTimeout>>;
  ensureFor(convId: string, cwd: string | undefined): Promise<void>;
  setManualEntry(convId: string, rel: string): void;
  setPreviewTarget(convId: string, target: string): void;
  clearManualEntry(convId: string): void;
  reload(convId: string): void;
  scheduleReload(convId: string, delay?: number): void;
  setLoadState(convId: string, state: DraftLoadState, error?: string): void;
}

const LOCAL_PREVIEW_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "avif",
  "bmp",
  "pdf"
]);

function withDraftNonce(target: string, nonce: number): string {
  const url = new URL(target);
  url.searchParams.set("freebuddyDraft", String(nonce));
  return url.toString();
}

function shouldKeepRemoteUrlExact(target: string): boolean {
  try {
    return new URL(target).hostname === "mp.weixin.qq.com";
  } catch {
    return false;
  }
}

function localFileExtension(target: string): string {
  return target.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
}

function isAbsoluteLocalPreviewTarget(target: string): boolean {
  if (!/^([A-Za-z]:[\\/]|\/)/.test(target)) return false;
  return LOCAL_PREVIEW_EXTENSIONS.has(localFileExtension(target));
}

function filePreviewUrl(target: string, nonce: number): string {
  const normalized = target.trim().replace(/\\/g, "/");
  const url = new URL("freebuddy-file://open");
  url.searchParams.set("path", normalized);
  url.searchParams.set("freebuddyDraft", String(nonce));
  return url.toString();
}

export function composeDraftPreviewUrl(
  cwd: string,
  target: string | null | undefined,
  nonce: number
): string {
  if (!target) return "";
  if (/^https?:\/\//i.test(target)) {
    if (shouldKeepRemoteUrlExact(target)) return target;
    return withDraftNonce(target, nonce);
  }
  if (/^freebuddy-file:\/\//i.test(target)) {
    return withDraftNonce(target, nonce);
  }
  if (isAbsoluteLocalPreviewTarget(target)) {
    return filePreviewUrl(target, nonce);
  }
  if (!cwd) return "";
  const rel = target.split("/").map(encodeURIComponent).join("/");
  return `freebuddy-draft://render/${encodeURIComponent(cwd)}/${rel}?v=${nonce}`;
}

function entryOf(entry: DraftPreviewEntry | undefined): string | null | undefined {
  if (!entry) return null;
  return entry.manualEntry;
}

export const useDraftPreviewStore = create<DraftPreviewState>((set, get) => ({
  byConv: {},
  timers: {},

  async ensureFor(convId, cwd) {
    const prev = get().byConv[convId];
    if (prev && prev.cwd === (cwd ?? "") && prev.ready) return;
    set((s) => {
      const existing = s.byConv[convId];
      const manualEntry = existing?.cwd === (cwd ?? "") ? existing?.manualEntry : undefined;
      const nonce = existing?.cwd === (cwd ?? "") ? existing?.reloadNonce ?? 0 : 0;
      return {
        byConv: {
          ...s.byConv,
          [convId]: {
            cwd: cwd ?? "",
            manualEntry,
            ready: true,
            reloadNonce: nonce,
            url: composeDraftPreviewUrl(cwd ?? "", manualEntry, nonce),
            loadState: manualEntry ? existing?.loadState ?? "loading" : "idle",
            error: existing?.error,
            updatedAt: existing?.updatedAt ?? new Date().toISOString()
          }
        }
      };
    });
  },

  setManualEntry(convId, rel) {
    get().setPreviewTarget(convId, rel);
  },

  setPreviewTarget(convId, target) {
    set((s) => {
      const entry = s.byConv[convId];
      const cwd = entry?.cwd ?? "";
      const nonce = (entry?.reloadNonce ?? 0) + 1;
      return {
        byConv: {
          ...s.byConv,
          [convId]: {
            cwd,
            manualEntry: target,
            ready: true,
            reloadNonce: nonce,
            url: composeDraftPreviewUrl(cwd, target, nonce),
            loadState: "loading",
            error: undefined,
            updatedAt: new Date().toISOString()
          }
        }
      };
    });
  },

  clearManualEntry(convId) {
    set((s) => {
      const entry = s.byConv[convId];
      if (!entry?.manualEntry) return s;
      const nonce = entry.reloadNonce + 1;
      return {
        byConv: {
          ...s.byConv,
          [convId]: {
            ...entry,
            manualEntry: undefined,
            reloadNonce: nonce,
            url: composeDraftPreviewUrl(entry.cwd, undefined, nonce),
            loadState: "idle",
            error: undefined,
            updatedAt: new Date().toISOString()
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
            url: composeDraftPreviewUrl(entry.cwd, entryOf(entry), nonce),
            loadState: "loading",
            error: undefined,
            updatedAt: new Date().toISOString()
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
  },

  setLoadState(convId, loadState, error) {
    set((s) => {
      const entry = s.byConv[convId];
      if (!entry) return s;
      return {
        byConv: {
          ...s.byConv,
          [convId]: {
            ...entry,
            loadState,
            error: error || undefined,
            updatedAt: new Date().toISOString()
          }
        }
      };
    });
  }
}));
