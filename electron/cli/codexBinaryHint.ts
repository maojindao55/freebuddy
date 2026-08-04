/**
 * Resolve the real Codex CLI for FreeBuddy's BYOK wrapper.
 *
 * Prefer the `@openai/codex` dependency bundled inside an installed
 * `@agentclientprotocol/codex-acp` package — the same default codex-acp uses
 * when CODEX_PATH is unset — then fall back to a globally installed `codex`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp";
const BUNDLED_CODEX_JS = "@openai/codex/bin/codex.js";

export type CodexBinaryHintOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  pathEnv?: string;
  /** Optional absolute/relative path to a codex-acp binary from agent overrides. */
  acpBinaryHint?: string;
  isFile?: (candidate: string) => boolean;
};

function defaultIsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function pathDirs(pathEnv: string | undefined, delimiter: string): string[] {
  return (pathEnv || "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Candidate install roots for the codex-acp npm package. */
export function codexAcpInstallRoots(
  options: CodexBinaryHintOptions = {}
): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? os.homedir();
  const roots: string[] = [];
  const push = (candidate: string | undefined) => {
    if (candidate) roots.push(path.normalize(candidate));
  };

  if (options.acpBinaryHint?.trim()) {
    push(resolveAcpRootFromBinary(options.acpBinaryHint.trim(), options));
  }

  if (platform === "win32") {
    if (env.APPDATA) {
      push(
        path.join(
          env.APPDATA,
          "npm",
          "node_modules",
          CODEX_ACP_PACKAGE
        )
      );
    }
    if (env.LOCALAPPDATA) {
      push(
        path.join(
          env.LOCALAPPDATA,
          "pnpm",
          "global",
          "5",
          "node_modules",
          CODEX_ACP_PACKAGE
        )
      );
    }
  } else {
    push(path.join(home, ".npm-global", "lib", "node_modules", CODEX_ACP_PACKAGE));
    push(path.join(home, ".local", "lib", "node_modules", CODEX_ACP_PACKAGE));
    push("/usr/local/lib/node_modules/" + CODEX_ACP_PACKAGE);
    push("/opt/homebrew/lib/node_modules/" + CODEX_ACP_PACKAGE);
  }

  const delimiter = platform === "win32" ? ";" : ":";
  const dirs = pathDirs(options.pathEnv ?? env.PATH, delimiter);
  const names =
    platform === "win32"
      ? ["codex-acp.cmd", "codex-acp.exe", "codex-acp"]
      : ["codex-acp"];
  for (const dir of dirs) {
    for (const name of names) {
      const bin = path.join(dir, name);
      if ((options.isFile ?? defaultIsFile)(bin)) {
        push(resolveAcpRootFromBinary(bin, options));
      }
    }
    // npm prefix layout: <prefix>/codex-acp(.cmd) next to <prefix>/node_modules/...
    push(path.join(dir, "node_modules", CODEX_ACP_PACKAGE));
    // Homebrew / usr/local: <prefix>/bin -> <prefix>/lib/node_modules/...
    push(path.join(dir, "..", "lib", "node_modules", CODEX_ACP_PACKAGE));
  }

  return [...new Set(roots)];
}

export function resolveAcpRootFromBinary(
  binPath: string,
  options: CodexBinaryHintOptions = {}
): string | undefined {
  const isFile = options.isFile ?? defaultIsFile;
  const absolute = path.resolve(binPath);

  try {
    const real = fs.realpathSync(absolute);
    if (real.endsWith(`${path.sep}dist${path.sep}index.js`)) {
      return path.dirname(path.dirname(real));
    }
  } catch {
    /* keep lexical path checks */
  }

  const dir = path.dirname(absolute);
  const besidePrefix = path.join(dir, "node_modules", CODEX_ACP_PACKAGE);
  if (isFile(path.join(besidePrefix, "package.json"))) return besidePrefix;

  const libPrefix = path.join(dir, "..", "lib", "node_modules", CODEX_ACP_PACKAGE);
  if (isFile(path.join(libPrefix, "package.json"))) return path.normalize(libPrefix);

  return undefined;
}

/** Resolve `@openai/codex/bin/codex.js` from a codex-acp package root. */
export function resolveBundledCodexFromAcpRoot(
  acpRoot: string,
  options: CodexBinaryHintOptions = {}
): string | undefined {
  const isFile = options.isFile ?? defaultIsFile;
  const root = path.normalize(acpRoot);

  try {
    const req = createRequire(path.join(root, "dist", "index.js"));
    const resolved = req.resolve(BUNDLED_CODEX_JS);
    if (isFile(resolved)) return resolved;
  } catch {
    /* fall through to lexical candidates */
  }

  for (const candidate of [
    path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js"),
    path.join(root, "..", "..", "@openai", "codex", "bin", "codex.js")
  ]) {
    const normalized = path.normalize(candidate);
    if (isFile(normalized)) return normalized;
  }
  return undefined;
}

function resolveGlobalCodexBinary(
  options: CodexBinaryHintOptions
): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? os.homedir();
  const isFile = options.isFile ?? defaultIsFile;
  const candidates: string[] = [];

  if (platform === "win32") {
    if (env.APPDATA) {
      candidates.push(path.join(env.APPDATA, "npm", "codex.cmd"));
      candidates.push(path.join(env.APPDATA, "npm", "codex.exe"));
    }
    if (env.LOCALAPPDATA) {
      candidates.push(
        path.join(env.LOCALAPPDATA, "Yarn", "bin", "codex.cmd")
      );
      candidates.push(path.join(env.LOCALAPPDATA, "pnpm", "codex.cmd"));
    }
  } else {
    candidates.push(
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      path.join(home, ".local", "bin", "codex"),
      path.join(home, ".npm-global", "bin", "codex")
    );
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Best-effort sync lookup for the real Codex CLI (not the BYOK wrapper).
 * Order: explicit FREEBUDDY_CODEX_BIN → bundled with codex-acp → global codex.
 */
export function resolveCodexBinaryHint(
  options: CodexBinaryHintOptions = {}
): string | undefined {
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? defaultIsFile;

  const fromEnv = env.FREEBUDDY_CODEX_BIN?.trim();
  if (fromEnv && isFile(fromEnv)) return fromEnv;

  for (const root of codexAcpInstallRoots(options)) {
    const bundled = resolveBundledCodexFromAcpRoot(root, options);
    if (bundled) return bundled;
  }

  return resolveGlobalCodexBinary(options);
}

/** Absolute `node` for invoking bundled `codex.js` from the Windows/Unix wrapper. */
export function resolveNodeBinaryHint(
  options: CodexBinaryHintOptions = {}
): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const fromEnv = env.FREEBUDDY_NODE_BIN?.trim();
  if (fromEnv && isFile(fromEnv)) return fromEnv;

  const delimiter = platform === "win32" ? ";" : ":";
  const dirs = pathDirs(options.pathEnv ?? env.PATH, delimiter);
  const names =
    platform === "win32" ? ["node.exe", "node.cmd", "node"] : ["node"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }

  if (platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 =
      env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    for (const dir of [
      path.join(programFiles, "nodejs"),
      path.join(programFilesX86, "nodejs")
    ]) {
      const candidate = path.join(dir, "node.exe");
      if (isFile(candidate)) return candidate;
    }
  }

  return undefined;
}
