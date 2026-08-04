import { app, BrowserWindow, ipcMain, nativeImage, Notification, protocol, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shellEnv } from "shell-env";

import { registerCliIpc } from "./cli/ipc.js";
import { logAllCliRuntimes, startCodexToolchainAutoUpdate } from "./cli/check.js";
import { safeSendToWebContents } from "./cli/ipcSend.js";
import { handleFreebuddyFileRequest } from "./freebuddyFileProtocol.js";
import { handleDraftRequest } from "./draftProtocol.js";
import { startPreviewServer } from "./previewServer.js";
import { startWebUIServer } from "./webUIServer.js";
import { setLocalInvokeWindowGetter } from "./invokeRegistry.js";
import { ensureOwnerUser, getOwnerUser } from "./cli/users.js";
import { bindConversationNotifier } from "./cli/conversations.js";
import { applyOwnerBackfill } from "./cli/ownerBackfill.js";
import { initFileBridge } from "./fileBridge.js";
import { getDb } from "./cli/db.js";
import { getSetting } from "./cli/settings.js";
import {
  initRemoteControl,
  getConfiguredBindMode,
  getConfiguredPort
} from "./cli/remoteControl.js";
import { cleanupOrphanManagedAttachments } from "./cli/attachments.js";
import { seedBuiltinWorkflowTeams } from "./cli/workflowTeams.js";
import { seedBuiltinSkills } from "./cli/skills.js";
import { initApplicationMenu, setupContextMenu } from "./menu.js";
import { APP_NAME, APP_VERSION } from "./app-meta.js";
import { initAutoUpdater, registerUpdaterIpc } from "./updater.js";
import { initializeScheduledTaskScheduler } from "./cli/scheduledTasks.js";
import { initializeTelemetry, shutdownTelemetry } from "./telemetry.js";
import { getFreshWindowsEnvironment } from "./cli/windowsEnv.js";
import { initializeAgentUsageReconciler } from "./cli/usageReconciler.js";
import { initDebugLog, logMain } from "./debugLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

app.setName(APP_NAME);
app.setAppUserModelId("dev.freebuddy.app");
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
      const freshEnv = await getFreshWindowsEnvironment(process.env);
      if (freshEnv.PATH) process.env.PATH = freshEnv.PATH;
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

  // Desktop launchers do not consistently inherit version-manager paths.
  // Keep these deterministic user-level locations available even when Bash
  // chooses .bash_profile over .profile or the desktop session has a stale PATH.
  try {
    const home = process.env.HOME || "";
    if (!home) return;
    const extraDirs = [
      path.join(home, ".volta", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".bun", "bin")
    ].filter((dir) => fs.existsSync(dir));
    const currentPath = process.env.PATH || "";
    const entries = new Set(currentPath.split(path.delimiter).filter(Boolean));
    const missing = extraDirs.filter((dir) => !entries.has(dir));
    if (missing.length) {
      process.env.PATH = [...missing, currentPath]
        .filter(Boolean)
        .join(path.delimiter);
    }
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

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logMain().error("crash", "render process gone", {
      reason: details.reason,
      exitCode: details.exitCode
    });
  });
  logMain().info("window", "main window created");

  initApplicationMenu();
  setupContextMenu(mainWindow, isDev);

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

  mainWindow.on("focus", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.flashFrame(false);
    }
    if (process.platform === "darwin" && app.dock) {
      app.dock.setBadge("");
    }
  });

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

type TaskNotificationPayload = {
  kind: "success" | "failure";
  title: string;
  body?: string;
  conversationId?: string;
};

function registerTaskNotificationIpc(): void {
  ipcMain.handle("window:notify", (_event, payload: TaskNotificationPayload) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;

    if (process.platform === "win32") {
      win.flashFrame(true);
    }
    if (process.platform === "darwin" && app.dock) {
      app.dock.bounce("informational");
    }

    try {
      const notification = new Notification({
        title: payload.title,
        body: payload.body ?? "",
        silent: true,
        icon: loadAppIcon()
      });
      notification.on("click", () => {
        if (!win || win.isDestroyed()) return;
        try {
          // Restore from minimized/occluded state and raise to the foreground.
          // On Windows the notification click grants a brief SetForegroundWindow
          // permission to the app; claim it synchronously before focus() loses it.
          if (win.isMinimized()) win.restore();
          win.show();
          win.moveTop();
          win.focus();
          if (process.platform === "win32") win.flashFrame(false);
          logMain().info("window", "notification clicked", {
            visible: win.isVisible(),
            minimized: win.isMinimized(),
            focused: win.isFocused(),
            conversationId: payload.conversationId
          });
          if (payload.conversationId) {
            safeSendToWebContents(
              win.webContents,
              "window:open-conversation",
              payload.conversationId
            );
          }
        } catch (err) {
          logMain().error("window", "notification click handler failed", {
            message: (err as Error)?.message
          });
        }
      });
      notification.on("failed", (_e, error) => {
        logMain().error("window", "notification failed", { message: error });
      });
      notification.show();
    } catch {
      // Notifications are best-effort; ignore failures.
    }
  });
}

app.whenReady().then(async () => {
  initDebugLog();
  logMain().info("main", "app ready", {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch
  });
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
  logAllCliRuntimes();
  const existingOwner = getOwnerUser();
  if (existingOwner) {
    applyOwnerBackfill(existingOwner.id);
  }
  setLocalInvokeWindowGetter(() =>
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  );
  const remoteEnabled =
    getSetting("remote.enabled") === "1" || process.env.FB_REMOTE === "1";
  if (remoteEnabled) {
    const customPw = process.env.FB_REMOTE_PASSWORD;
    const { user, password } = ensureOwnerUser({
      password: customPw && customPw.length >= 8 ? customPw : undefined
    });
    applyOwnerBackfill(user.id);
    if (customPw && customPw.length >= 8) {
      console.log("[FreeBuddy] Remote access password (FB_REMOTE_PASSWORD):", customPw);
    } else if (password) {
      console.log("[FreeBuddy] Remote owner initial password:", password);
    } else {
      console.log("[FreeBuddy] Remote access enabled (owner already configured).");
    }
  }
  const distDir = path.join(__dirname, "..", "dist");
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  initRemoteControl({ distDir, devServerUrl });
  void startWebUIServer({
    allowRemote: remoteEnabled,
    bindMode: getConfiguredBindMode(),
    port: getConfiguredPort(),
    distDir,
    devServerUrl
  });
  initializeAgentUsageReconciler();
  initializeTelemetry();
  cleanupOrphanManagedAttachments();
  seedBuiltinSkills();
  seedBuiltinWorkflowTeams();
  registerCliIpc();
  registerTaskNotificationIpc();
  bindConversationNotifier((conversationId) => {
    for (const win of BrowserWindow.getAllWindows()) {
      safeSendToWebContents(win.webContents, "messages://changed", { conversationId });
    }
  });
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
