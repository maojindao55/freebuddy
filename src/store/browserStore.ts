import { create } from "zustand";

import type { BrowserLoadState } from "@/services/cli/types";
import {
  attachmentPreviewUrl,
  withWebMediaAuth
} from "@/utils/chatAttachments";

export interface BrowserEntry {
  cwd: string;
  /** User/agent-set preview target: relative path, local file, or HTTP(S) URL. */
  manualEntry?: string;
  /** Navigation history for back/forward. */
  history: string[];
  historyIndex: number;
  /** Entry resolution finished. */
  ready: boolean;
  /** Bumped to force the frame to reload. */
  reloadNonce: number;
  /** Fully composed preview url, empty when no target. */
  url: string;
  /** Renderer-observed load state used by Browser MCP tool. */
  loadState: BrowserLoadState;
  error?: string;
  updatedAt: string;
}

export type DraftPreviewEntry = BrowserEntry;

interface BrowserState {
  byConv: Record<string, BrowserEntry>;
  timers: Record<string, ReturnType<typeof setTimeout>>;
  nativeUrls: Record<string, string>;
  ensureFor(convId: string, cwd: string | undefined): Promise<void>;
  navigate(convId: string, target: string): void;
  goBack(convId: string): void;
  goForward(convId: string): void;
  setManualEntry(convId: string, rel: string): void;
  setPreviewTarget(convId: string, target: string): void;
  clearManualEntry(convId: string): void;
  reload(convId: string): void;
  scheduleReload(convId: string, delay?: number): void;
  setLoadState(convId: string, state: BrowserLoadState, error?: string): void;
  setNativeBrowserUrl(convId: string, url: string): void;
}

/** Absolute local files previewed via freebuddy-file (images, PDF). */
const LOCAL_FILE_PREVIEW_EXTENSIONS = new Set([
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

/** Absolute HTML/Markdown previewed via freebuddy-browser with the file's directory as root. */
const LOCAL_BROWSER_DOCUMENT_EXTENSIONS = new Set(["html", "htm", "md"]);

function isWebPlatform(): boolean {
  return typeof window !== "undefined" && window.freebuddy?.platform === "web";
}

function withBrowserNonce(target: string, nonce: number): string {
  const url = new URL(target);
  url.searchParams.set("freebuddyDraft", String(nonce));
  url.searchParams.set("freebuddyBrowser", String(nonce));
  return url.toString();
}

function shouldKeepRemoteUrlExact(target: string): boolean {
  try {
    const { hostname } = new URL(target);
    return (
      hostname === "mp.weixin.qq.com" ||
      hostname.endsWith(".weibo.com") ||
      hostname === "weibo.com" ||
      hostname.endsWith(".weibo.cn") ||
      hostname === "weibo.cn" ||
      hostname === "v2ex.com" ||
      hostname.endsWith(".v2ex.com")
    );
  } catch {
    return false;
  }
}

function localFileExtension(target: string): string {
  return target.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
}

export function isAbsoluteLocalPath(target: string): boolean {
  return /^([A-Za-z]:[\\/]|\/)/.test(target);
}

export function remoteBrowserOrigin(value: string | undefined): string | null {
  if (!value || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function normalizeBrowserCwd(raw?: string | null): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed === ".") return "";
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function isSameBrowserCwd(cwdA?: string | null, cwdB?: string | null): boolean {
  const a = normalizeBrowserCwd(cwdA);
  const b = normalizeBrowserCwd(cwdB);
  if (a === b) return true;
  if (isAbsoluteLocalPath(a) && isAbsoluteLocalPath(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}

function shouldPreserveManualEntry(
  existingCwd: string | undefined,
  newCwd: string | undefined,
  manualEntry: string | undefined
): boolean {
  if (!manualEntry) return false;
  if (
    isAbsoluteLocalPath(manualEntry) ||
    /^https?:\/\//i.test(manualEntry) ||
    /^freebuddy-[a-z0-9-]+:\/\//i.test(manualEntry) ||
    /^file:\/\//i.test(manualEntry)
  ) {
    return true;
  }
  const prev = normalizeBrowserCwd(existingCwd);
  const next = normalizeBrowserCwd(newCwd);
  if (!prev || !next) return true;
  return isSameBrowserCwd(prev, next);
}

function joinWorkspacePath(cwd: string, rel: string): string {
  const root = normalizeBrowserCwd(cwd);
  const cleaned = rel.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!root || !cleaned) return "";
  if (isAbsoluteLocalPath(cleaned)) return cleaned;
  if (cleaned.startsWith("../") || cleaned.includes("/../")) return "";
  return `${root}/${cleaned}`;
}

/** Split an absolute file path into parent directory + basename for browser reads. */
export function splitAbsoluteLocalFile(target: string): { root: string; rel: string } | null {
  const normalized = target.trim().replace(/\\/g, "/").split("?")[0];
  if (!isAbsoluteLocalPath(normalized)) return null;
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const root = normalized.slice(0, lastSlash) || "/";
  const rel = normalized.slice(lastSlash + 1);
  if (!rel) return null;
  return { root, rel };
}

function filePreviewUrl(target: string, nonce: number): string {
  const normalized = target.trim().replace(/\\/g, "/");
  if (isWebPlatform()) {
    return withWebMediaAuth(attachmentPreviewUrl(normalized), {
      freebuddyBrowser: String(nonce)
    });
  }
  const url = new URL("freebuddy-file://open");
  url.searchParams.set("path", normalized);
  url.searchParams.set("freebuddyBrowser", String(nonce));
  return url.toString();
}

function browserRenderUrl(root: string, rel: string, nonce: number): string {
  const encodedRoot = encodeURIComponent(root);
  const encodedRel = rel.split("/").map(encodeURIComponent).join("/");
  if (isWebPlatform()) {
    return withWebMediaAuth(
      `/api/browser-render/${encodedRoot}/${encodedRel}`,
      { v: String(nonce) }
    );
  }
  return `freebuddy-browser://render/${encodedRoot}/${encodedRel}?v=${nonce}`;
}

/** Serve an absolute HTML/Markdown file under freebuddy-browser using its parent directory as root. */
function absoluteLocalBrowserUrl(target: string, nonce: number): string {
  const parts = splitAbsoluteLocalFile(target);
  if (!parts) return "";
  return browserRenderUrl(parts.root, parts.rel, nonce);
}

const COMMON_WEB_TLDS = new Set([
  "com", "cn", "org", "net", "io", "dev", "app", "ai", "co", "cc", "me",
  "xyz", "info", "biz", "tv", "top", "vip", "site", "online", "cloud",
  "edu", "gov", "mil", "hk", "tw", "jp", "kr", "uk", "de", "fr", "ru",
  "us", "ca", "au", "in", "eu", "tech", "space", "store", "fun", "club"
]);

/** Convert a `file://` URL to a POSIX-ish absolute path the preview stack understands. */
export function pathFromFileUrl(target: string): string | null {
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "file:") return null;
    let pathname = decodeURIComponent(parsed.pathname);
    // Windows: file:///C:/Users/... → /C:/Users/...
    if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
    return pathname.replace(/\\/g, "/");
  } catch {
    return null;
  }
}

export function isBundledGameType(value: unknown): value is "gomoku" | "xiangqi" {
  return value === "gomoku" || value === "xiangqi";
}

/**
 * Preview target for the packaged Gomoku / Xiangqi boards.
 * Packaged Electron loads `file://.../app.asar/dist/index.html`, which the
 * built-in browser cannot iframe; convert that to an absolute path so
 * `composeBrowserUrl` serves it through `freebuddy-browser` without a workspace.
 * WebUI / Vite keep a same-origin HTTP URL under `/games/`.
 */
export function bundledGameEntry(gamePath: string): string {
  const rel = `games/${gamePath}/index.html`;
  if (typeof window === "undefined") return `/${rel}`;
  if (isWebPlatform()) {
    return new URL(`/${rel}`, `${window.location.origin}/`).href;
  }
  try {
    const href = new URL(rel, window.location.href).href;
    return pathFromFileUrl(href) || href;
  } catch {
    return `/${rel}`;
  }
}

export function normalizeBrowserTarget(input: string | null | undefined): string {
  const trimmed = input?.trim() ?? "";
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^freebuddy-[a-z0-9-]+:\/\//i.test(trimmed)) return trimmed;
  if (/^file:\/\//i.test(trimmed)) return trimmed;
  if (isAbsoluteLocalPath(trimmed)) return trimmed;

  // Localhost / 127.0.0.1 with optional port and path
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }

  // Starts with www.
  if (/^www\./i.test(trimmed)) {
    return `https://${trimmed}`;
  }

  // Domain pattern: e.g. baidu.com, api.github.com/repos, google.com
  const hostPart = trimmed.split("/")[0]?.split("?")[0]?.split(":")[0] ?? "";
  const dotIndex = hostPart.lastIndexOf(".");
  if (dotIndex > 0) {
    const tld = hostPart.slice(dotIndex + 1).toLowerCase();
    if (COMMON_WEB_TLDS.has(tld)) {
      return `https://${trimmed}`;
    }
  }

  return trimmed;
}

function pathFromFreebuddyFileUrl(target: string): string | null {
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "freebuddy-file:") return null;
    return parsed.searchParams.get("path");
  } catch {
    return null;
  }
}

export function composeBrowserUrl(
  cwd: string,
  target: string | null | undefined,
  nonce: number
): string {
  if (!target) return "";
  const normalized = normalizeBrowserTarget(target);
  if (/^https?:\/\//i.test(normalized)) {
    if (remoteBrowserOrigin(normalized) || shouldKeepRemoteUrlExact(normalized)) return normalized;
    return withBrowserNonce(normalized, nonce);
  }
  if (/^freebuddy-file:\/\//i.test(normalized)) {
    if (isWebPlatform()) {
      const filePath = pathFromFreebuddyFileUrl(normalized);
      if (filePath) return filePreviewUrl(filePath, nonce);
    }
    return withBrowserNonce(normalized, nonce);
  }
  if (/^freebuddy-(browser|draft):\/\//i.test(normalized)) {
    return normalized;
  }
  if (/^file:\/\//i.test(normalized)) {
    const filePath = pathFromFileUrl(normalized);
    return filePath ? composeBrowserUrl(cwd, filePath, nonce) : "";
  }
  if (isAbsoluteLocalPath(normalized)) {
    const ext = localFileExtension(normalized);
    if (LOCAL_BROWSER_DOCUMENT_EXTENSIONS.has(ext)) {
      return absoluteLocalBrowserUrl(normalized, nonce);
    }
    if (LOCAL_FILE_PREVIEW_EXTENSIONS.has(ext)) {
      return filePreviewUrl(normalized, nonce);
    }
  }
  if (!cwd) return "";
  const ext = localFileExtension(normalized);
  if (LOCAL_FILE_PREVIEW_EXTENSIONS.has(ext)) {
    const abs = joinWorkspacePath(cwd, normalized);
    return abs ? filePreviewUrl(abs, nonce) : "";
  }
  if (LOCAL_BROWSER_DOCUMENT_EXTENSIONS.has(ext)) {
    return browserRenderUrl(cwd, normalized, nonce);
  }
  return browserRenderUrl(cwd, normalized, nonce);
}

export const composeDraftPreviewUrl = composeBrowserUrl;

function entryOf(entry: BrowserEntry | undefined): string | null | undefined {
  if (!entry) return null;
  return entry.manualEntry;
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  byConv: {},
  timers: {},
  nativeUrls: {},

  async ensureFor(convId, cwd) {
    const normalizedCwd = normalizeBrowserCwd(cwd);
    const prev = get().byConv[convId];
    if (prev && isSameBrowserCwd(prev.cwd, normalizedCwd) && prev.ready) return;
    set((s) => {
      const existing = s.byConv[convId];
      const effectiveCwd = normalizedCwd || normalizeBrowserCwd(existing?.cwd);
      const preserve = shouldPreserveManualEntry(
        existing?.cwd,
        normalizedCwd,
        existing?.manualEntry
      );
      const manualEntry = preserve ? existing?.manualEntry : undefined;
      const nonce = preserve ? existing?.reloadNonce ?? 0 : 0;
      const history = existing?.history?.length
        ? existing.history
        : manualEntry
          ? [manualEntry]
          : [];
      const historyIndex =
        existing?.historyIndex ?? (history.length ? history.length - 1 : -1);
      return {
        nativeUrls: {
          ...s.nativeUrls,
          [convId]: ""
        },
        byConv: {
          ...s.byConv,
          [convId]: {
            cwd: effectiveCwd,
            manualEntry,
            history,
            historyIndex,
            ready: true,
            reloadNonce: nonce,
            url: composeBrowserUrl(effectiveCwd, manualEntry, nonce),
            loadState: manualEntry ? existing?.loadState ?? "loading" : "idle",
            error: existing?.error,
            updatedAt: existing?.updatedAt ?? new Date().toISOString()
          }
        }
      };
    });
  },

  navigate(convId, target) {
    const normalized = normalizeBrowserTarget(target);
    if (!normalized) return;
    set((s) => {
      const entry = s.byConv[convId];
      const cwd = normalizeBrowserCwd(entry?.cwd);
      const nonce = (entry?.reloadNonce ?? 0) + 1;
      const prevHistory = entry?.history ?? [];
      const prevIndex = entry?.historyIndex ?? -1;
      // Slice history up to current index and append new target
      const newHistory = [...prevHistory.slice(0, prevIndex + 1), normalized];
      const newIndex = newHistory.length - 1;
      return {
        nativeUrls: {
          ...s.nativeUrls,
          [convId]: ""
        },
        byConv: {
          ...s.byConv,
          [convId]: {
            cwd,
            manualEntry: normalized,
            history: newHistory,
            historyIndex: newIndex,
            ready: true,
            reloadNonce: nonce,
            url: composeBrowserUrl(cwd, normalized, nonce),
            loadState: "loading",
            error: undefined,
            updatedAt: new Date().toISOString()
          }
        }
      };
    });
  },

  goBack(convId) {
    const entry = get().byConv[convId];
    if (!entry || entry.historyIndex <= 0) return;
    const targetIndex = entry.historyIndex - 1;
    const target = entry.history[targetIndex];
    if (!target) return;
    set((s) => {
      const current = s.byConv[convId];
      if (!current) return s;
      const nonce = current.reloadNonce + 1;
      return {
        byConv: {
          ...s.byConv,
          [convId]: {
            ...current,
            manualEntry: target,
            historyIndex: targetIndex,
            reloadNonce: nonce,
            url: composeBrowserUrl(current.cwd, target, nonce),
            loadState: "loading",
            error: undefined,
            updatedAt: new Date().toISOString()
          }
        }
      };
    });
  },

  goForward(convId) {
    const entry = get().byConv[convId];
    if (!entry || entry.historyIndex >= entry.history.length - 1) return;
    const targetIndex = entry.historyIndex + 1;
    const target = entry.history[targetIndex];
    if (!target) return;
    set((s) => {
      const current = s.byConv[convId];
      if (!current) return s;
      const nonce = current.reloadNonce + 1;
      return {
        byConv: {
          ...s.byConv,
          [convId]: {
            ...current,
            manualEntry: target,
            historyIndex: targetIndex,
            reloadNonce: nonce,
            url: composeBrowserUrl(current.cwd, target, nonce),
            loadState: "loading",
            error: undefined,
            updatedAt: new Date().toISOString()
          }
        }
      };
    });
  },

  setManualEntry(convId, rel) {
    get().navigate(convId, rel);
  },

  setPreviewTarget(convId, target) {
    get().navigate(convId, target);
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
            url: composeBrowserUrl(entry.cwd, undefined, nonce),
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
            url: composeBrowserUrl(entry.cwd, entryOf(entry), nonce),
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
  },

  setNativeBrowserUrl(convId, url) {
    set((state) => ({
      nativeUrls: {
        ...state.nativeUrls,
        [convId]: url
      }
    }));
  }
}));
