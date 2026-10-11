import { app, BrowserWindow, dialog, ipcMain, shell, screen } from "electron";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerHandler } from "./invokeRegistry.js";
import { getConversation } from "./cli/conversations.js";
import { resolveDocStudioOfficeFile } from "./officeEngineToolService.js";
import {
  isDocStudioWindowSender,
  registerDocStudioWindow,
  unregisterDocStudioWindow
} from "./docStudioWindowRegistry.js";
export { isDocStudioWindowSender } from "./docStudioWindowRegistry.js";
import {
  isOfficeEngineFile,
  buildOfficeEnginePreviewUrl,
  buildOfficeEngineEditorStatusUrl,
  findOfficeEngineEditorStatus,
  OFFICE_ENGINE_FILE_TYPES
} from "./officeEngineCore.js";
import { ensureOfficeEnginePort, findLocalOfficeEngineBinary } from "./officeEngine.js";
import {
  downloadConfiguredOfficeEngine,
  getOfficeEngineDownloadConfig,
  getManagedOfficeEnginePath
} from "./officeEngineAddon.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
let officeEngineAddonBusy = false;
const docStudioActiveConversations = new Map<number, string>();

// Per-webContents file watchers for the DocStudio live-reload feature.
interface DocStudioWatchEntry {
  watcher: ReturnType<typeof watch>;
  timer?: NodeJS.Timeout;
  needsRearm: boolean;
}
const docStudioWatchers = new Map<number, Map<string, DocStudioWatchEntry>>();
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
              await fs.stat(filePath);
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

export function openDocStudioWindow(initialFilePath?: string, initialConversationId?: string): BrowserWindow {
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

  const webContentsId = win.webContents.id;
  registerDocStudioWindow(webContentsId);
  if (initialConversationId) docStudioActiveConversations.set(win.id, initialConversationId);

  win.on("closed", () => {
    unregisterDocStudioWindow(webContentsId);
    docStudioActiveConversations.delete(win.id);
  });

  const query: Record<string, string> = { surface: "doc-studio" };
  if (initialFilePath) {
    query.file = initialFilePath;
  }
  if (initialConversationId) query.conversation = initialConversationId;

  if (isDev) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL as string);
    url.searchParams.set("surface", "doc-studio");
    if (initialFilePath) {
      url.searchParams.set("file", initialFilePath);
    }
    if (initialConversationId) url.searchParams.set("conversation", initialConversationId);
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

function isAllowedOfficeEnginePath(p: unknown): p is string {
  return typeof p === "string" && path.isAbsolute(p) && isOfficeEngineFile(p);
}

/** Files supported by the embedded office engine. */
export function isDocStudioOpenableFile(filePath: string): boolean {
  return isOfficeEngineFile(filePath);
}

export async function showDocStudioOpenDialog(parentWin?: BrowserWindow, defaultPath?: string): Promise<string[] | null> {
  const officeExtensions = OFFICE_ENGINE_FILE_TYPES.flatMap((t) => t.extensions).map((ext) =>
    ext.replace(/^\./, "")
  );
  const options = {
    defaultPath,
    properties: ["openFile" as const],
    filters: [
      { name: "Office & PDF", extensions: officeExtensions }
    ]
  };
  const result = parentWin && !parentWin.isDestroyed()
    ? await dialog.showOpenDialog(parentWin, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths;
}

export function initDocStudioBridge(): void {
  registerHandler("docStudio:officeEngineAddonStatus", async () => {
    const managedPath = getManagedOfficeEnginePath(app.getPath("userData"));
    const installed = await fs.stat(managedPath).then((stat) => stat.isFile(), () => false);
    return {
      supported: getOfficeEngineDownloadConfig() !== null,
      installed,
      installing: officeEngineAddonBusy,
      managedPath,
      activePath: findLocalOfficeEngineBinary()
    };
  });

  registerHandler("docStudio:officeEngineAddonDownload", async (event) => {
    if (officeEngineAddonBusy) throw new Error("An Office engine installation is already in progress");
    officeEngineAddonBusy = true;
    try {
      const installedPath = await downloadConfiguredOfficeEngine(app.getPath("userData"), (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("docStudio:officeEngineDownloadProgress", progress);
      });
      return { installedPath };
    } finally {
      officeEngineAddonBusy = false;
    }
  });

  // IPC to open a doc studio window
  registerHandler("docStudio:openWindow", async (_event, target?: string | { filePath?: string }) => {
    const filePath = typeof target === "object" && target !== null ? target.filePath : target;
    if (filePath && !isAllowedOfficeEnginePath(filePath)) return false;
    openDocStudioWindow(filePath);
    return true;
  });

  registerHandler("docStudio:openConversation", async (_event, conversationId: unknown) => {
    if (typeof conversationId !== "string" || !conversationId) return false;
    const conversation = getConversation(conversationId);
    if (conversation?.kind !== "doc-studio") return false;
    for (const [windowId, activeId] of docStudioActiveConversations) {
      if (activeId !== conversationId) continue;
      const existing = BrowserWindow.fromId(windowId);
      if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.show();
        existing.focus();
        return true;
      }
      docStudioActiveConversations.delete(windowId);
    }
    const attachedPath = resolveDocStudioOfficeFile(conversationId);
    const filePath = attachedPath && await fs.stat(attachedPath).then(
      (stat) => stat.isFile() ? attachedPath : undefined,
      () => undefined
    );
    openDocStudioWindow(filePath || undefined, conversationId);
    return true;
  });

  registerHandler("docStudio:setActiveConversation", (event, conversationId: unknown) => {
    if (!isDocStudioWindowSender(event.sender)) return false;
    if (conversationId !== null &&
      (typeof conversationId !== "string" || getConversation(conversationId)?.kind !== "doc-studio")) {
      return false;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    if (conversationId) docStudioActiveConversations.set(win.id, conversationId);
    else docStudioActiveConversations.delete(win.id);
    return true;
  });

  registerHandler("docStudio:defaultDirectory", async (event) => {
    if (!isDocStudioWindowSender(event.sender)) return null;
    return app.getPath("documents");
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

  // Office engine editor status (is_dirty / last_saved_ms). The SDK's
  // file_path query parameter is not URL-decoded, so match the pool locally.
  registerHandler("docStudio:engineEditorStatus", async (event, targetPath: string) => {
    if (!isDocStudioWindowSender(event.sender) || !isAllowedOfficeEnginePath(targetPath)) {
      return { success: false, error: "forbidden" };
    }
    const port = await ensureOfficeEnginePort();
    if (!port) return { success: false, error: "engineUnavailable" };
    try {
      const response = await fetch(buildOfficeEngineEditorStatusUrl(port), {
        signal: AbortSignal.timeout(2000)
      });
      if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
      const body = (await response.json()) as {
        open_editors?: unknown;
      };
      const editor = findOfficeEngineEditorStatus(body.open_editors, targetPath);
      if (!editor) return { success: false, error: "notOpen" };
      return {
        success: true,
        isDirty: editor.is_dirty === true,
        lastSavedMs: typeof editor.last_saved_ms === "number" ? editor.last_saved_ms : 0
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Live file watching for external changes (per-window, cleaned up on destroy).
  // Covers office-engine files too: when an agent saves the file through the
  // engine MCP, the on-disk change reloads the embedded preview.
  registerHandler("docStudio:watchFile", async (event, targetPath: string) => {
    if (!isDocStudioWindowSender(event.sender) || !isAllowedOfficeEnginePath(targetPath)) {
      return false;
    }
    return docStudioWatchFile(event, targetPath);
  });

  registerHandler("docStudio:unwatchFile", async (event, targetPath: string) => {
    if (!isDocStudioWindowSender(event.sender)) return false;
    docStudioUnwatch(event.sender.id, targetPath);
    return true;
  });

  // Open dialog
  registerHandler("docStudio:showOpenDialog", async (event, defaultPath?: string) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender);
    return showDocStudioOpenDialog(parentWin ?? undefined, defaultPath);
  });

  // Show in Finder / Explorer
  registerHandler("docStudio:showItemInFolder", async (event, targetPath: string) => {
    if (!isDocStudioWindowSender(event.sender) || !isAllowedOfficeEnginePath(targetPath)) {
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
