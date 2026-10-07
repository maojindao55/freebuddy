import fs from "node:fs";
import path from "node:path";
import { extractSemver } from "./version.js";

export interface RuntimePackagePolicy {
  packageName: string;
  minimumVersion?: string;
  /** Claude's --cli --version reports its engine, not the ACP package. */
  packageVersionOnly?: boolean;
  managed?: boolean;
}

const policies: Record<string, RuntimePackagePolicy> = {
  codex: { packageName: "@openai/codex" },
  "codex-acp": { packageName: "@agentclientprotocol/codex-acp" },
  claude: { packageName: "@anthropic-ai/claude-code" },
  "claude-agent-acp": { packageName: "@agentclientprotocol/claude-agent-acp", packageVersionOnly: true },
  opencode: { packageName: "opencode-ai" },
  "opencode-acp": { packageName: "opencode-ai" },
  "codebuddy-acp": { packageName: "@tencent-ai/codebuddy-code" },
  "agy-acp": { packageName: "agy-acp-bridge", minimumVersion: "0.3.8" },
  "dsh-acp": { packageName: "deepseek-harness-acp", managed: true },
  "zcode-acp": { packageName: "zcode-acp-server" },
  "cline-acp": { packageName: "cline" }
};

export function getRuntimePackagePolicy(adapter: string): RuntimePackagePolicy | undefined {
  return policies[adapter];
}

export interface RuntimePackage {
  version: string;
  directory: string;
  /** Present only for a global npm installation, never a project's dependency. */
  prefix?: string;
}

/** Follow the executable, including Windows npm shims, to its actual package. */
export function readRuntimePackage(binary: string | undefined, packageName: string): RuntimePackage | undefined {
  if (!binary) return undefined;
  const read = (directory: string): RuntimePackage | undefined => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      const version = pkg.name === packageName ? extractSemver(pkg.version)?.raw : undefined;
      if (!version) return undefined;
      const suffix = path.join("node_modules", ...packageName.split("/"));
      const normalized = directory.replace(/\\/g, "/");
      const globalSuffix = `/lib/${suffix.replace(/\\/g, "/")}`;
      const prefix = normalized.endsWith(globalSuffix) ? directory.slice(0, -globalSuffix.length) : undefined;
      return { version, directory, ...(prefix ? { prefix } : {}) };
    } catch { return undefined; }
  };
  try {
    let directory = path.dirname(fs.realpathSync(binary));
    while (true) {
      const info = read(directory);
      if (info) return info;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    // .cmd/.ps1 launchers are files, not symlinks. Require the package reference
    // in the shim so an unrelated package beside an executable cannot match.
    if (fs.statSync(binary).size <= 64 * 1024) {
      const shim = fs.readFileSync(binary, "utf8").replace(/\\/g, "/");
      if (shim.includes(`node_modules/${packageName}/`)) {
        const info = read(path.join(path.dirname(binary), "node_modules", ...packageName.split("/")));
        if (info) return { ...info, prefix: path.dirname(binary) };
      }
    }
  } catch { /* A missing or native executable has no npm package identity. */ }
  return undefined;
}
