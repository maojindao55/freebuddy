import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import { safeSendToWebContents } from "./cli/ipcSend.js";
import { isKnownBridgeAction } from "./agentBridge.js";

let activeWatcher: fs.FSWatcher | null = null;
let backupPollInterval: NodeJS.Timeout | null = null;
let currentCwd: string | null = null;
let webContentsGetter: (() => WebContents | null) | null = null;

const processingFiles = new Set<string>();

let retryCount = 0;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;
let retryTimeout: NodeJS.Timeout | null = null;

export function initFileBridge(getter: () => WebContents | null): void {
  webContentsGetter = getter;
}

export function stopWatchingFileBridge(): void {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
  retryCount = 0;

  if (backupPollInterval) {
    clearInterval(backupPollInterval);
    backupPollInterval = null;
  }

  if (activeWatcher) {
    try {
      activeWatcher.close();
    } catch (err: any) {
      console.warn("[FreeBuddy] Failed to close file bridge watcher:", err);
    }
    activeWatcher = null;
  }
  currentCwd = null;
}

async function handleBridgeFile(bridgeJsonPath: string): Promise<void> {
  if (processingFiles.has(bridgeJsonPath)) {
    return;
  }
  processingFiles.add(bridgeJsonPath);

  try {
    // Read the file
    const raw = await fsPromises.readFile(bridgeJsonPath, "utf8");
    if (!raw.trim()) return;

    // Parse JSON
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
      const action = parsed.action;
      const params = parsed.params ?? {};

      if (isKnownBridgeAction(action)) {
        if (process.env.NODE_ENV === "development" || process.env.DEBUG) {
          console.debug(`[FreeBuddy] File-based bridge triggered: ${action}`, params);
        }
        if (webContentsGetter) {
          safeSendToWebContents(webContentsGetter(), "freebuddy://bridge", { action, params });
        }
      }
    }
  } catch (err: any) {
    console.warn("[FreeBuddy] File-based bridge failed to process bridge.json:", err);
  } finally {
    // Always delete the bridge file to avoid reprocessing and to keep workspace clean
    try {
      await fsPromises.unlink(bridgeJsonPath);
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.warn(`[FreeBuddy] Failed to delete bridge.json at ${bridgeJsonPath}:`, err);
      }
    }
    processingFiles.delete(bridgeJsonPath);
  }
}

function setupWatcher(cwd: string): void {
  if (currentCwd !== cwd) return; // If active directory changed during retry wait, do not set up

  const freebuddyDir = path.join(cwd, ".freebuddy");
  const bridgeJsonPath = path.join(freebuddyDir, "bridge.json");

  try {
    if (activeWatcher) {
      try {
        activeWatcher.close();
      } catch (err: any) {
        console.warn("[FreeBuddy] Error closing previous watcher:", err);
      }
      activeWatcher = null;
    }

    if (backupPollInterval) {
      clearInterval(backupPollInterval);
      backupPollInterval = null;
    }

    activeWatcher = fs.watch(freebuddyDir, async (eventType, filename) => {
      if (filename === "bridge.json") {
        // Check if file exists (it could be a deletion event, so fs.access verifies)
        try {
          await fsPromises.access(bridgeJsonPath, fs.constants.F_OK);
          // File exists, process it
          await handleBridgeFile(bridgeJsonPath);
        } catch {
          // File was deleted or is inaccessible, ignore
        }
      }
    });

    activeWatcher.on("error", (err: any) => {
      console.warn(`[FreeBuddy] File bridge watcher encountered error on ${freebuddyDir}:`, err);
      scheduleWatcherRetry(cwd);
    });

    // Start a backup polling check to guarantee cross-platform support (e.g. Linux fs.watch limits, containers)
    backupPollInterval = setInterval(async () => {
      if (currentCwd !== cwd) return;
      try {
        await fsPromises.access(bridgeJsonPath, fs.constants.F_OK);
        await handleBridgeFile(bridgeJsonPath);
      } catch {
        // File does not exist, ignore
      }
    }, 2000);

    // Reset retryCount after 5s of successful running
    const currentAttempt = retryCount;
    setTimeout(() => {
      if (currentCwd === cwd && retryCount === currentAttempt && activeWatcher) {
        retryCount = 0;
      }
    }, 5000);

  } catch (err: any) {
    console.warn(`[FreeBuddy] Failed to watch .freebuddy directory for file bridge at ${freebuddyDir}:`, err);
    scheduleWatcherRetry(cwd);
  }
}

function scheduleWatcherRetry(cwd: string): void {
  if (currentCwd !== cwd) return;

  if (activeWatcher) {
    try {
      activeWatcher.close();
    } catch {
      // ignore
    }
    activeWatcher = null;
  }

  if (backupPollInterval) {
    clearInterval(backupPollInterval);
    backupPollInterval = null;
  }

  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }

  if (retryCount < MAX_RETRIES) {
    retryCount++;
    console.warn(`[FreeBuddy] Scheduling file bridge watcher retry ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms for ${cwd}`);
    retryTimeout = setTimeout(() => {
      setupWatcher(cwd);
    }, RETRY_DELAY_MS);
  } else {
    console.error(`[FreeBuddy] File bridge watcher reached max retries (${MAX_RETRIES}) for ${cwd}. Giving up.`);
  }
}

export async function startWatchingFileBridge(cwd: string): Promise<void> {
  if (!cwd || !path.isAbsolute(cwd)) return;
  if (currentCwd === cwd) return; // Already watching this cwd

  stopWatchingFileBridge();
  currentCwd = cwd;

  const freebuddyDir = path.join(cwd, ".freebuddy");
  const bridgeJsonPath = path.join(freebuddyDir, "bridge.json");

  // Ensure .freebuddy folder exists
  try {
    await fsPromises.mkdir(freebuddyDir, { recursive: true });
  } catch (err: any) {
    console.warn(`[FreeBuddy] Failed to create .freebuddy directory at ${freebuddyDir}:`, err);
  }

  // Initial check: if bridge.json somehow exists at startup, process it
  try {
    const stat = await fsPromises.stat(bridgeJsonPath);
    if (stat.isFile()) {
      await handleBridgeFile(bridgeJsonPath);
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.warn(`[FreeBuddy] Failed to check/process bridge.json at startup:`, err);
    }
  }

  // Start the watch
  setupWatcher(cwd);
}
