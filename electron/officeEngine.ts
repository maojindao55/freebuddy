import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

import { getManagedOfficeEnginePath } from "./officeEngineAddon.js";

/**
 * Spawn-and-supervise wrapper around FreeBuddy's downloaded `editor_sdk.exe`.
 * Prefer port 39100 to avoid other local editor services using 39099.
 */
const DEFAULT_PORT = 39100;
const PORT_ATTEMPTS = 5;
const HEALTH_PATH = "/health";
const READY_TIMEOUT_MS = 15000;
const READY_PROBE_INTERVAL_MS = 250;
const READY_PROBE_REQUEST_TIMEOUT_MS = 500;

let engineProc: ChildProcess | null = null;
let enginePort: number | null = null;
let engineStarting: Promise<number | null> | null = null;

export function findLocalOfficeEngineBinary(): string | null {
  const managedPath = getManagedOfficeEnginePath(app.getPath("userData"));
  return fs.existsSync(managedPath) ? managedPath : null;
}

async function probeHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(READY_PROBE_REQUEST_TIMEOUT_MS)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function spawnEngine(binaryPath: string, port: number): Promise<number | null> {
  const child = spawn(binaryPath, ["--port", String(port), "--cors_origin=*"], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
    windowsHide: true,
    cwd: path.dirname(binaryPath)
  });
  engineProc = child;
  child.once("exit", () => {
    if (engineProc === child) engineProc = null;
    if (enginePort === port) enginePort = null;
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return null; // engine died at startup
    if (await probeHealth(port)) {
      enginePort = port;
      return port;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_PROBE_INTERVAL_MS));
  }
  return null;
}

/**
 * Ensure the engine process is up and return its port, or null when no local
 * engine binary exists / it fails to become healthy.
 */
export async function ensureOfficeEnginePort(): Promise<number | null> {
  if (enginePort && engineProc && engineProc.exitCode === null) return enginePort;
  if (engineStarting) return engineStarting;
  if (enginePort && (await probeHealth(enginePort))) return enginePort;

  const binaryPath = findLocalOfficeEngineBinary();
  if (!binaryPath) return null;

  engineStarting = (async () => {
    try {
      for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
        const port = DEFAULT_PORT + attempt;
        // Reuse an already-healthy engine on this port (another FreeBuddy
        // window, or an engine that outlived a crashed host).
        if (await probeHealth(port)) {
          enginePort = port;
          return port;
        }
        const spawned = await spawnEngine(binaryPath, port);
        if (spawned) return spawned;
      }
      return null;
    } finally {
      engineStarting = null;
    }
  })();
  return engineStarting;
}

export function stopOfficeEngine(): void {
  const child = engineProc;
  engineProc = null;
  enginePort = null;
  if (child && child.exitCode === null) {
    child.kill();
  }
}
