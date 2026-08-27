import { app, BrowserWindow, crashReporter, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, protocol, screen, shell } from "electron";
import type { WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shellEnv } from "shell-env";

import { registerCliIpc } from "./cli/ipc.js";
import { logAllCliRuntimes, startCodexToolchainAutoUpdate } from "./cli/check.js";
import { safeSendToWebContents } from "./cli/ipcSend.js";
import { handleFreebuddyFileRequest } from "./freebuddyFileProtocol.js";
import { handleBrowserRequest } from "./browserProtocol.js";
import { startPreviewServer } from "./previewServer.js";
import { startWebUIServer } from "./webUIServer.js";
import { setLocalInvokeWindowGetter, registerHandler } from "./invokeRegistry.js";
import { setButlerAppWindowGetter } from "./butlerToolService.js";
import { ensureOwnerUser, getOwnerUser } from "./cli/users.js";
import {
  bindConversationNotifier,
  getConversation,
  requireOwnedConversation,
  updateConversationMetadata
} from "./cli/conversations.js";
import { bindDelegationRunFinishedNotifier } from "./cli/delegationRuns.js";
import { applyOwnerBackfill } from "./cli/ownerBackfill.js";
import { initFileBridge } from "./fileBridge.js";
import { getDb } from "./cli/db.js";
import { getSetting, setSetting } from "./cli/settings.js";
import {
  handleGetGameState,
  handlePlayerMove,
  handlePlayerResign,
  handleAgentMove,
  handleSendChat,
  handleResetGame,
  initGamePersistence
} from "./gameToolService.js";
import {
  initRemoteControl,
  getConfiguredBindMode,
  getConfiguredPort
} from "./cli/remoteControl.js";
import { cleanupOrphanManagedAttachments } from "./cli/attachments.js";
import { seedBuiltinWorkflowTeams } from "./cli/workflowTeams.js";
import { seedBuiltinDelegationTeams } from "./cli/delegationTeams.js";
import { seedBuiltinSkills } from "./cli/skills.js";
import { initApplicationMenu, setupContextMenu } from "./menu.js";
import { APP_NAME, APP_VERSION } from "./app-meta.js";
import { initAutoUpdater, registerUpdaterIpc } from "./updater.js";
import { initializeScheduledTaskScheduler } from "./cli/scheduledTasks.js";
import { initializeTelemetry, shutdownTelemetry } from "./telemetry.js";
import { getFreshWindowsEnvironment } from "./cli/windowsEnv.js";
import { initializeAgentUsageReconciler } from "./cli/usageReconciler.js";
import { initDebugLog, logMain } from "./debugLog.js";
import {
  clearMainWindowPresence,
  setMainWindowPresence,
  getMainWindowPresence,
  resolveButlerBuddyTaskPresence,
  type ButlerBuddyTaskKind
} from "./uiPresence.js";
import { createAppTray, type TrayController } from "./tray.js";
import {
  createButlerBuddyStateCoordinator,
  millisecondsUntilNextButlerBuddySleepBoundary,
  normalizeButlerBuddyTaskText
} from "./butlerBuddyState.js";
import {
  broadcastButlerBuddyPreferences
} from "./butlerBuddyPreferences.js";
import {
  displayChangedForScreenBall,
  disposeScreenBallSession,
  isCurrentScreenBallSession,
  snapshotScreenBallDisplay,
  shouldCaptureScreenBallPointer,
  type ScreenBallDisplaySnapshot,
  type ScreenBallHitRegion,
  type ScreenBallSession
} from "./butlerBuddyScreenBall.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

if (!app.isPackaged) {
  app.setName("FreeBuddy Dev");
  app.setPath("userData", path.join(app.getPath("appData"), "freebuddy-dev"));
  app.setAppUserModelId("dev.freebuddy.app.dev");
} else {
  app.setName(APP_NAME);
  app.setAppUserModelId("dev.freebuddy.app");
}
if (process.platform === "darwin") {
  app.setActivationPolicy("regular");
}
process.env.FB_APP_VERSION = APP_VERSION;
app.setAboutPanelOptions({
  applicationName: app.isPackaged ? APP_NAME : `${APP_NAME} (Dev)`,
  applicationVersion: APP_VERSION,
  version: APP_VERSION
});
crashReporter.start({
  productName: app.isPackaged ? APP_NAME : `${APP_NAME} Dev`,
  uploadToServer: false,
  compress: false
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
  revealMainWindow();
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

function resolveTrayIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "tray-icon.png")
    : path.join(__dirname, "../assets/sidebar-logo.png");
}

function loadTrayIcon() {
  const icon = nativeImage.createFromPath(resolveTrayIconPath());
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
    scheme: "freebuddy-browser",
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

function registerBrowserProtocol() {
  protocol.handle("freebuddy-browser", handleBrowserRequest);
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
let isQuittingApp = false;
let trayController: TrayController | null = null;
let butlerPetWindow: BrowserWindow | null = null;
let butlerChatWindow: BrowserWindow | null = null;
let butlerChatReady = false;
let butlerScreenBallWindow: BrowserWindow | null = null;
let butlerScreenBallSession: ScreenBallSession | null = null;
let butlerScreenBallHitRegions: ScreenBallHitRegion[] = [];
let butlerScreenBallMouseCapture: boolean | null = null;
let butlerScreenBallPointerTimer: ReturnType<typeof setInterval> | null = null;
let butlerScreenBallSessionSequence = 0;
const butlerBuddyStateCoordinator = createButlerBuddyStateCoordinator();
let butlerBuddySleepBoundaryTimer: ReturnType<typeof setTimeout> | null = null;
let butlerBuddyTask: {
  conversationId: string;
  taskText?: string;
  taskKind: ButlerBuddyTaskKind;
  taskCount: number;
} | null = null;

const RENDERER_RECOVERY_WINDOW_MS = 60_000;
const MAX_RENDERER_RECOVERIES_PER_WINDOW = 2;
const rendererRecoveryAttempts: number[] = [];

function rendererProcessMetrics() {
  try {
    return app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      memoryWorkingSetKb: metric.memory.workingSetSize,
      memoryPeakWorkingSetKb: metric.memory.peakWorkingSetSize
    }));
  } catch {
    return [];
  }
}

function recoverMainRenderer(win: BrowserWindow, reason: string): void {
  if (reason !== "crashed" && reason !== "oom" && reason !== "memory-eviction") {
    return;
  }
  const now = Date.now();
  while (
    rendererRecoveryAttempts.length > 0 &&
    now - rendererRecoveryAttempts[0] > RENDERER_RECOVERY_WINDOW_MS
  ) {
    rendererRecoveryAttempts.shift();
  }
  if (rendererRecoveryAttempts.length >= MAX_RENDERER_RECOVERIES_PER_WINDOW) {
    logMain().error("crash", "renderer auto-recovery suppressed", {
      reason,
      attempts: rendererRecoveryAttempts.length
    });
    return;
  }
  rendererRecoveryAttempts.push(now);
  setTimeout(() => {
    if (isQuittingApp || mainWindow !== win || win.isDestroyed()) return;
    logMain().info("crash", "reloading main window after renderer crash", {
      reason,
      attempt: rendererRecoveryAttempts.length
    });
    win.webContents.reload();
  }, 250);
}

const BUTLER_CHAT_WIDTH = 360;
const BUTLER_CHAT_HEIGHT = 420;
const BUTLER_PET_SIZE = 108;
const BUTLER_WINDOW_GAP = 6;
const BUTLER_VISIBLE_SETTING = "butlerbuddy.visible";
const BUTLER_SHORTCUT_ENABLED_SETTING = "butlerbuddy.shortcut.enabled";
const BUTLER_SHORTCUT_SETTING = "butlerbuddy.shortcut";
const BUTLER_DEFAULT_SHORTCUT = "CommandOrControl+Shift+Space";
const BUTLER_MAIN_WINDOW_SHORTCUT_ENABLED_SETTING =
  "butlerbuddy.mainWindowShortcut.enabled";
const BUTLER_MAIN_WINDOW_SHORTCUT_SETTING = "butlerbuddy.mainWindowShortcut";
const BUTLER_DEFAULT_MAIN_WINDOW_SHORTCUT = "CommandOrControl+Shift+M";

type ButlerBuddyPreferences = {
  visible: boolean;
  shortcutEnabled: boolean;
  shortcut: string;
  shortcutRegistered: boolean;
  error?: "shortcutUnavailable";
  mainWindowShortcutEnabled: boolean;
  mainWindowShortcut: string;
  mainWindowShortcutRegistered: boolean;
  mainWindowShortcutError?: "shortcutUnavailable";
};

let registeredButlerShortcut: string | null = null;
let butlerShortcutError: "shortcutUnavailable" | undefined;
let registeredButlerMainWindowShortcut: string | null = null;
let butlerMainWindowShortcutError: "shortcutUnavailable" | undefined;

function readButlerBuddyPreferences(): ButlerBuddyPreferences {
  const visible = getSetting(BUTLER_VISIBLE_SETTING) !== "false";
  const shortcutEnabled =
    getSetting(BUTLER_SHORTCUT_ENABLED_SETTING) !== "false";
  const shortcut =
    getSetting(BUTLER_SHORTCUT_SETTING)?.trim() || BUTLER_DEFAULT_SHORTCUT;
  const mainWindowShortcutEnabled =
    getSetting(BUTLER_MAIN_WINDOW_SHORTCUT_ENABLED_SETTING) !== "false";
  const mainWindowShortcut =
    getSetting(BUTLER_MAIN_WINDOW_SHORTCUT_SETTING)?.trim() ||
    BUTLER_DEFAULT_MAIN_WINDOW_SHORTCUT;
  return {
    visible,
    shortcutEnabled,
    shortcut,
    shortcutRegistered:
      shortcutEnabled &&
      registeredButlerShortcut === shortcut &&
      globalShortcut.isRegistered(shortcut),
    error: butlerShortcutError,
    mainWindowShortcutEnabled,
    mainWindowShortcut,
    mainWindowShortcutRegistered:
      mainWindowShortcutEnabled &&
      registeredButlerMainWindowShortcut === mainWindowShortcut &&
      globalShortcut.isRegistered(mainWindowShortcut),
    mainWindowShortcutError: butlerMainWindowShortcutError
  };
}

function windowOwnsWebContents(
  win: BrowserWindow | null,
  sender: WebContents
): boolean {
  return Boolean(win && !win.isDestroyed() && win.webContents === sender);
}

function isButlerBuddyWindowSender(sender: WebContents): boolean {
  return (
    windowOwnsWebContents(mainWindow, sender) ||
    windowOwnsWebContents(butlerPetWindow, sender) ||
    windowOwnsWebContents(butlerChatWindow, sender)
  );
}

function isButlerScreenBallWindowSender(sender: WebContents): boolean {
  return windowOwnsWebContents(butlerScreenBallWindow, sender);
}

function isButlerBuddyTaskResultSender(sender: WebContents): boolean {
  return (
    windowOwnsWebContents(mainWindow, sender) ||
    windowOwnsWebContents(butlerChatWindow, sender)
  );
}

function getButlerBuddyRuntimeState() {
  const snapshot = butlerBuddyStateCoordinator.getState();
  return butlerBuddyTask
    ? {
        ...snapshot,
        taskConversationId: butlerBuddyTask.conversationId,
        taskKind: butlerBuddyTask.taskKind,
        taskCount: butlerBuddyTask.taskCount,
        ...(butlerBuddyTask.taskText
          ? { taskText: butlerBuddyTask.taskText }
          : {})
      }
    : snapshot;
}

function broadcastButlerBuddyRuntimeState(): void {
  const snapshot = getButlerBuddyRuntimeState();
  for (const win of [butlerPetWindow, butlerChatWindow]) {
    if (!win || win.isDestroyed()) continue;
    safeSendToWebContents(
      win.webContents,
      "butlerBuddy:runtimeStateChanged",
      snapshot
    );
  }
}

butlerBuddyStateCoordinator.subscribe(broadcastButlerBuddyRuntimeState);

function scheduleButlerBuddySleepBoundary(): void {
  if (butlerBuddySleepBoundaryTimer !== null) {
    clearTimeout(butlerBuddySleepBoundaryTimer);
  }
  butlerBuddySleepBoundaryTimer = setTimeout(() => {
    butlerBuddySleepBoundaryTimer = null;
    butlerBuddyStateCoordinator.refresh();
    scheduleButlerBuddySleepBoundary();
  }, Math.max(1_000, millisecondsUntilNextButlerBuddySleepBoundary()));
}

function companionWebPreferences() {
  return {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false
  };
}

function loadCompanionSurface(
  win: BrowserWindow,
  surface: "butler-pet" | "butler-chat" | "butler-screen-ball"
) {
  if (isDev) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL as string);
    url.searchParams.set("surface", surface);
    void win.loadURL(url.toString());
    return;
  }
  void win.loadFile(path.join(__dirname, "../dist/index.html"), {
    query: { surface }
  });
}

function currentButlerScreenBallDisplay(): ScreenBallDisplaySnapshot | null {
  const pet = butlerPetWindow;
  if (!pet || pet.isDestroyed()) return null;
  return snapshotScreenBallDisplay(screen.getDisplayMatching(pet.getBounds()));
}

function currentButlerScreenBallSessionPayload() {
  if (!butlerScreenBallSession) return null;
  const pet = butlerPetWindow;
  const petBounds = pet && !pet.isDestroyed() ? pet.getBounds() : null;
  const display = butlerScreenBallSession.display;
  return {
    sessionId: butlerScreenBallSession.id,
    display,
    petOrigin: petBounds
      ? {
          x: petBounds.x + petBounds.width / 2 - display.x,
          y: petBounds.y + petBounds.height / 2 - display.y
        }
      : {
          x: display.width / 2,
          y: display.height - 48
        }
  };
}

function sendButlerScreenBallSession(): void {
  const win = butlerScreenBallWindow;
  const payload = currentButlerScreenBallSessionPayload();
  if (!win || win.isDestroyed() || !payload) return;
  safeSendToWebContents(win.webContents, "butlerBuddy:screenBallSession", payload);
}

function setButlerScreenBallMouseCapture(capture: boolean): void {
  const win = butlerScreenBallWindow;
  if (!win || win.isDestroyed()) return;
  if (butlerScreenBallMouseCapture === capture) return;
  butlerScreenBallMouseCapture = capture;
  win.setIgnoreMouseEvents(!capture, { forward: true });
}

function pollButlerScreenBallPointer(): void {
  const win = butlerScreenBallWindow;
  if (!win || win.isDestroyed() || !butlerScreenBallSession) return;
  const point = screen.getCursorScreenPoint();
  const capture = shouldCaptureScreenBallPointer(butlerScreenBallHitRegions, point);
  setButlerScreenBallMouseCapture(capture);
}

function stopButlerScreenBallPointerPolling(): void {
  if (butlerScreenBallPointerTimer !== null) {
    clearInterval(butlerScreenBallPointerTimer);
    butlerScreenBallPointerTimer = null;
  }
}

function startButlerScreenBallPointerPolling(): void {
  stopButlerScreenBallPointerPolling();
  butlerScreenBallPointerTimer = setInterval(
    pollButlerScreenBallPointer,
    1000 / 30
  );
  pollButlerScreenBallPointer();
}

function closeButlerScreenBallWindow(): void {
  stopButlerScreenBallPointerPolling();
  butlerScreenBallHitRegions = [];
  butlerScreenBallMouseCapture = null;
  const win = butlerScreenBallWindow;
  butlerScreenBallWindow = null;
  butlerScreenBallSession = disposeScreenBallSession(butlerScreenBallSession);
  if (win && !win.isDestroyed()) win.close();
}

function restartButlerScreenBallSession(
  display = currentButlerScreenBallDisplay()
): void {
  if (!display || !butlerPetWindow || butlerPetWindow.isDestroyed()) {
    closeButlerScreenBallWindow();
    return;
  }
  butlerScreenBallSessionSequence += 1;
  butlerScreenBallHitRegions = [];
  butlerScreenBallMouseCapture = null;
  butlerScreenBallSession = {
    id: `screen-ball-${Date.now()}-${butlerScreenBallSessionSequence}`,
    display
  };
  const bounds = {
    x: display.x,
    y: display.y,
    width: display.width,
    height: display.height
  };
  const existing = butlerScreenBallWindow;
  if (!existing || existing.isDestroyed()) {
    const win = new BrowserWindow({
      ...bounds,
      type: process.platform === "darwin" ? "panel" : undefined,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: companionWebPreferences()
    });
    butlerScreenBallWindow = win;
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.on("closed", () => {
      if (butlerScreenBallWindow === win) {
        butlerScreenBallWindow = null;
        butlerScreenBallSession = null;
        stopButlerScreenBallPointerPolling();
      }
    });
    win.webContents.on("render-process-gone", () => {
      if (butlerScreenBallWindow === win) closeButlerScreenBallWindow();
    });
    loadCompanionSurface(win, "butler-screen-ball");
    win.once("ready-to-show", () => {
      if (butlerScreenBallWindow !== win || win.isDestroyed()) return;
      win.showInactive();
      sendButlerScreenBallSession();
    });
  } else {
    existing.setBounds(bounds, false);
    sendButlerScreenBallSession();
  }
  startButlerScreenBallPointerPolling();
}

function startButlerScreenBallGame(): void {
  const preferences = readButlerBuddyPreferences();
  if (!preferences.visible) return;
  restartButlerScreenBallSession();
}

function updateButlerScreenBallDisplayAfterDrag(): void {
  if (!butlerScreenBallSession) return;
  const display = currentButlerScreenBallDisplay();
  if (!display) {
    closeButlerScreenBallWindow();
    return;
  }
  if (displayChangedForScreenBall(butlerScreenBallSession.display, display)) {
    restartButlerScreenBallSession(display);
    return;
  }
  if (!butlerScreenBallWindow || butlerScreenBallWindow.isDestroyed()) return;
  butlerScreenBallWindow.setBounds(
    { x: display.x, y: display.y, width: display.width, height: display.height },
    false
  );
  butlerScreenBallSession = { ...butlerScreenBallSession, display };
  sendButlerScreenBallSession();
}

function initialButlerPetBounds() {
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    width: BUTLER_PET_SIZE,
    height: BUTLER_PET_SIZE,
    x: workArea.x + workArea.width - BUTLER_PET_SIZE - 18,
    y: workArea.y + Math.round((workArea.height - BUTLER_PET_SIZE) / 2)
  };
}

function syncButlerChatPosition() {
  const pet = butlerPetWindow;
  const chat = butlerChatWindow;
  if (!pet || pet.isDestroyed() || !chat || chat.isDestroyed()) return;

  const petBounds = pet.getBounds();
  const workArea = screen.getDisplayMatching(petBounds).workArea;
  let x = petBounds.x - BUTLER_CHAT_WIDTH - BUTLER_WINDOW_GAP;
  if (x < workArea.x + 8) {
    x = petBounds.x + petBounds.width + BUTLER_WINDOW_GAP;
  }
  const idealY = petBounds.y - Math.round((BUTLER_CHAT_HEIGHT - petBounds.height) / 2);
  const y = Math.max(
    workArea.y + 8,
    Math.min(idealY, workArea.y + workArea.height - BUTLER_CHAT_HEIGHT - 8)
  );
  chat.setPosition(Math.round(x), Math.round(y), false);
}

function hideButlerChat() {
  if (butlerChatWindow && !butlerChatWindow.isDestroyed()) {
    butlerChatWindow.hide();
  }
}

function revealButlerChat(
  chat: BrowserWindow,
  afterReveal?: () => void
): void {
  const reveal = () => {
    if (chat.isDestroyed() || butlerChatWindow !== chat) return;
    syncButlerChatPosition();
    chat.show();
    chat.focus();
    afterReveal?.();
  };
  if (!butlerChatReady) {
    chat.once("ready-to-show", reveal);
    return;
  }
  reveal();
}

// The pet and chat move as a rigid group: dragging either translates both by
// the same delta, preserving whatever offset the user chose.
//
// Both surfaces only signal begin/end (via pointer events in their renderers);
// this poll drives the actual movement so the transparent, non-focusable pet
// window doesn't need to receive pointermove on Windows. The poll moves BOTH
// windows directly, so no `move`-event listener is used — relying on `move`
// events here previously caused the pet to drift away from the chat, because
// on Windows `getBounds()` immediately after `setPosition` can return stale
// bounds and the async move event then double-translated the pet.
let butlerDragCursor: { x: number; y: number } | null = null;
let butlerDragPetOrigin: { x: number; y: number } | null = null;
let butlerDragChatOrigin: { x: number; y: number } | null = null;
let butlerDragTimer: ReturnType<typeof setInterval> | null = null;

function applyButlerPetDrag() {
  if (!butlerDragCursor || !butlerDragPetOrigin) return;
  const pet = butlerPetWindow;
  if (!pet || pet.isDestroyed()) {
    stopButlerPetDrag();
    return;
  }
  const c = screen.getCursorScreenPoint();
  const dx = c.x - butlerDragCursor.x;
  const dy = c.y - butlerDragCursor.y;
  pet.setPosition(butlerDragPetOrigin.x + dx, butlerDragPetOrigin.y + dy);
  const chat = butlerChatWindow;
  if (chat && !chat.isDestroyed() && butlerDragChatOrigin) {
    chat.setPosition(butlerDragChatOrigin.x + dx, butlerDragChatOrigin.y + dy);
  }
}

function startButlerPetDrag() {
  const pet = butlerPetWindow;
  if (!pet || pet.isDestroyed() || butlerDragCursor) return;
  const [px, py] = pet.getPosition();
  butlerDragCursor = screen.getCursorScreenPoint();
  butlerDragPetOrigin = { x: px, y: py };
  const chat = butlerChatWindow;
  if (chat && !chat.isDestroyed()) {
    const [cx, cy] = chat.getPosition();
    butlerDragChatOrigin = { x: cx, y: cy };
  } else {
    butlerDragChatOrigin = null;
  }
  if (butlerDragTimer) clearInterval(butlerDragTimer);
  butlerDragTimer = setInterval(applyButlerPetDrag, 1000 / 60);
}

function stopButlerPetDrag() {
  butlerDragCursor = null;
  butlerDragPetOrigin = null;
  butlerDragChatOrigin = null;
  if (butlerDragTimer) {
    clearInterval(butlerDragTimer);
    butlerDragTimer = null;
  }
  updateButlerScreenBallDisplayAfterDrag();
}

function toggleButlerChat() {
  const existing = butlerChatWindow;
  if (existing && !existing.isDestroyed() && existing.isVisible()) {
    existing.hide();
    return;
  }
  const chat = ensureButlerChatWindow();
  revealButlerChat(chat);
}

function updateButlerShortcutRegistration(
  enabled: boolean,
  shortcut: string
): "shortcutUnavailable" | undefined {
  if (!enabled) {
    if (registeredButlerShortcut) {
      globalShortcut.unregister(registeredButlerShortcut);
      registeredButlerShortcut = null;
    }
    butlerShortcutError = undefined;
    return;
  }

  if (
    registeredButlerShortcut === shortcut &&
    globalShortcut.isRegistered(shortcut)
  ) {
    butlerShortcutError = undefined;
    return;
  }

  try {
    if (!globalShortcut.register(shortcut, toggleButlerChat)) {
      butlerShortcutError = "shortcutUnavailable";
      return butlerShortcutError;
    }
  } catch {
    butlerShortcutError = "shortcutUnavailable";
    return butlerShortcutError;
  }

  if (registeredButlerShortcut && registeredButlerShortcut !== shortcut) {
    globalShortcut.unregister(registeredButlerShortcut);
  }
  registeredButlerShortcut = shortcut;
  butlerShortcutError = undefined;
}

function updateButlerMainWindowShortcutRegistration(
  enabled: boolean,
  shortcut: string
): "shortcutUnavailable" | undefined {
  if (!enabled) {
    if (registeredButlerMainWindowShortcut) {
      globalShortcut.unregister(registeredButlerMainWindowShortcut);
      registeredButlerMainWindowShortcut = null;
    }
    butlerMainWindowShortcutError = undefined;
    return;
  }

  if (
    registeredButlerMainWindowShortcut === shortcut &&
    globalShortcut.isRegistered(shortcut)
  ) {
    butlerMainWindowShortcutError = undefined;
    return;
  }

  try {
    if (!globalShortcut.register(shortcut, revealMainWindow)) {
      butlerMainWindowShortcutError = "shortcutUnavailable";
      return butlerMainWindowShortcutError;
    }
  } catch {
    butlerMainWindowShortcutError = "shortcutUnavailable";
    return butlerMainWindowShortcutError;
  }

  if (
    registeredButlerMainWindowShortcut &&
    registeredButlerMainWindowShortcut !== shortcut
  ) {
    globalShortcut.unregister(registeredButlerMainWindowShortcut);
  }
  registeredButlerMainWindowShortcut = shortcut;
  butlerMainWindowShortcutError = undefined;
}

function applyButlerBuddyVisibility(visible: boolean) {
  if (visible) {
    const pet = butlerPetWindow;
    if (pet && !pet.isDestroyed()) pet.showInactive();
    else createButlerPetWindow();
    return;
  }
  closeButlerBuddyWindows();
}

function updateButlerBuddyPreferences(
  input: Partial<
    Pick<
      ButlerBuddyPreferences,
      | "visible"
      | "shortcutEnabled"
      | "shortcut"
      | "mainWindowShortcutEnabled"
      | "mainWindowShortcut"
    >
  >
): ButlerBuddyPreferences {
  const current = readButlerBuddyPreferences();
  const nextVisible = input.visible ?? current.visible;
  const nextEnabled = input.shortcutEnabled ?? current.shortcutEnabled;
  const nextShortcut = input.shortcut?.trim() || current.shortcut;
  const shortcutChanged =
    nextEnabled !== current.shortcutEnabled || nextShortcut !== current.shortcut;

  const nextMainWindowEnabled =
    input.mainWindowShortcutEnabled ?? current.mainWindowShortcutEnabled;
  const nextMainWindowShortcut =
    input.mainWindowShortcut?.trim() || current.mainWindowShortcut;
  const mainWindowShortcutChanged =
    nextMainWindowEnabled !== current.mainWindowShortcutEnabled ||
    nextMainWindowShortcut !== current.mainWindowShortcut;

  if (shortcutChanged) {
    const error = updateButlerShortcutRegistration(nextEnabled, nextShortcut);
    setSetting(BUTLER_SHORTCUT_ENABLED_SETTING, String(nextEnabled));
    setSetting(BUTLER_SHORTCUT_SETTING, nextShortcut);
    if (error) return { ...readButlerBuddyPreferences(), error };
  }

  if (mainWindowShortcutChanged) {
    const error = updateButlerMainWindowShortcutRegistration(
      nextMainWindowEnabled,
      nextMainWindowShortcut
    );
    setSetting(
      BUTLER_MAIN_WINDOW_SHORTCUT_ENABLED_SETTING,
      String(nextMainWindowEnabled)
    );
    setSetting(
      BUTLER_MAIN_WINDOW_SHORTCUT_SETTING,
      nextMainWindowShortcut
    );
    if (error) {
      return { ...readButlerBuddyPreferences(), mainWindowShortcutError: error };
    }
  }

  if (nextVisible !== current.visible) {
    setSetting(BUTLER_VISIBLE_SETTING, String(nextVisible));
    applyButlerBuddyVisibility(nextVisible);
  }

  const result = readButlerBuddyPreferences();
  // Push the new preferences to the main window so the settings toggle stays
  // in sync when the change originated from the main process (e.g. the pet's
  // right-click "关闭宠物" menu). Renderer-initiated updates already reflect
  // the IPC return value; this broadcast is idempotent for them.
  broadcastButlerBuddyPreferences(
    [mainWindow, butlerPetWindow, butlerChatWindow],
    result,
    safeSendToWebContents
  );
  return result;
}

function closeButlerBuddyWindows() {
  closeButlerScreenBallWindow();
  const chat = butlerChatWindow;
  const pet = butlerPetWindow;
  butlerChatWindow = null;
  butlerChatReady = false;
  butlerPetWindow = null;
  if (chat && !chat.isDestroyed()) chat.destroy();
  if (pet && !pet.isDestroyed()) pet.destroy();
}

function ensureButlerChatWindow(): BrowserWindow {
  if (butlerChatWindow && !butlerChatWindow.isDestroyed()) {
    return butlerChatWindow;
  }
  const chat = new BrowserWindow({
    width: BUTLER_CHAT_WIDTH,
    height: BUTLER_CHAT_HEIGHT,
    type: process.platform === "darwin" ? "panel" : undefined,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: companionWebPreferences()
  });
  butlerChatWindow = chat;
  butlerChatReady = false;
  chat.setAlwaysOnTop(true, "floating");
  chat.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  chat.once("ready-to-show", () => {
    if (butlerChatWindow === chat) butlerChatReady = true;
  });
  chat.on("closed", () => {
    if (butlerChatWindow !== chat) return;
    butlerChatWindow = null;
    butlerChatReady = false;
  });
  loadCompanionSurface(chat, "butler-chat");
  if (isDev) {
    // Detached DevTools so the companion renderer can be inspected when
    // debugging the floating chat (stream/done delivery, store state, etc.).
    chat.webContents.once("dom-ready", () => {
      if (!chat.isDestroyed()) chat.webContents.openDevTools({ mode: "detach" });
    });
  }
  return chat;
}

function createButlerPetWindow(): BrowserWindow {
  if (butlerPetWindow && !butlerPetWindow.isDestroyed()) {
    return butlerPetWindow;
  }
  const pet = new BrowserWindow({
    ...initialButlerPetBounds(),
    type: process.platform === "darwin" ? "panel" : undefined,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: companionWebPreferences()
  });
  butlerPetWindow = pet;
  pet.setAlwaysOnTop(true, "floating");
  pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pet.on("closed", () => {
    if (butlerPetWindow !== pet) return;
    closeButlerScreenBallWindow();
    hideButlerChat();
    butlerPetWindow = null;
  });
  pet.once("ready-to-show", () => {
    if (!pet.isDestroyed() && readButlerBuddyPreferences().visible) {
      pet.showInactive();
    }
  });
  loadCompanionSurface(pet, "butler-pet");
  return pet;
}

function showButlerContextMenu() {
  const screenBallActive = Boolean(butlerScreenBallSession);
  const prefs = readButlerBuddyPreferences();
  const menu = Menu.buildFromTemplate([
    {
      label: "显示主窗口",
      accelerator:
        prefs.mainWindowShortcutEnabled && prefs.mainWindowShortcutRegistered
          ? prefs.mainWindowShortcut
          : undefined,
      click: () => {
        revealMainWindow();
      }
    },
    { type: "separator" },
    {
      label: "新会话",
      click: () => {
        const chat = ensureButlerChatWindow();
        if (!chat.isVisible()) {
          revealButlerChat(chat, () => {
            safeSendToWebContents(
              chat.webContents,
              "butlerBuddy:newConversation",
              undefined
            );
          });
          return;
        }
        safeSendToWebContents(
          chat.webContents,
          "butlerBuddy:newConversation",
          undefined
        );
      }
    },
    { type: "separator" },
    {
      label: screenBallActive ? "结束游戏" : "和buddy一起玩",
      click: () =>
        screenBallActive
          ? closeButlerScreenBallWindow()
          : startButlerScreenBallGame()
    },
    { type: "separator" },
    {
      label: "今日战报…",
      click: () => {
        hideButlerChat();
        revealMainWindow();
        const win = mainWindow;
        if (!win || win.isDestroyed()) return;
        safeSendToWebContents(win.webContents, "window:open-task-receipt", undefined);
      }
    },
    { type: "separator" },
    {
      label: "关闭宠物",
      click: () => updateButlerBuddyPreferences({ visible: false })
    },
    { type: "separator" },
    {
      label: "浮窗与快捷键设置…",
      click: () => {
        const win = mainWindow;
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        safeSendToWebContents(win.webContents, "freebuddy://open-settings", {
          tab: "general"
        });
      }
    }
  ]);
  menu.popup({ window: butlerPetWindow ?? undefined });
}

function registerButlerBuddyWindowIpc() {
  ipcMain.on("butlerBuddy:toggleChat", toggleButlerChat);
  ipcMain.on("butlerBuddy:hideChat", hideButlerChat);
  ipcMain.on("butlerBuddy:beginDrag", startButlerPetDrag);
  ipcMain.on("butlerBuddy:endDrag", stopButlerPetDrag);
  ipcMain.on("butlerBuddy:openMenu", showButlerContextMenu);
  ipcMain.on("butlerBuddy:startScreenBall", (event) => {
    if (
      !isButlerBuddyWindowSender(event.sender) &&
      !isButlerScreenBallWindowSender(event.sender)
    ) {
      return;
    }
    startButlerScreenBallGame();
  });
  ipcMain.on("butlerBuddy:stopScreenBall", (event) => {
    if (
      !isButlerBuddyWindowSender(event.sender) &&
      !isButlerScreenBallWindowSender(event.sender)
    ) {
      return;
    }
    closeButlerScreenBallWindow();
  });
  ipcMain.handle("butlerBuddy:getScreenBallSession", (event) => {
    if (!isButlerScreenBallWindowSender(event.sender)) return null;
    return currentButlerScreenBallSessionPayload();
  });
  ipcMain.on(
    "butlerBuddy:screenBallHitRegions",
    (event, regions: unknown) => {
      if (!isButlerScreenBallWindowSender(event.sender)) return;
      if (!Array.isArray(regions)) return;
      butlerScreenBallHitRegions = regions
        .slice(0, 8)
        .filter((region): region is ScreenBallHitRegion => {
          if (!region || typeof region !== "object") return false;
          const value = region as Partial<ScreenBallHitRegion>;
          return (
            typeof value.id === "string" &&
            typeof value.x === "number" &&
            typeof value.y === "number" &&
            typeof value.width === "number" &&
            typeof value.height === "number" &&
            (value.kind === "ball" || value.kind === "control") &&
            Number.isFinite(value.x) &&
            Number.isFinite(value.y) &&
            Number.isFinite(value.width) &&
            Number.isFinite(value.height)
          );
        });
      pollButlerScreenBallPointer();
    }
  );
  ipcMain.on(
    "butlerBuddy:screenBallPointer",
    (event, point: { x?: unknown; y?: unknown }) => {
      if (!isButlerScreenBallWindowSender(event.sender)) return;
      if (
        typeof point?.x !== "number" ||
        typeof point.y !== "number" ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y)
      ) {
        return;
      }
      setButlerScreenBallMouseCapture(
        shouldCaptureScreenBallPointer(butlerScreenBallHitRegions, {
          x: point.x,
          y: point.y
        })
      );
    }
  );
  ipcMain.on(
    "butlerBuddy:screenBallHit",
    (event, payload: { sessionId?: unknown; ballId?: unknown }) => {
      if (!isButlerScreenBallWindowSender(event.sender)) return;
      if (
        typeof payload?.sessionId !== "string" ||
        typeof payload.ballId !== "string" ||
        !isCurrentScreenBallSession(butlerScreenBallSession, payload.sessionId)
      ) {
        return;
      }
      safeSendToWebContents(
        butlerScreenBallWindow?.webContents,
        "butlerBuddy:screenBallHitAccepted",
        { sessionId: payload.sessionId, ballId: payload.ballId }
      );
    }
  );
  ipcMain.on("butlerBuddy:screenBallClose", (event, sessionId: unknown) => {
    if (!isButlerScreenBallWindowSender(event.sender)) return;
    if (
      typeof sessionId === "string" &&
      isCurrentScreenBallSession(butlerScreenBallSession, sessionId)
    ) {
      closeButlerScreenBallWindow();
    }
  });
  ipcMain.on("butlerBuddy:openCurrentTask", (event) => {
    if (!isButlerBuddyWindowSender(event.sender)) return;
    const conversationId = butlerBuddyTask?.conversationId;
    if (!conversationId) return;
    hideButlerChat();
    revealMainWindow();
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    safeSendToWebContents(
      win.webContents,
      "window:open-conversation",
      conversationId
    );
  });
  ipcMain.on("freebuddy:uiPresence", (event, payload) => {
    const win = mainWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    if (setMainWindowPresence(payload)) {
      const presence = getMainWindowPresence();
      const previousState = butlerBuddyStateCoordinator.getState();
      const resolvedTask = presence
        ? resolveButlerBuddyTaskPresence(presence)
        : null;
      const nextTask = resolvedTask
        ? {
            conversationId: resolvedTask.conversationId,
            taskText: normalizeButlerBuddyTaskText(resolvedTask.taskText),
            taskKind: resolvedTask.taskKind,
            taskCount: resolvedTask.taskCount
          }
        : null;
      const taskChanged =
        butlerBuddyTask?.conversationId !== nextTask?.conversationId ||
        butlerBuddyTask?.taskText !== nextTask?.taskText ||
        butlerBuddyTask?.taskKind !== nextTask?.taskKind ||
        butlerBuddyTask?.taskCount !== nextTask?.taskCount;
      butlerBuddyTask = nextTask;
      butlerBuddyStateCoordinator.setStreaming(
        Boolean(presence?.runningTasks.length)
      );
      if (
        taskChanged &&
        previousState === butlerBuddyStateCoordinator.getState()
      ) {
        broadcastButlerBuddyRuntimeState();
      }
      applyUnreadBadge(presence?.unreadCount ?? 0);
    }
  });
  ipcMain.on("freebuddy:themeBroadcast", (event, theme) => {
    if (theme !== "system" && theme !== "light" && theme !== "dark") return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents === event.sender) continue;
      safeSendToWebContents(win.webContents, "freebuddy://appearance-changed", {
        theme
      });
    }
  });
  ipcMain.handle("butlerBuddy:getPreferences", () =>
    readButlerBuddyPreferences()
  );
  ipcMain.handle("butlerBuddy:getRuntimeState", (event) => {
    if (!isButlerBuddyWindowSender(event.sender)) return undefined;
    return getButlerBuddyRuntimeState();
  });
  ipcMain.on("butlerBuddy:reportTaskResult", (event, result: unknown) => {
    if (!isButlerBuddyTaskResultSender(event.sender)) return;
    butlerBuddyStateCoordinator.reportTaskResult(result);
  });
  registerHandler("game:getState", (_event, conversationId: string) => {
    if (!requireOwnedConversation(conversationId)) return undefined;
    return handleGetGameState(conversationId, _event.sender);
  });
  registerHandler(
    "game:playerMove",
    (event, payload: { conversationId: string; actionId: string }) => {
      if (!requireOwnedConversation(payload.conversationId)) {
        return { ok: false, error: "conversation_not_found" };
      }
      return handlePlayerMove(payload.conversationId, payload.actionId, event.sender);
    }
  );
  registerHandler(
    "game:agentMove",
    (
      event,
      payload: {
        conversationId: string;
        actionId: string;
        reason?: string;
        speech?: string;
        mood?: "confident" | "mocking" | "nervous" | "calm" | "admiring";
      }
    ) => {
      if (!requireOwnedConversation(payload.conversationId)) {
        return { ok: false, error: "conversation_not_found" };
      }
      return handleAgentMove(
        payload.conversationId,
        payload.actionId,
        payload.reason,
        payload.speech,
        payload.mood,
        event.sender
      );
    }
  );
  registerHandler(
    "game:sendChat",
    (
      event,
      payload: {
        conversationId: string;
        message: string;
        mood?: "confident" | "mocking" | "nervous" | "calm" | "admiring";
      }
    ) => {
      if (!requireOwnedConversation(payload.conversationId)) {
        return { ok: false, error: "conversation_not_found" };
      }
      return handleSendChat(
        payload.conversationId,
        payload.message,
        payload.mood,
        event.sender
      );
    }
  );
  registerHandler("game:resetGame", (event, conversationId: string) => {
    if (!requireOwnedConversation(conversationId)) {
      return { ok: false, error: "conversation_not_found" };
    }
    return handleResetGame(conversationId, event.sender);
  });
  registerHandler("game:playerResign", (event, conversationId: string) => {
    if (!requireOwnedConversation(conversationId)) {
      return { ok: false, error: "conversation_not_found" };
    }
    return handlePlayerResign(conversationId, event.sender);
  });
  ipcMain.handle(
    "butlerBuddy:updatePreferences",
    (
      _event,
      input: Partial<
        Pick<
          ButlerBuddyPreferences,
          | "visible"
          | "shortcutEnabled"
          | "shortcut"
          | "mainWindowShortcutEnabled"
          | "mainWindowShortcut"
        >
      >
    ) => updateButlerBuddyPreferences(input)
  );
}

function windowChromeOptions() {
  return process.platform === "darwin"
    ? {
        titleBarStyle: "hiddenInset" as const,
        trafficLightPosition: { x: 14, y: 14 }
      }
    : {};
}

function revealMainWindow() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.moveTop();
  win.focus();
}

function quitApp() {
  isQuittingApp = true;
  app.quit();
}

function applyUnreadBadge(count: number) {
  // setBadgeCount is supported on macOS (Dock badge) and Linux (Unity launcher);
  // it is unsupported on Windows, so guard it. On Windows the unread count is
  // still surfaced via the tray tooltip and context-menu label.
  if (process.platform !== "win32") {
    app.setBadgeCount(count);
  }
  trayController?.setUnreadCount(count);
}

function createTrayForApp() {
  trayController = createAppTray({
    getMainWindow: () => mainWindow,
    getIcon: () => loadAppIcon(),
    getTrayIcon: () => loadTrayIcon(),
    isPetVisible: () => readButlerBuddyPreferences().visible,
    getUnreadCount: () => getMainWindowPresence()?.unreadCount ?? 0,
    onNewConversation: () => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      safeSendToWebContents(win.webContents, "window:new-conversation", undefined);
    },
    onTogglePet: () => {
      const next = !readButlerBuddyPreferences().visible;
      updateButlerBuddyPreferences({ visible: next });
      trayController?.refresh();
    },
    onQuit: () => quitApp()
  });
}

function createWindow() {
  const appIcon = loadAppIcon();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: app.isPackaged ? APP_NAME : `${APP_NAME} [DEV]`,
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

  mainWindow.on("close", (event) => {
    if (isQuittingApp) {
      return;
    }
    const win = mainWindow;
    if (!win || win.isDestroyed()) {
      return;
    }
    event.preventDefault();
    win.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    clearMainWindowPresence();
    butlerBuddyTask = null;
    butlerBuddyStateCoordinator.setStreaming(false);
    closeButlerBuddyWindows();
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logMain().error("crash", "render process gone", {
      reason: details.reason,
      exitCode: details.exitCode,
      processes: rendererProcessMetrics()
    });
    const crashedWindow = mainWindow;
    if (crashedWindow) recoverMainRenderer(crashedWindow, details.reason);
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
  });

  // With titleBarStyle: "hiddenInset", macOS' default Esc-to-leave-fullscreen
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

  if (readButlerBuddyPreferences().visible) {
    createButlerPetWindow();
  }
}

type TaskNotificationPayload = {
  kind: "success" | "failure";
  title: string;
  body?: string;
  conversationId?: string;
};

type SaveReceiptImagePayload = {
  dataUrl: string;
  suggestedName?: string;
};

function registerTaskNotificationIpc(): void {
  ipcMain.handle(
    "window:save-image",
    async (event, payload: SaveReceiptImagePayload) => {
      const win = mainWindow;
      if (
        !win ||
        win.isDestroyed() ||
        event.sender !== win.webContents ||
        !payload ||
        typeof payload.dataUrl !== "string" ||
        !payload.dataUrl.startsWith("data:image/png;base64,") ||
        payload.dataUrl.length > 12_000_000
      ) {
        throw new Error("Invalid receipt image");
      }
      const image = nativeImage.createFromDataURL(payload.dataUrl);
      if (image.isEmpty()) throw new Error("Receipt image is empty");
      const suggested =
        typeof payload.suggestedName === "string"
          ? path.basename(payload.suggestedName).replace(/[^\w.\-\u4e00-\u9fff]+/g, "-")
          : "FreeBuddy-task-receipt.png";
      const fileName = suggested.toLowerCase().endsWith(".png")
        ? suggested
        : `${suggested}.png`;
      const result = await dialog.showSaveDialog(win, {
        title: "保存今日任务收据",
        defaultPath: path.join(app.getPath("pictures"), fileName),
        filters: [{ name: "PNG Image", extensions: ["png"] }]
      });
      if (result.canceled || !result.filePath) return {};
      await fs.promises.writeFile(result.filePath, image.toPNG());
      return { path: result.filePath };
    }
  );
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
  scheduleButlerBuddySleepBoundary();
  logMain().info("main", "app ready", {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch
  });
  await injectShellPath();
  registerLocalFileProtocol();
  registerBrowserProtocol();
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
  setButlerAppWindowGetter(() =>
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
  initGamePersistence(getConversation, updateConversationMetadata);
  seedBuiltinSkills();
  seedBuiltinWorkflowTeams();
  seedBuiltinDelegationTeams();
  registerCliIpc();
  registerTaskNotificationIpc();
  registerButlerBuddyWindowIpc();
  bindConversationNotifier((conversationId) => {
    for (const win of BrowserWindow.getAllWindows()) {
      safeSendToWebContents(win.webContents, "messages://changed", { conversationId });
    }
  });
  bindDelegationRunFinishedNotifier((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      safeSendToWebContents(win.webContents, "delegation://finished", event);
    }
  });
  registerUpdaterIpc({
    beforeQuitAndInstall: async () => {
      isQuittingApp = true;
      closeButlerScreenBallWindow();
      if (butlerBuddySleepBoundaryTimer !== null) {
        clearTimeout(butlerBuddySleepBoundaryTimer);
        butlerBuddySleepBoundaryTimer = null;
      }
      butlerBuddyStateCoordinator.dispose();
      trayController?.destroy();
      trayController = null;
      closeButlerBuddyWindows();
      if (!telemetryShutdownStarted) {
        telemetryShutdownStarted = true;
        await shutdownTelemetry().catch(() => {});
      }
      try {
        const { shutdownRuntimeProcesses } = await import("./runtime/runtimeIpc.js");
        await shutdownRuntimeProcesses();
      } catch {
        /* runtime manager may not have started */
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.removeAllListeners("close");
          win.destroy();
        }
      }
    }
  });
  const appIcon = loadAppIcon();
  if (process.platform === "darwin" && app.dock) {
    void app.dock.show();
    if (appIcon) {
      app.dock.setIcon(appIcon);
    }
  }
  createWindow();
  screen.on("display-metrics-changed", () => {
    updateButlerScreenBallDisplayAfterDrag();
  });
  screen.on("display-removed", () => {
    if (!butlerScreenBallSession) return;
    const display = currentButlerScreenBallDisplay();
    if (!display) closeButlerScreenBallWindow();
    else if (displayChangedForScreenBall(butlerScreenBallSession.display, display)) {
      restartButlerScreenBallSession(display);
    }
  });
  if (process.platform === "darwin") {
    app.focus();
  }
  createTrayForApp();
  const butlerPreferences = readButlerBuddyPreferences();
  const shortcutError = updateButlerShortcutRegistration(
    butlerPreferences.shortcutEnabled,
    butlerPreferences.shortcut
  );
  if (shortcutError) {
    logMain().warn("butlerbuddy", "global shortcut unavailable", {
      shortcut: butlerPreferences.shortcut
    });
  }
  const mainWindowShortcutError = updateButlerMainWindowShortcutRegistration(
    butlerPreferences.mainWindowShortcutEnabled,
    butlerPreferences.mainWindowShortcut
  );
  if (mainWindowShortcutError) {
    logMain().warn("butlerbuddy", "global main window shortcut unavailable", {
      shortcut: butlerPreferences.mainWindowShortcut
    });
  }
  initializeScheduledTaskScheduler(() =>
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined
  );
  void startCodexToolchainAutoUpdate();
  initAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      revealMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // The app lives in the tray. Only the tray's "Quit" entry or an explicit
  // Cmd+Q / before-quit should terminate the process.
});

let telemetryShutdownStarted = false;
app.on("before-quit", (event) => {
  isQuittingApp = true;
  closeButlerScreenBallWindow();
  if (butlerBuddySleepBoundaryTimer !== null) {
    clearTimeout(butlerBuddySleepBoundaryTimer);
    butlerBuddySleepBoundaryTimer = null;
  }
  butlerBuddyStateCoordinator.dispose();
  trayController?.destroy();
  trayController = null;
  if (telemetryShutdownStarted) return;
  telemetryShutdownStarted = true;
  event.preventDefault();
  void shutdownTelemetry().finally(() => app.quit());
});
