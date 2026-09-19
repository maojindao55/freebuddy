/**
 * Stage the bundled pi runtime (pi coding agent + pi-acp ACP bridge) into
 * .build/pi-runtime so electron-builder can ship it as an extraResource.
 *
 * Versions are pinned as exact devDependencies in package.json; this script
 * installs a minimal dependency tree into the staging dir and writes a
 * pi-runtime.json manifest consumed by electron/cli/piRuntime.ts.
 *
 * Idempotent: exits quickly when the staged tree already matches the pins.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(
  fs.readFileSync(path.join(rootDir, "package.json"), "utf8")
);
const devDeps = rootPackage.devDependencies ?? {};
const piVersion = devDeps["@earendil-works/pi-coding-agent"];
const piAcpVersion = devDeps["pi-acp"];

for (const [name, version] of [
  ["@earendil-works/pi-coding-agent", piVersion],
  ["pi-acp", piAcpVersion]
]) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error(
      `package.json devDependencies must pin ${name} to an exact version (found: ${String(version)})`
    );
  }
}

const outDir = path.join(rootDir, ".build", "pi-runtime");
const manifestPath = path.join(outDir, "pi-runtime.json");
const piAcpEntry = path.join(
  outDir,
  "node_modules",
  "pi-acp",
  "dist",
  "index.js"
);
const piCliEntry = path.join(
  outDir,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js"
);

function entriesPresent() {
  return fs.existsSync(piAcpEntry) && fs.existsSync(piCliEntry);
}

let upToDate = false;
try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  upToDate =
    manifest.piVersion === piVersion &&
    manifest.piAcpVersion === piAcpVersion &&
    entriesPresent();
} catch {
  upToDate = false;
}

if (upToDate) {
  console.log(`[pi-runtime] pi@${piVersion} + pi-acp@${piAcpVersion} ready`);
  process.exit(0);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "package.json"),
  `${JSON.stringify(
    {
      name: "freebuddy-pi-runtime",
      private: true,
      dependencies: {
        "@earendil-works/pi-coding-agent": piVersion,
        "pi-acp": piAcpVersion
      }
    },
    null,
    2
  )}\n`
);

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const install = spawnSync(
  npmCommand,
  [
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--loglevel=error"
  ],
  {
    cwd: outDir,
    stdio: "inherit",
    ...(process.platform === "win32" ? { shell: true } : {})
  }
);
if (install.status !== 0) {
  throw new Error(`npm install failed in ${outDir} (exit ${install.status})`);
}
if (!entriesPresent()) {
  throw new Error("pi runtime entries missing after install");
}

fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    { schemaVersion: 1, piVersion, piAcpVersion },
    null,
    2
  )}\n`
);
console.log(
  `[pi-runtime] staged pi@${piVersion} + pi-acp@${piAcpVersion} into ${outDir}`
);
