/**
 * Bundled pi runtime resolution for the `pi-acp` adapter.
 *
 * FreeBuddy ships `@earendil-works/pi-coding-agent` (pi) plus the community
 * `pi-acp` ACP bridge as an extraResource, so the onboarding guide member can
 * run on a brand-new install with zero user-side setup (no global node, no
 * globally installed CLI agent).
 *
 * Layout (staged by scripts/ensure-pi-runtime.mjs):
 *   <root>/node_modules/pi-acp/dist/index.js                          ACP bridge
 *   <root>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js  pi CLI
 *   <root>/pi-runtime.json                                            version manifest
 *
 * Roots, in priority order:
 *   1. <resourcesPath>/pi-runtime  — packaged extraResources
 *   2. <repo>/.build/pi-runtime    — locally staged for packaging
 *   3. <repo>                      — dev: packages installed as devDependencies
 *
 * Spawning model:
 *   FreeBuddy spawns `node <pi-acp>/dist/index.js` directly (mirrors how
 *   dsh-acp spawns its managed entry). pi-acp in turn spawns ONE executable
 *   (env PI_ACP_PI_COMMAND) and appends `--mode rpc` itself, so we generate a
 *   tiny platform launcher that runs pi's bundled CLI entry with the same
 *   node binary. When no user node is on PATH we run the Electron binary as
 *   Node (ELECTRON_RUN_AS_NODE=1 — Electron 43 ships Node 24, above pi's
 *   `>=22.19` engine requirement).
 *
 * This module intentionally imports nothing from Electron so it stays
 * runnable (and testable) under plain Node.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNodeBinaryHint } from "./codexBinaryHint.js";

export const PI_ACP_ADAPTER_ID = "pi-acp";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_ACP_PACKAGE = "pi-acp";
const PI_ACP_ENTRY_REL = path.join(
  "node_modules",
  PI_ACP_PACKAGE,
  "dist",
  "index.js"
);
const PI_CLI_ENTRY_REL = path.join(
  "node_modules",
  PI_PACKAGE,
  "dist",
  "bundle",
  "cli.js"
);

export interface PiRuntimeManifest {
  piVersion?: string;
  piAcpVersion?: string;
}

export interface PiRuntimeStatus extends PiRuntimeManifest {
  ready: boolean;
  root?: string;
  piAcpEntry?: string;
  piCliEntry?: string;
}

export interface PiNodeRuntime {
  bin: string;
  /** Extra env required to run `bin` (Electron-as-Node needs the opt-in flag). */
  env: Record<string, string>;
}

export interface PiAcpSpawnPlan {
  bin: string;
  piAcpEntry: string;
  env: Record<string, string>;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function repoRoot(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".."
  );
}

/** Candidate runtime roots, highest priority first. */
export function piRuntimeRoots(): string[] {
  const roots: string[] = [];
  const packaged =
    typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, "pi-runtime")
      : "";
  if (packaged) roots.push(packaged);
  roots.push(path.join(repoRoot(), ".build", "pi-runtime"));
  roots.push(repoRoot());
  return roots;
}

export function piAcpEntryForRoot(root: string): string {
  return path.join(root, PI_ACP_ENTRY_REL);
}

export function piCliEntryForRoot(root: string): string {
  return path.join(root, PI_CLI_ENTRY_REL);
}

function readPackageVersion(pkgDir: string): string | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")
    ) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Versions come from the staged `pi-runtime.json` manifest. Dev roots without
 * a manifest fall back to the packages' own package.json files.
 */
export function readPiRuntimeManifest(root: string): PiRuntimeManifest {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, "pi-runtime.json"), "utf8")
    ) as { piVersion?: unknown; piAcpVersion?: unknown };
    return {
      piVersion: typeof raw.piVersion === "string" ? raw.piVersion : undefined,
      piAcpVersion:
        typeof raw.piAcpVersion === "string" ? raw.piAcpVersion : undefined
    };
  } catch {
    return {
      piVersion: readPackageVersion(
        path.join(root, "node_modules", PI_PACKAGE)
      ),
      piAcpVersion: readPackageVersion(
        path.join(root, "node_modules", PI_ACP_PACKAGE)
      )
    };
  }
}

/** First root that contains both the bridge and the pi CLI entries. */
export function resolvePiAcpRuntime(
  roots: string[] = piRuntimeRoots()
): PiRuntimeStatus {
  for (const root of roots) {
    const piAcpEntry = piAcpEntryForRoot(root);
    const piCliEntry = piCliEntryForRoot(root);
    if (isFile(piAcpEntry) && isFile(piCliEntry)) {
      return {
        ready: true,
        root,
        piAcpEntry,
        piCliEntry,
        ...readPiRuntimeManifest(root)
      };
    }
  }
  return { ready: false };
}

/**
 * Node binary used for both the bridge and pi itself. Prefers the user's node
 * (FREEBUDDY_NODE_BIN / PATH — same resolution codex BYOK uses), and falls
 * back to the Electron binary running as Node.
 */
export function resolvePiNodeRuntime(
  env: NodeJS.ProcessEnv = process.env
): PiNodeRuntime {
  const userNode = resolveNodeBinaryHint({ env });
  if (userNode && isFile(userNode)) {
    return { bin: userNode, env: {} };
  }
  return {
    bin: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: "1" }
  };
}

/** Directory that holds the generated PI_ACP_PI_COMMAND launcher. */
export function piLauncherDir(dataDir: string): string {
  return path.join(dataDir, "pi-runtime-launcher");
}

function piLauncherContent(input: {
  piCliEntry: string;
  node: PiNodeRuntime;
}): string {
  if (process.platform === "win32") {
    return [
      "@echo off",
      "rem Generated by FreeBuddy: runs the bundled pi CLI entry as Node.",
      "set ELECTRON_RUN_AS_NODE=1",
      `"${input.node.bin}" "${input.piCliEntry}" %*`,
      ""
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    "# Generated by FreeBuddy: runs the bundled pi CLI entry as Node.",
    `ELECTRON_RUN_AS_NODE=1 exec "${input.node.bin}" "${input.piCliEntry}" "$@"`,
    ""
  ].join("\n");
}

/**
 * Writes (idempotently) the single-executable launcher pi-acp spawns as pi.
 * Returns the launcher path; safe to call on every spawn.
 */
export function ensurePiAcpLauncher(input: {
  dataDir: string;
  piCliEntry: string;
  node: PiNodeRuntime;
}): string {
  const dir = piLauncherDir(input.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const launcherPath = path.join(
    dir,
    process.platform === "win32" ? "pi-fb.cmd" : "pi-fb"
  );
  const content = piLauncherContent(input);
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(launcherPath, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== content) {
    fs.writeFileSync(launcherPath, content, "utf8");
  }
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(launcherPath, 0o755);
    } catch {
      // Read-only media or restricted fs: pi-acp will surface the spawn error.
    }
  }
  return launcherPath;
}

/**
 * FreeBuddy BYOK extension: registers the user's provider (custom baseUrl +
 * models) with pi via `pi.registerProvider()`. Written to pi's global
 * extension dir (PI_CODING_AGENT_DIR/extensions, i.e. FreeBuddy's data dir),
 * which pi discovers on every session start.
 *
 * Config flows through the FREEBUDDY_PI_BYOK env var (JSON, resolved per spawn
 * by resolvePiByokEnv in cli/store.ts) — never baked into the file, so key
 * rotation needs no file rewrite and secrets never touch disk in plaintext.
 *
 * - When baseUrl is set: registers a new provider "freebuddy-relay" speaking
 *   OpenAI-compatible chat completions with the declared model list.
 * - When baseUrl is empty: only sets the key env name hint on the built-in
 *   provider match (pi reads standard provider env vars natively, so this
 *   case is handled by env injection alone and the extension is a no-op).
 */
export const PI_BYOK_EXTENSION_FILE_NAME = "freebuddy-byok.js";

export const PI_BYOK_EXTENSION_SOURCE = `/**
 * Generated by FreeBuddy — registers the user's BYOK provider with pi.
 * Config arrives via the FREEBUDDY_PI_BYOK environment variable (JSON).
 * Do not edit; FreeBuddy rewrites this file when needed.
 */
export default function (pi) {
  const raw = process.env.FREEBUDDY_PI_BYOK;
  if (!raw) return;
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    console.warn("[freebuddy-byok] invalid FREEBUDDY_PI_BYOK JSON:", error?.message || error);
    return;
  }
  if (!config?.enabled) return;
  const models = Array.isArray(config.models) ? config.models : [];
  const envVar = config.envKey || "FREEBUDDY_PI_RELAY_KEY";
  const apiKey = envVar.startsWith("$") ? envVar : ("$" + envVar);
  pi.registerProvider("freebuddy-relay", {
    baseUrl: config.baseUrl || "https://api.openai.com/v1",
    apiKey,
    api: config.api || "openai-completions",
    models: models.map((model) => ({
      id: String(model.id),
      name: String(model.name || model.id),
      reasoning: false,
      input: model.supportsVision ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Number(model.contextWindow) || 128000,
      maxTokens: 16384
    }))
  });
}
`;

/**
 * Ensures pi-agent/settings.json exists and optionally pins the default provider
 * and default model so pi does not fall back to built-in providers (e.g. openai)
 * when relay keys are present.
 */
export function ensurePiSettings(
  dataDir: string,
  defaults?: { defaultProvider?: string; defaultModel?: string }
): void {
  const dir = path.join(dataDir, "pi-agent");
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, "settings.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    existing = {};
  }
  let changed = false;
  if (
    defaults?.defaultProvider &&
    existing.defaultProvider !== defaults.defaultProvider
  ) {
    existing.defaultProvider = defaults.defaultProvider;
    changed = true;
  }
  if (
    defaults?.defaultModel &&
    existing.defaultModel !== defaults.defaultModel
  ) {
    existing.defaultModel = defaults.defaultModel;
    changed = true;
  }
  if (changed || !fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), "utf8");
  }
}

/**
 * Writes (idempotently) the BYOK extension into pi's global extension dir.
 * Safe to call on every pi-acp spawn.
 */
export function ensurePiByokExtension(dataDir: string): string {
  const dir = path.join(dataDir, "pi-agent", "extensions");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, PI_BYOK_EXTENSION_FILE_NAME);
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== PI_BYOK_EXTENSION_SOURCE) {
    fs.writeFileSync(filePath, PI_BYOK_EXTENSION_SOURCE, "utf8");
  }
  return filePath;
}

/**
 * Full spawn plan for the pi-acp bridge, or undefined when no bundled runtime
 * is present (buildCommand then falls back to a PATH `pi-acp` binary).
 *
 * `PI_CODING_AGENT_DIR` keeps pi's settings/sessions inside FreeBuddy's data
 * directory instead of polluting the user's `~/.pi`. The BYOK extension is
 * ensured here so every spawn sees the current registration.
 */
export function resolvePiAcpSpawnPlan(
  dataDir: string | undefined,
  roots: string[] = piRuntimeRoots(),
  env: NodeJS.ProcessEnv = process.env
): PiAcpSpawnPlan | undefined {
  const status = resolvePiAcpRuntime(roots);
  if (!status.ready || !status.piAcpEntry || !status.piCliEntry) {
    return undefined;
  }
  const node = resolvePiNodeRuntime(env);
  const agentDir = dataDir ? path.join(dataDir, "pi-agent") : undefined;
  if (dataDir) {
    ensurePiByokExtension(dataDir);
    if (env.FREEBUDDY_PI_BYOK) {
      try {
        const byok = JSON.parse(env.FREEBUDDY_PI_BYOK);
        if (byok?.enabled && byok.defaultModel) {
          ensurePiSettings(dataDir, {
            defaultProvider: "freebuddy-relay",
            defaultModel: String(byok.defaultModel).replace(
              /^freebuddy-relay\//,
              ""
            )
          });
        }
      } catch {
        /* best-effort */
      }
    }
  }
  const launcher = ensurePiAcpLauncher({
    dataDir: dataDir ?? path.join(os.tmpdir(), "freebuddy-pi"),
    piCliEntry: status.piCliEntry,
    node
  });
  return {
    bin: node.bin,
    piAcpEntry: status.piAcpEntry,
    env: {
      ...node.env,
      PI_ACP_PI_COMMAND: launcher,
      PI_SKIP_VERSION_CHECK: "1",
      ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {})
    }
  };
}

/**
 * Scans the pi-agent session files for the last error message recorded for a given session.
 * Used to enrich ACP error messages when Pi exits silently or fails without streaming text.
 */
export function findLastPiSessionErrorMessage(
  dataDir: string | undefined,
  sessionId: string | undefined
): string | undefined {
  if (!dataDir || !sessionId) return undefined;
  const sessionsDir = path.join(dataDir, "pi-agent", "sessions");
  if (!fs.existsSync(sessionsDir)) return undefined;
  try {
    const cwdDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const dir of cwdDirs) {
      if (!dir.isDirectory()) continue;
      const cwdDirPath = path.join(sessionsDir, dir.name);
      const files = fs.readdirSync(cwdDirPath);
      const targetFile = files.find(
        (f) => f.includes(sessionId) && f.endsWith(".jsonl")
      );
      if (targetFile) {
        const fullPath = path.join(cwdDirPath, targetFile);
        const content = fs.readFileSync(fullPath, "utf8");
        const lines = content.trim().split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed.message?.errorMessage) {
              return String(parsed.message.errorMessage);
            }
            if (parsed.errorMessage) {
              return String(parsed.errorMessage);
            }
          } catch {
            /* ignore bad line */
          }
        }
      }
    }
  } catch {
    /* best-effort */
  }
  return undefined;
}

