/** Extract the bundled Pi archive once per Pi/pi-acp version into user data. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

import { resolvePiAcpRuntime, readPiRuntimeManifest, setPiRuntimeCacheRoot } from "./piRuntime.js";

const PACKAGE_MANIFEST = "package-manifest.json";
const ARCHIVE = "runtime.zip";
const READY_MARKER = "cache-ready.json";
const pending = new Map<string, Promise<string>>();

export interface PiRuntimePackageManifest {
  schemaVersion: 1;
  piVersion: string;
  piAcpVersion: string;
  sha256: string;
}

function readPackageManifest(packageDir: string): PiRuntimePackageManifest | undefined {
  const manifestPath = path.join(packageDir, PACKAGE_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    if (fs.existsSync(path.join(packageDir, ARCHIVE))) {
      throw new Error(`Bundled Pi runtime manifest missing: ${manifestPath}`);
    }
    return undefined;
  }
  const value = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<PiRuntimePackageManifest>;
  if (value.schemaVersion !== 1 || !value.piVersion || !value.piAcpVersion ||
      !/^[a-f0-9]{64}$/i.test(value.sha256 ?? "")) {
    throw new Error(`Invalid bundled Pi runtime manifest: ${manifestPath}`);
  }
  return value as PiRuntimePackageManifest;
}

export function piRuntimeCacheRoot(dataDir: string, manifest: PiRuntimePackageManifest): string {
  const key = createHash("sha256")
    .update(JSON.stringify([
      manifest.schemaVersion,
      manifest.piVersion,
      manifest.piAcpVersion,
      process.platform,
      process.arch
    ]))
    .digest("hex")
    .slice(0, 20);
  return path.join(dataDir, "pi-runtime-cache", `v1-${key}`);
}

function cacheReady(root: string, manifest: PiRuntimePackageManifest): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(root, READY_MARKER), "utf8"));
    const runtime = readPiRuntimeManifest(root);
    return marker.piVersion === manifest.piVersion &&
      marker.piAcpVersion === manifest.piAcpVersion &&
      runtime.piVersion === manifest.piVersion &&
      runtime.piAcpVersion === manifest.piAcpVersion &&
      resolvePiAcpRuntime([root]).ready;
  } catch {
    return false;
  }
}

async function archiveSha256(archivePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(archivePath)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Returns the reusable root, or undefined in dev/older packages without an
 * archive. A failed extraction throws so callers do not silently use PATH Pi.
 */
export async function ensurePackagedPiRuntime(
  dataDir: string,
  packageDir = typeof process.resourcesPath === "string"
    ? path.join(process.resourcesPath, "pi-runtime")
    : ""
): Promise<string | undefined> {
  if (!packageDir) return undefined;
  const manifest = readPackageManifest(packageDir);
  if (!manifest) return undefined;
  const root = piRuntimeCacheRoot(dataDir, manifest);
  if (cacheReady(root, manifest)) {
    setPiRuntimeCacheRoot(root);
    return root;
  }
  const active = pending.get(root);
  if (active) return active;

  const work = (async () => {
    const startedAt = Date.now();
    const archivePath = path.join(packageDir, ARCHIVE);
    if (!fs.existsSync(archivePath)) throw new Error(`Bundled Pi runtime archive missing: ${archivePath}`);
    if ((await archiveSha256(archivePath)) !== manifest.sha256) {
      throw new Error(`Bundled Pi runtime archive checksum mismatch: ${archivePath}`);
    }
    const tempRoot = `${root}.tmp-${randomUUID()}`;
    fs.mkdirSync(path.dirname(root), { recursive: true });
    try {
      const zip = new AdmZip(archivePath);
      await zip.extractAllToAsync(tempRoot, true, process.platform !== "win32");
      const runtime = readPiRuntimeManifest(tempRoot);
      if (runtime.piVersion !== manifest.piVersion ||
          runtime.piAcpVersion !== manifest.piAcpVersion ||
          !resolvePiAcpRuntime([tempRoot]).ready) {
        throw new Error("Extracted Pi runtime is incomplete or has the wrong version");
      }
      fs.writeFileSync(path.join(tempRoot, READY_MARKER), `${JSON.stringify({
        piVersion: manifest.piVersion,
        piAcpVersion: manifest.piAcpVersion
      })}\n`);
      if (cacheReady(root, manifest)) return root;
      fs.rmSync(root, { recursive: true, force: true });
      fs.renameSync(tempRoot, root);
      console.info(`[pi-runtime] extracted ${manifest.piVersion} / ${manifest.piAcpVersion} in ${Date.now() - startedAt} ms`);
      return root;
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  })();
  pending.set(root, work);
  try {
    const readyRoot = await work;
    setPiRuntimeCacheRoot(readyRoot);
    return readyRoot;
  } finally {
    pending.delete(root);
  }
}
