import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_ENGINE_BYTES = 1024 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 15000;

// Windows x64 Office engine hosted separately from the FreeBuddy installer.
// Keep the URL and checksum together so a changed object cannot be executed.
export const OFFICE_ENGINE_DOWNLOAD_URL = "https://pub-7b39e9aa06a94f8fa4d856f47eb7b9a4.r2.dev/editor_sdk.exe";
export const OFFICE_ENGINE_DOWNLOAD_SHA256 = "aed4b6845a835e1b54f4af9615958d478a9a6cfa689fca107627c3539f4e11f9";

export interface OfficeEngineDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export function getManagedOfficeEnginePath(userDataDir: string): string {
  return path.join(userDataDir, "office-engine", process.platform === "win32" ? "editor_sdk.exe" : "editor_sdk");
}

export function validateOfficeEngineDownload(url: string, sha256: string): { url: URL; sha256: string } {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("The engine download must use an HTTPS URL without embedded credentials");
  }
  const normalizedHash = sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedHash)) {
    throw new Error("A 64-character SHA-256 checksum is required");
  }
  return { url: parsed, sha256: normalizedHash };
}

async function assertWindowsExecutable(filePath: string): Promise<void> {
  if (process.platform !== "win32") return;
  const file = await fs.open(filePath, "r");
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== 2 || header.toString("ascii") !== "MZ") {
      throw new Error("The selected file is not a Windows executable");
    }
  } finally {
    await file.close();
  }
}

async function reserveProbePort(): Promise<number> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to reserve a probe port");
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function probeOfficeEngine(binaryPath: string): Promise<void> {
  const port = await reserveProbePort();
  const child = spawn(binaryPath, ["--port", String(port), "--cors_origin=*"], {
    cwd: path.dirname(binaryPath),
    stdio: "ignore",
    windowsHide: true
  });
  let launchError: Error | null = null;
  child.once("error", (error) => { launchError = error; });
  try {
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error("The engine exited during its startup check");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500)
        });
        if (response.ok) return;
      } catch {
        // Startup may still be in progress.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("The engine did not pass its startup check");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill();
      });
    }
  }
}

async function activateStagedEngine(stagedPath: string, targetPath: string): Promise<void> {
  const backupPath = `${targetPath}.backup-${crypto.randomUUID()}`;
  let backedUp = false;
  try {
    try {
      await fs.rename(targetPath, backupPath);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(stagedPath, targetPath);
    } catch (error) {
      if (backedUp) await fs.rename(backupPath, targetPath);
      throw error;
    }
    if (backedUp) await fs.rm(backupPath, { force: true }).catch(() => {});
  } catch (error) {
    throw new Error(`Unable to activate the Office engine: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function installStagedEngine(stagedPath: string, targetPath: string): Promise<void> {
  const stat = await fs.stat(stagedPath);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ENGINE_BYTES) {
    throw new Error("The Office engine file has an invalid size");
  }
  await assertWindowsExecutable(stagedPath);
  await probeOfficeEngine(stagedPath);
  await activateStagedEngine(stagedPath, targetPath);
}

export async function downloadOfficeEngine(
  sourceUrl: string,
  expectedSha256: string,
  userDataDir: string,
  onProgress: (progress: OfficeEngineDownloadProgress) => void,
  fetchSource: typeof fetch = fetch
): Promise<string> {
  const { url, sha256 } = validateOfficeEngineDownload(sourceUrl, expectedSha256);
  const targetPath = getManagedOfficeEnginePath(userDataDir);
  const stagingDir = path.join(path.dirname(targetPath), `.install-${crypto.randomUUID()}`);
  await fs.mkdir(stagingDir, { recursive: true });
  const stagedPath = path.join(stagingDir, path.basename(targetPath));
  try {
    const response = await fetchSource(url, { signal: AbortSignal.timeout(20 * 60 * 1000) });
    if (!response.ok || !response.body || new URL(response.url).protocol !== "https:") {
      throw new Error(`Unable to download the Office engine (HTTP ${response.status})`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    const totalBytes = Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : null;
    if (totalBytes !== null && totalBytes > MAX_ENGINE_BYTES) throw new Error("The Office engine download is too large");
    const hash = crypto.createHash("sha256");
    let receivedBytes = 0;
    let lastReport = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_ENGINE_BYTES) {
          callback(new Error("The Office engine download is too large"));
          return;
        }
        hash.update(chunk);
        if (Date.now() - lastReport > 200) {
          lastReport = Date.now();
          onProgress({ receivedBytes, totalBytes });
        }
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(stagedPath, { flags: "wx" }));
    onProgress({ receivedBytes, totalBytes });
    if (hash.digest("hex") !== sha256) throw new Error("The Office engine SHA-256 checksum does not match");
    await installStagedEngine(stagedPath, targetPath);
    return targetPath;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

export function downloadConfiguredOfficeEngine(
  userDataDir: string,
  onProgress: (progress: OfficeEngineDownloadProgress) => void,
  fetchSource: typeof fetch = fetch
): Promise<string> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The configured Office engine is available only on Windows x64");
  }
  return downloadOfficeEngine(
    OFFICE_ENGINE_DOWNLOAD_URL,
    OFFICE_ENGINE_DOWNLOAD_SHA256,
    userDataDir,
    onProgress,
    fetchSource
  );
}
