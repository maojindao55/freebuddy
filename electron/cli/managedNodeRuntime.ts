import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import { sanitizeCliAgentEnv } from "./cliAgentEnv.js";

type Manifest = {
  schemaVersion: 1; version: string; platform: "win32"; arch: "x64";
  archiveRoot: string; sha256: string; files: Record<string, string>;
};
export interface ManagedNodeRuntime {
  root: string; node: string; version: string; prefix: string; cache: string;
}
const requiredFiles = ["node.exe", "npm.cmd", "npx.cmd", "node_modules/npm/package.json",
  "node_modules/npm/bin/npm-cli.js", "node_modules/npm/bin/npx-cli.js"];
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const pending = new Map<string, Promise<ManagedNodeRuntime>>();
const verified = new Map<string, string>();
let runtime: ManagedNodeRuntime | undefined;

export function getManagedNodeRuntime(): ManagedNodeRuntime | undefined { return runtime; }
export function setManagedNodeRuntime(value: ManagedNodeRuntime | undefined): void { runtime = value; }

function activateRuntime(value: ManagedNodeRuntime): ManagedNodeRuntime {
  // npm's writable directories survive app/Node upgrades and can be recreated
  // independently if the user clears the download cache.
  fs.mkdirSync(value.prefix, { recursive: true });
  fs.mkdirSync(value.cache, { recursive: true });
  runtime = value;
  return value;
}

function readManifest(directory: string): Manifest | undefined {
  const file = path.join(directory, "manifest.json");
  if (!fs.existsSync(file)) {
    if (fs.existsSync(path.join(directory, "node.zip"))) throw new Error("Bundled Node runtime manifest is missing");
    return undefined;
  }
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  if (manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.platform !== "win32" || manifest.arch !== "x64" ||
      manifest.archiveRoot !== `node-v${manifest.version}-win-x64` || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      requiredFiles.some(file => !/^[a-f0-9]{64}$/.test(manifest.files?.[file] ?? ""))) {
    throw new Error("Invalid bundled Windows Node runtime manifest");
  }
  return manifest;
}

function cacheReady(root: string, manifest: Manifest): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(root, "ready.json"), "utf8"));
    if (marker.sha256 !== manifest.sha256) return false;
    const fingerprint = JSON.stringify(requiredFiles.map(file => {
      const stat = fs.lstatSync(path.join(root, file));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid cached Node file");
      return [file, stat.size, stat.mtimeMs];
    }));
    if (verified.get(root) === fingerprint) return true;
    for (const file of requiredFiles) if (hash(fs.readFileSync(path.join(root, file))) !== manifest.files[file]) return false;
    verified.set(root, fingerprint);
    return true;
  } catch { return false; }
}

async function lockDirectory(lock: string): Promise<() => void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
      return () => fs.rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const { pid } = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
        try { process.kill(pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") { fs.rmSync(lock, { recursive: true, force: true }); continue; }
        }
      } catch {
        // An interrupted mkdir may have no owner yet; allow live creators to finish.
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      }
      if (Date.now() >= deadline) throw new Error("Timed out preparing bundled Node runtime; retry after the other FreeBuddy instance finishes");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/** Bootstrap uses Electron's JS runtime and the local archive, never a system Node or network. */
export async function ensureManagedNodeRuntime(dataDir: string, options: { packageDir?: string; platform?: NodeJS.Platform } = {}): Promise<ManagedNodeRuntime | undefined> {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const directory = options.packageDir ?? (typeof process.resourcesPath === "string" ? path.join(process.resourcesPath, "node-runtime") : "");
  if (!directory) return undefined;
  const manifest = readManifest(directory);
  if (!manifest) return undefined; // Development and older packages retain their current behavior.
  const parent = path.join(dataDir, "node-runtime");
  // Never key this directory by the app version or resources/install path:
  // ordinary FreeBuddy upgrades must reuse the existing offline runtime.
  const root = path.join(parent, `${manifest.version}-win-x64-${manifest.sha256.slice(0, 12)}`);
  const result = { root, node: path.join(root, "node.exe"), version: manifest.version,
    prefix: path.join(dataDir, "node-cli"), cache: path.join(dataDir, "npm-cache") };
  if (cacheReady(root, manifest)) return activateRuntime(result);
  const existing = pending.get(root);
  if (existing) return existing;
  const work = (async () => {
    fs.mkdirSync(parent, { recursive: true });
    const release = await lockDirectory(`${root}.lock`);
    const temporary = path.join(parent, `.extracting-${randomUUID()}`);
    try {
      if (!cacheReady(root, manifest)) {
        const archive = fs.readFileSync(path.join(directory, "node.zip"));
        if (hash(archive) !== manifest.sha256) throw new Error("Bundled Node archive checksum mismatch; reinstall FreeBuddy");
        const zip = new AdmZip(archive);
        // Validate every destination before the zip library writes any files.
        for (const entry of zip.getEntries()) {
          const name = entry.entryName.replace(/\\/g, "/");
          if (!name.startsWith(`${manifest.archiveRoot}/`) || name.split("/").includes("..") || name.includes(":")) {
            throw new Error("Invalid bundled Node archive path");
          }
        }
        await zip.extractAllToAsync(temporary, true);
        const extracted = path.join(temporary, manifest.archiveRoot);
        fs.writeFileSync(path.join(extracted, "ready.json"), JSON.stringify({ sha256: manifest.sha256 }));
        if (!cacheReady(extracted, manifest)) throw new Error("Extracted Node runtime is incomplete or invalid");
        fs.rmSync(root, { recursive: true, force: true });
        fs.renameSync(extracted, root);
        verified.delete(extracted);
      }
      console.info(`[managed-node] Windows x64 Node ${manifest.version} ready`);
      return activateRuntime(result);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
      release();
    }
  })();
  pending.set(root, work);
  try { return await work; } finally { pending.delete(root); }
}

/** Only FreeBuddy's tool processes receive these paths; project-local npm installs keep their cwd. */
export function applyManagedNodeEnvironment(source: NodeJS.ProcessEnv, options: { install?: boolean; platform?: NodeJS.Platform; preserveElectronRunAsNode?: boolean } = {}): NodeJS.ProcessEnv {
  if ((options.platform ?? process.platform) !== "win32" || !runtime) return { ...source };
  const env = sanitizeCliAgentEnv(source);
  if (options.preserveElectronRunAsNode && source.ELECTRON_RUN_AS_NODE === "1") env.ELECTRON_RUN_AS_NODE = "1";
  const explicit = env.FREEBUDDY_NODE_BIN?.trim();
  let node = runtime.node;
  if (explicit) {
    try { if (fs.statSync(explicit).isFile()) node = explicit; } catch { /* retain the bundled runtime */ }
  }
  const paths = [path.dirname(node), runtime.prefix, runtime.root];
  const previous = Object.entries(env).filter(([key]) => key.toUpperCase() === "PATH").map(([, value]) => value ?? "");
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  const seen = new Set<string>();
  env.PATH = [...paths, ...previous.flatMap(value => value.split(";"))].filter(entry => {
    const key = entry.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).join(";");
  env.FREEBUDDY_NODE_BIN = node;
  if (options.install) {
    // CLI installations stay outside both Program Files and the versioned Node distribution.
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "NPM_CONFIG_PREFIX" || key.toUpperCase() === "NPM_CONFIG_CACHE") delete env[key];
    }
    env.NPM_CONFIG_PREFIX = runtime.prefix;
    env.NPM_CONFIG_CACHE = runtime.cache;
  }
  return env;
}
