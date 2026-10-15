import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import AdmZip from "adm-zip";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NODE_VERSION = "24.21.0";
// Official v24.21.0/SHASUMS256.txt; update version and checksum together.
export const NODE_ARCHIVE_SHA256 = "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541";
export const NODE_ARCHIVE_NAME = `node-v${NODE_VERSION}-win-x64.zip`;
export const NODE_REQUIRED_FILES = ["node.exe", "npm.cmd", "npx.cmd", "node_modules/npm/package.json",
  "node_modules/npm/bin/npm-cli.js", "node_modules/npm/bin/npx-cli.js"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function validateNodePackage(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.version !== NODE_VERSION || manifest.platform !== "win32" ||
      manifest.arch !== "x64" || manifest.sha256 !== NODE_ARCHIVE_SHA256 || manifest.archiveRoot !== `node-v${NODE_VERSION}-win-x64`) {
    throw new Error("Bundled Windows Node runtime manifest does not match the pinned release");
  }
  const archive = fs.readFileSync(path.join(directory, "node.zip"));
  if (sha256(archive) !== NODE_ARCHIVE_SHA256) throw new Error("Bundled Windows Node archive checksum mismatch");
  const zip = new AdmZip(archive);
  for (const file of NODE_REQUIRED_FILES) {
    const entry = zip.getEntry(`${manifest.archiveRoot}/${file}`);
    if (!entry || sha256(entry.getData()) !== manifest.files?.[file]) throw new Error(`Bundled Node file invalid: ${file}`);
  }
  return manifest;
}

/** The target comes from electron-builder, never the build host's architecture. */
export async function ensureManagedNodePackage({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "win32") return undefined;
  if (arch !== "x64") throw new Error(`Bundled Node currently supports Windows x64 only, received ${arch}`);
  const directory = path.join(repo, ".build", "node-runtime", "win32-x64");
  try { validateNodePackage(directory); return directory; } catch { /* prepare or repair below */ }
  const downloads = path.join(repo, ".build", "downloads");
  fs.mkdirSync(downloads, { recursive: true });
  const archivePath = path.join(downloads, NODE_ARCHIVE_NAME);
  if (!fs.existsSync(archivePath) || sha256(fs.readFileSync(archivePath)) !== NODE_ARCHIVE_SHA256) {
    const temporary = `${archivePath}.${randomUUID()}.tmp`;
    try {
      const response = await fetch(`https://nodejs.org/download/release/v${NODE_VERSION}/${NODE_ARCHIVE_NAME}`, {
        signal: AbortSignal.timeout(120_000)
      });
      if (!response.ok || !response.body) throw new Error(`Node download failed: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
      if (sha256(fs.readFileSync(temporary)) !== NODE_ARCHIVE_SHA256) throw new Error("Downloaded Node archive checksum mismatch");
      fs.renameSync(temporary, archivePath);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  const zip = new AdmZip(archivePath);
  const archiveRoot = `node-v${NODE_VERSION}-win-x64`;
  const files = {};
  for (const file of NODE_REQUIRED_FILES) {
    const entry = zip.getEntry(`${archiveRoot}/${file}`);
    if (!entry) throw new Error(`Official Node archive is missing ${file}`);
    files[file] = sha256(entry.getData());
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(archivePath, path.join(directory, "node.zip"));
  fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1, version: NODE_VERSION, platform, arch, archiveRoot, sha256: NODE_ARCHIVE_SHA256, files
  }, null, 2)}\n`);
  validateNodePackage(directory);
  console.info(`[managed-node] Windows x64 Node ${NODE_VERSION} prepared (${fs.statSync(archivePath).size} bytes)`);
  return directory;
}

export function verifyPackagedNodeRuntime(appOutDir) {
  return validateNodePackage(path.join(appOutDir, "resources", "node-runtime"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index < 0 ? fallback : process.argv[index + 1];
  };
  await ensureManagedNodePackage({ platform: option("platform", process.platform), arch: option("arch", process.arch) });
}
