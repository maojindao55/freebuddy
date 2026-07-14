import { app, BrowserWindow, nativeImage, protocol, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shellEnv } from "shell-env";

import { registerCliIpc } from "./cli/ipc.js";
import { startCodexToolchainAutoUpdate } from "./cli/check.js";
import { safeSendToWebContents } from "./cli/ipcSend.js";
import { handleFreebuddyFileRequest } from "./freebuddyFileProtocol.js";
import { handleDraftRequest } from "./draftProtocol.js";
import { startPreviewServer } from "./previewServer.js";
import { initFileBridge } from "./fileBridge.js";
import { getDb } from "./cli/db.js";
import { cleanupOrphanManagedAttachments } from "./cli/attachments.js";
import { seedBuiltinWorkflowTeams } from "./cli/workflowTeams.js";
import { initApplicationMenu } from "./menu.js";
import { APP_NAME, APP_VERSION } from "./app-meta.js";
import { initAutoUpdater, registerUpdaterIpc } from "./updater.js";
import { initializeScheduledTaskScheduler } from "./cli/scheduledTasks.js";
import { initializeTelemetry, shutdownTelemetry } from "./telemetry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

app.setName(APP_NAME);
process.env.FB_APP_VERSION = APP_VERSION;
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: APP_VERSION,
  version: APP_VERSION
});

const PROTOCOL = "freebuddy";

function handleSchemeUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    const action = parsed.hostname || parsed.pathname.replace(/^\//, "");
    if (action === "preview" && mainWindow && !mainWindow.isDestroyed()) {
      safeSendToWebContents(mainWindow.webContents, "freebuddy://bridge", {
        action: "preview",
        params: {}
      });
    }
  } catch {
    // ignore malformed scheme urls
  }
}

if (app.isPackaged && !app.isDefaultProtocolClient(PROTOCOL)) {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleSchemeUrl(url);
});

app.on("second-instance", (_event, argv) => {
  const url = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
  if (url) handleSchemeUrl(url);
});

function resolveAppIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app-icon.png")
    : path.join(__dirname, "../assets/app-icon.png");
}

function loadAppIcon() {
  const icon = nativeImage.createFromPath(resolveAppIconPath());
  return icon.isEmpty() ? undefined : icon;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "freebuddy-file",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true
    }
  },
  {
    scheme: "freebuddy-draft",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true
    }
  }
]);

function registerLocalFileProtocol() {
  protocol.handle("freebuddy-file", handleFreebuddyFileRequest);
}

function registerDraftProtocol() {
  protocol.handle("freebuddy-draft", handleDraftRequest);
}

async function injectShellPath() {
  if (process.platform === "win32") {
    // On Windows, Electron launched from shortcuts may not inherit the full
    // user PATH. Ensure common npm/node binary directories are present so
    // `where` can find globally-installed CLI agents like codex-acp.
    try {
      const appData = process.env.APPDATA;
      const localAppData = process.env.LOCALAPPDATA;
      const userProfile = process.env.USERPROFILE || process.env.HOME || "";
      const extraDirs: string[] = [];

      // npm global bin directory (%APPDATA%\npm)
      if (appData) extraDirs.push(path.join(appData, "npm"));

      // pnpm global bin
      if (localAppData) extraDirs.push(path.join(localAppData, "pnpm"));

      // fnm shims
      if (localAppData) extraDirs.push(path.join(localAppData, "fnm_multishells"));

      // nvm-windows current
      if (process.env.NVM_SYMLINK) extraDirs.push(process.env.NVM_SYMLINK);
      if (process.env.NVM_HOME) extraDirs.push(process.env.NVM_HOME);

      // Scoop shims
      if (userProfile) extraDirs.push(path.join(userProfile, "scoop", "shims"));

      const currentPath = process.env.PATH || "";
      const currentLower = currentPath.toLowerCase();
      const missing = extraDirs.filter(
        (d) => d && !currentLower.includes(d.toLowerCase())
      );
      if (missing.length) {
        process.env.PATH = [...missing, currentPath].join(";");
      }
    } catch {
      /* best-effort */
    }
    return;
  }
  try {
    const env = await shellEnv();
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string" && !process.env[k]) {
        process.env[k] = v;
      }
    }
    if (env.PATH) process.env.PATH = env.PATH;
  } catch {
    /* best-effort */
  }
}

let mainWindow: BrowserWindow | null = null;

function windowChromeOptions() {
  return process.platform === "darwin"
    ? {
        titleBarStyle: "hiddenInset" as const,
        trafficLightPosition: { x: 14, y: 14 }
      }
    : {};
}

function createWindow() {
  const appIcon = loadAppIcon();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    ...(appIcon ? { icon: appIcon } : {}),
    ...windowChromeOptions(),
    backgroundColor: "#0b1329",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  initApplicationMenu();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const sendChromeVisible = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    safeSendToWebContents(
      mainWindow.webContents,
      "window:chrome",
      !mainWindow.isFullScreen()
    );
  };
  mainWindow.on("enter-full-screen", sendChromeVisible);
  mainWindow.on("leave-full-screen", sendChromeVisible);
  mainWindow.on("maximize", sendChromeVisible);
  mainWindow.on("unmaximize", sendChromeVisible);

  // The app menu is hidden (Menu.setApplicationMenu(null)) and we use
  // titleBarStyle: "hiddenInset", so macOS' default Esc-to-leave-fullscreen
  // shortcut has no menu item to bind to. Restore it manually.
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (
      input.type === "keyDown" &&
      input.key === "Escape" &&
      !input.alt &&
      !input.control &&
      !input.meta &&
      !input.shift &&
      mainWindow?.isFullScreen()
    ) {
      mainWindow.setFullScreen(false);
    }
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  await injectShellPath();
  registerLocalFileProtocol();
  registerDraftProtocol();
  startPreviewServer(() =>
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  );
  initFileBridge(() =>
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  );
  getDb();
  initializeTelemetry();
  cleanupOrphanManagedAttachments();
  seedBuiltinWorkflowTeams();
  registerCliIpc();
  registerUpdaterIpc();
  const appIcon = loadAppIcon();
  if (process.platform === "darwin" && app.dock && appIcon) {
    app.dock.setIcon(appIcon);
  }
  createWindow();
  initializeScheduledTaskScheduler(() =>
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined
  );
  void startCodexToolchainAutoUpdate();
  initAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let telemetryShutdownStarted = false;
app.on("before-quit", (event) => {
  if (telemetryShutdownStarted) return;
  telemetryShutdownStarted = true;
  event.preventDefault();
  void shutdownTelemetry().finally(() => app.quit());
});
