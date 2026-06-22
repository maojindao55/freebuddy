import { create } from "zustand";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

interface UpdaterState {
  status: UpdateStatus;
  appVersion: string;
  latestVersion: string | null;
  releaseNotes: unknown;
  downloadPercent: number;
  errorMessage: string | null;
  loaded: boolean;

  load(): Promise<void>;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(): Promise<void>;
  applyEvent(event: UpdaterEvent): void;
}

function resolveApi() {
  const updater = window.freebuddy?.updater;
  if (!updater) {
    throw new Error("updater unavailable");
  }
  return updater;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: "idle",
  appVersion: "",
  latestVersion: null,
  releaseNotes: null,
  downloadPercent: 0,
  errorMessage: null,
  loaded: false,

  async load() {
    const api = window.freebuddy?.updater;
    const fallbackVersion = window.freebuddy?.appVersion ?? "";
    if (api) {
      api.onEvent((event) => {
        get().applyEvent(event);
      });
      // Fetch the authoritative version from the main process (release-synced
      // package.json version). The sandboxed preload cannot reliably read
      // custom env vars, so this IPC call is the source of truth.
      try {
        const version = await api.getVersion();
        set({ appVersion: version || fallbackVersion, loaded: true });
        return;
      } catch {
        /* fall through to fallback */
      }
    }
    set({ appVersion: fallbackVersion, loaded: true });
  },

  applyEvent(event) {
    switch (event.type) {
      case "checking-for-update":
        set({ status: "checking", errorMessage: null });
        break;
      case "update-available":
        set({
          status: "available",
          latestVersion: event.version,
          releaseNotes: event.releaseNotes ?? null,
          errorMessage: null
        });
        break;
      case "update-not-available":
        set({
          status: "not-available",
          latestVersion: event.version,
          errorMessage: null
        });
        break;
      case "download-progress":
        set({
          status: "downloading",
          downloadPercent: Math.max(0, Math.min(100, event.percent))
        });
        break;
      case "update-downloaded":
        set({
          status: "downloaded",
          latestVersion: event.version,
          downloadPercent: 100
        });
        break;
      case "error":
        set({ status: "error", errorMessage: event.message });
        break;
      default:
        break;
    }
  },

  async checkForUpdates() {
    try {
      const api = resolveApi();
      set({ status: "checking", errorMessage: null });
      const result = await api.check();
      if (!result.ok) {
        set({ status: "error", errorMessage: result.error });
      } else if (result.version) {
        set({ status: "available", latestVersion: result.version });
      }
    } catch (err) {
      set({ status: "error", errorMessage: (err as Error)?.message ?? String(err) });
    }
  },

  async downloadUpdate() {
    try {
      const api = resolveApi();
      set({ status: "downloading", downloadPercent: 0, errorMessage: null });
      const result = await api.download();
      if (!result.ok) {
        set({ status: "error", errorMessage: result.error });
      }
    } catch (err) {
      set({ status: "error", errorMessage: (err as Error)?.message ?? String(err) });
    }
  },

  async quitAndInstall() {
    try {
      await resolveApi().quitAndInstall();
    } catch {
      /* surfaced via 'error' event */
    }
  }
}));
