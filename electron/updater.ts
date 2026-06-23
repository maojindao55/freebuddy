import { app, BrowserWindow, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import { APP_VERSION } from "./app-meta.js";

const { autoUpdater } = electronUpdater;

// GitHub release source. Set explicitly so the updater works even when the
// build did not pack an app-update.yml (e.g. --publish never).
const UPDATE_OWNER = "maojindao55";
const UPDATE_REPO = "freebuddy";

const UPDATE_EVENT_CHANNEL = "updater://event";

export type UpdaterEvent =
  | { type: "checking-for-update" }
  | { type: "update-available"; version: string; releaseDate?: string; releaseNotes?: unknown }
  | { type: "update-not-available"; version: string }
  | { type: "download-progress"; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { type: "update-downloaded"; version: string }
  | { type: "error"; message: string };

let autoCheckDone = false;
let bound = false;

function broadcast(event: UpdaterEvent) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(UPDATE_EVENT_CHANNEL, event);
    }
  }
}

function bindAutoUpdater() {
  if (bound) return;
  bound = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.setFeedURL({
    provider: "github",
    owner: UPDATE_OWNER,
    repo: UPDATE_REPO
  });

  autoUpdater.on("checking-for-update", () => {
    broadcast({ type: "checking-for-update" });
  });
  autoUpdater.on("update-available", (info) => {
    broadcast({
      type: "update-available",
      version: info.version ?? "",
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    broadcast({ type: "update-not-available", version: info.version ?? APP_VERSION });
  });
  autoUpdater.on("download-progress", (progress) => {
    broadcast({
      type: "download-progress",
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    broadcast({ type: "update-downloaded", version: info.version ?? "" });
  });
  autoUpdater.on("error", (_err, message) => {
    broadcast({ type: "error", message: message || _err?.message || String(_err) });
  });
}

export function initAutoUpdater() {
  bindAutoUpdater();

  // Auto-check once on startup, but only for packaged builds.
  if (!app.isPackaged) return;
  if (autoCheckDone) return;
  autoCheckDone = true;

  // Delay so the window/network is ready and startup feels snappy.
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => {
      /* surfaced via 'error' event */
    });
  }, 4000);
}

export function registerUpdaterIpc() {
  ipcMain.handle("app:getVersion", () => APP_VERSION);

  ipcMain.handle("updater:check", async () => {
    bindAutoUpdater();
    try {
      const result = await autoUpdater.checkForUpdates();
      return {
        ok: true,
        available: result?.isUpdateAvailable ?? false,
        version: result?.updateInfo?.version ?? null
      };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  });

  ipcMain.handle("updater:download", async () => {
    bindAutoUpdater();
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  });

  ipcMain.handle("updater:quitAndInstall", () => {
    try {
      autoUpdater.quitAndInstall(false, true);
      return true;
    } catch {
      return false;
    }
  });
}

export { UPDATE_EVENT_CHANNEL };
