import { app, BrowserWindow, dialog, ipcMain, shell, screen } from "electron";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerHandler } from "./invokeRegistry.js";
import {
  isOfficeEngineFile,
  buildOfficeEnginePreviewUrl,
  buildOfficeEngineEditorStatusUrl,
  OFFICE_ENGINE_FILE_TYPES
} from "./officeEngineCore.js";
import { ensureOfficeEnginePort } from "./officeEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const docStudioWindows = new Map<number, BrowserWindow>();

// Per-webContents file watchers for the DocStudio live-reload feature.
interface DocStudioWatchEntry {
  watcher: ReturnType<typeof watch>;
  timer?: NodeJS.Timeout;
  needsRearm: boolean;
}
const docStudioWatchers = new Map<number, Map<string, DocStudioWatchEntry>>();
// Stat snapshots recorded right after our own writeFile, so the watcher can
// ignore change events we caused ourselves.
const docStudioOwnWrites = new Map<string, { size: number; mtimeMs: number }>();
const DOCSTUDIO_WATCH_DEBOUNCE_MS = 300;

function docStudioUnwatch(wcId: number, filePath: string): void {
  const perWindow = docStudioWatchers.get(wcId);
  const entry = perWindow?.get(filePath);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  try {
    entry.watcher.close();
  } catch {
    /* already closed */
  }
  perWindow!.delete(filePath);
}

function docStudioWatchFile(event: Electron.IpcMainInvokeEvent, filePath: string): boolean {
  const wcId = event.sender.id;
  let perWindow = docStudioWatchers.get(wcId);
  if (!perWindow) {
    perWindow = new Map();
    docStudioWatchers.set(wcId, perWindow);
    const windowWatchers = perWindow;
    event.sender.once("destroyed", () => {
      for (const key of [...windowWatchers.keys()]) docStudioUnwatch(wcId, key);
      docStudioWatchers.delete(wcId);
    });
  }
  if (perWindow.has(filePath)) return true;

  const arm = () => {
    const entry: DocStudioWatchEntry = { watcher: undefined as never, needsRearm: false };
    try {
      entry.watcher = watch(filePath, (eventType) => {
        const live = perWindow.get(filePath);
        if (!live) return;
        if (eventType === "rename") live.needsRearm = true;
        if (live.timer) clearTimeout(live.timer);
        live.timer = setTimeout(() => {
          void (async () => {
            try {
              const st = await fs.stat(filePath);
              const own = docStudioOwnWrites.get(filePath);
              if (own && own.size === st.size && own.mtimeMs === st.mtimeMs) return;
              if (!event.sender.isDestroyed()) {
                event.sender.send("docStudio:fileChanged", { filePath });
              }
            } catch {
              /* file may be gone */
            }
          })();
          if (live.needsRearm) {
            live.needsRearm = false;
            try {
              live.watcher.close();
            } catch {
              /* already closed */
            }
            arm();
          }
        }, DOCSTUDIO_WATCH_DEBOUNCE_MS);
      });
      entry.watcher.on("error", () => {});
    } catch {
      return;
    }
    perWindow.set(filePath, entry);
  };
  arm();
  return true;
}

function companionWebPreferences() {
  return {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false
  };
}

export function openDocStudioWindow(initialFilePath?: string): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const width = Math.min(1440, Math.floor(display.workArea.width * 0.9));
  const height = Math.min(880, Math.floor(display.workArea.height * 0.9));

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 720,
    minHeight: 480,
    title: initialFilePath ? `${path.basename(initialFilePath)} - FreeBuddy` : "FreeBuddy Document Studio",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 16, y: 16 } : undefined,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: companionWebPreferences()
  });

  docStudioWindows.set(win.id, win);

  win.on("closed", () => {
    docStudioWindows.delete(win.id);
  });

  const query: Record<string, string> = { surface: "doc-studio" };
  if (initialFilePath) {
    query.file = initialFilePath;
  }

  if (isDev) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL as string);
    url.searchParams.set("surface", "doc-studio");
    if (initialFilePath) {
      url.searchParams.set("file", initialFilePath);
    }
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"), { query });
  }

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  return win;
}

export function isDocStudioWindowSender(sender: Electron.WebContents): boolean {
  const win = BrowserWindow.fromWebContents(sender);
  return !!win && docStudioWindows.has(win.id);
}

export function isOfficeOrDocFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".csv", ".tsv", ".md", ".txt", ".json"].includes(ext);
}

function isAllowedDocPath(p: unknown): p is string {
  return typeof p === "string" && path.isAbsolute(p) && isOfficeOrDocFile(p);
}

function isAllowedOfficeEnginePath(p: unknown): p is string {
  return typeof p === "string" && path.isAbsolute(p) && isOfficeEngineFile(p);
}

/** Anything DocStudio can open: text-editable docs plus engine-rendered office files. */
export function isDocStudioOpenableFile(filePath: string): boolean {
  return isOfficeOrDocFile(filePath) || isOfficeEngineFile(filePath);
}

export async function showDocStudioOpenDialog(parentWin?: BrowserWindow, defaultPath?: string): Promise<string[] | null> {
  const officeExtensions = OFFICE_ENGINE_FILE_TYPES.flatMap((t) => t.extensions).map((ext) =>
    ext.replace(/^\./, "")
  );
  const options = {
    defaultPath,
    properties: ["openFile" as const],
    filters: [
      { name: "Documents & Tables", extensions: ["csv", "tsv", "md", "txt", "json"] },
      { name: "Office (engine)", extensions: officeExtensions },
      { name: "All Files", extensions: ["*"] }
    ]
  };
  const result = parentWin && !parentWin.isDestroyed()
    ? await dialog.showOpenDialog(parentWin, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths;
}

export function initDocStudioBridge(): void {
  // IPC to open a doc studio window
  registerHandler("docStudio:openWindow", async (_event, target?: string | { filePath?: string }) => {
    const filePath = typeof target === "object" && target !== null ? target.filePath : target;
    if (filePath && !isAllowedDocPath(filePath) && !isAllowedOfficeEnginePath(filePath)) return false;
    openDocStudioWindow(filePath);
    return true;
  });

  // Office engine preview URL (personal-learning integration; see officeEngineCore.ts)
  registerHandler("docStudio:officePreview", async (event, targetPath: string) => {
    if (!isDocStudioWindowSender(event.sender) || !isAllowedOfficeEnginePath(targetPath)) {
      return { success: false, error: "forbidden" };
    }
    const port = await ensureOfficeEnginePort();
    if (!port) return { success: false, error: "engineUnavailable" };
    return { success: true, url: buildOfficeEnginePreviewUrl(port, targetPath) };
  });

  // Office engine editor status (is_dirty / last_saved_ms). The renderer polls
  // this to reload the preview after an agent edits/saves the file via MCP.
  registerHandler("docStudio:engineEditorStatus", async (event, targetPath: string) => {
    if (!isDocStudioWindowSender(event.sender) || !isAllowedOfficeEnginePath(targetPath)) {
      return { success: false, error: "forbidden" };
    }
    const port = await ensureOfficeEnginePort();
    if (!port) return { success: false, error: "engineUnavailable" };
    try {
      const response = await fetch(buildOfficeEngineEditorStatusUrl(port, targetPath), {
        signal: AbortSignal.timeout(2000)
      });
      if (response.status === 404) return { success: false, error: "notOpen" };
      if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
      const body = (await response.json()) as {
        is_dirty?: boolean;
        last_saved_ms?: number;
      };
      return {
        success: true,
        isDirty: body.is_dirty === true,
        lastSavedMs: typeof body.last_saved_ms === "number" ? body.last_saved_ms : 0
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Read file as text or binary (base64)
  registerHandler("docStudio:readFile", async (event, targetPath: string) => {
    if (!isDocStudioWindowSender(event.sender) || !isAllowedDocPath(targetPath)) {
      return { success: false, error: "forbidden", path: targetPath };
    }
    try {
      const stat = await fs.stat(targetPath);
      const ext = path.extname(targetPath).toLowerCase();
      const isBinary = [".xlsx", ".xls"].includes(ext);

      if (isBinary) {
        const buffer = await fs.readFile(targetPath);
        return {
          success: true,
          name: path.basename(targetPath),
          path: targetPath,
          size: stat.size,
          ext,
          bufferBase64: buffer.toString("base64")
        };
      } else {
        const content = await fs.readFile(targetPath, "utf-8");
        return {
          success: true,
          name: path.basename(targetPath),
          path: targetPath,
          size: stat.size,
          ext,
          content
        };
      }
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || String(err),
        path: targetPath
      };
    }
  });

  // Write file from text or base64
  registerHandler("docStudio:writeFile", async (event, targetPath: string, payload: { content?: string; bufferBase64?: string }) => {
    if (!isDocStudioWindowSender(event.sender) || !isAllowedDocPath(targetPath)) {
      return { success: false, error: "forbidden" };
    }
    try {
      if (payload.bufferBase64) {
        const buffer = Buffer.from(payload.bufferBase64, "base64");
        await fs.writeFile(targetPath, buffer);
      } else if (typeof payload.content === "string") {
        await fs.writeFile(targetPath, payload.content, "utf-8");
      } else {
        throw new Error("No content or buffer provided");
      }
      try {
        const st = await fs.stat(targetPath);
        docStudioOwnWrites.set(targetPath, { size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* non-fatal */
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  // Live file watching for external changes (per-window, cleaned up on destroy).
  // Covers office-engine files too: when an agent saves the file through the
  // engine MCP, the on-disk change reloads the embedded preview.
  registerHandler("docStudio:watchFile", async (event, targetPath: string) => {
    if (!isDocStudioWindowSender(event.sender) || !isDocStudioOpenableFile(targetPath)) {
      return false;
    }
    return docStudioWatchFile(event, targetPath);
  });

  registerHandler("docStudio:unwatchFile", async (event, targetPath: string) => {
    if (!isDocStudioWindowSender(event.sender)) return false;
    docStudioUnwatch(event.sender.id, targetPath);
    return true;
  });

  // Save dialog
  registerHandler("docStudio:showSaveDialog", async (event, defaultName: string, filters: Array<{ name: string; extensions: string[] }>) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender);
    const options = {
      defaultPath: defaultName,
      filters: filters?.length ? filters : [{ name: "All Files", extensions: ["*"] }]
    };
    const result = parentWin && !parentWin.isDestroyed()
      ? await dialog.showSaveDialog(parentWin, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  // Open dialog
  registerHandler("docStudio:showOpenDialog", async (event, defaultPath?: string) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender);
    return showDocStudioOpenDialog(parentWin ?? undefined, defaultPath);
  });

  // Show in Finder / Explorer
  registerHandler("docStudio:showItemInFolder", async (event, targetPath: string) => {
    if (!isDocStudioWindowSender(event.sender) || !isAllowedDocPath(targetPath)) {
      return false;
    }
    try {
      shell.showItemInFolder(targetPath);
      return true;
    } catch {
      return false;
    }
  });
}
