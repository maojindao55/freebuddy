/**
 * Packaged-app guard for the bundled pi runtime, shared by the electron-builder
 * afterPack hook and the regression test.
 *
 * v0.10.5 shipped an app whose `Resources/pi-runtime` contained only
 * `package.json` + `pi-runtime.json`: electron-builder's extraResources copy
 * filter drops a root-level `node_modules` directory, so the staged pi +
 * pi-acp tree silently vanished. Every packaged install then reported Pi as
 * "binary not found", which also broke the onboarding GuideBuddy (it runs on
 * the pi-acp adapter).
 *
 * Verifying at pack time turns that silent data loss into a build failure.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";

import {
  PI_CLI_ENTRY_REL,
  PI_ACP_ENTRY_REL,
  PI_RUNTIME_ARCHIVE_FILE,
  PI_RUNTIME_PACKAGE_MANIFEST_FILE,
  PI_RUNTIME_ROOT_DIR
} from "./pi-runtime-layout.mjs";

/** Directories never worth walking into when hunting for pi-runtime. */
const SKIP_DIRS = new Set([
  "app.asar.unpacked",
  "node_modules",
  ".git",
  "locales"
]);

/**
 * Shallow-ish scan of the packed app for directories named `pi-runtime`.
 * `appOutDir` is `release/mac-arm64` (containing FreeBuddy.app) on macOS and
 * the unpacked app dir on Windows/Linux, so a bounded walk is the portable
 * way to locate `.../Resources/pi-runtime` on every platform.
 */
export function findPiRuntimeDirs(root) {
  const found = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (entry.name === path.basename(PI_RUNTIME_ROOT_DIR)) {
        found.push(child);
      } else if (!SKIP_DIRS.has(entry.name)) {
        queue.push(child);
      }
    }
  }
  return found;
}

/** Throws when the packaged app is missing the bundled pi runtime. */
export function verifyPackagedPiRuntime(appOutDir) {
  if (typeof appOutDir !== "string" || appOutDir.length === 0) {
    throw new Error(
      "[pi-runtime] pack guard: appOutDir is missing; cannot verify the bundled pi runtime."
    );
  }

  const candidates = findPiRuntimeDirs(appOutDir);
  if (candidates.length === 0) {
    throw new Error(
      `[pi-runtime] pack guard: no "${path.basename(PI_RUNTIME_ROOT_DIR)}" directory under ${appOutDir}. ` +
        `Run scripts/ensure-pi-runtime.mjs before electron-builder (npm run dist / dist:mac / dist:win / dist:linux do this).`
    );
  }

  const missing = [];
  for (const dir of candidates) {
    const archivePath = path.join(dir, PI_RUNTIME_ARCHIVE_FILE);
    const manifestPath = path.join(dir, PI_RUNTIME_PACKAGE_MANIFEST_FILE);
    if (!fs.existsSync(archivePath) || !fs.existsSync(manifestPath)) {
      missing.push(archivePath, manifestPath);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const sha256 = createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
    if (manifest.schemaVersion !== 1 || !manifest.piVersion || !manifest.piAcpVersion ||
        manifest.sha256 !== sha256) {
      missing.push(`valid checksum and versions in ${manifestPath}`);
      continue;
    }
    const zip = new AdmZip(archivePath);
    for (const rel of [PI_ACP_ENTRY_REL, PI_CLI_ENTRY_REL, "pi-runtime.json"]) {
      if (!zip.getEntry(rel.split(path.sep).join("/"))) missing.push(`${archivePath}:${rel}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[pi-runtime] pack guard: packaged app is missing the bundled pi runtime:\n  ` +
        `${missing.join("\n  ")}\n` +
        `The packaged archive or manifest is incomplete (see scripts/ensure-pi-runtime.mjs).`
    );
  }

  return candidates.length;
}
