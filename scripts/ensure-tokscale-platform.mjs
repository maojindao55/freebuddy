import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(
  fs.readFileSync(path.join(rootDir, "package.json"), "utf8")
);
const tokscaleVersion = rootPackage.dependencies?.tokscale;
if (!/^\d+\.\d+\.\d+$/.test(tokscaleVersion ?? "")) {
  throw new Error("package.json must pin tokscale to an exact version");
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const platform = option("platform", process.platform);
const arch = option("arch", process.arch);
const libc = option("libc", process.env.TOKSCALE_LIBC === "musl" ? "musl" : "gnu");

function platformPackageName() {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return `cli-darwin-${arch}`;
  }
  if (platform === "win32" && (arch === "arm64" || arch === "x64")) {
    return `cli-win32-${arch}-msvc`;
  }
  if (
    platform === "linux" &&
    (arch === "arm64" || arch === "x64") &&
    (libc === "gnu" || libc === "musl")
  ) {
    return `cli-linux-${arch}-${libc}`;
  }
  throw new Error(`tokscale does not support build target ${platform}/${arch}/${libc}`);
}

const packagePart = platformPackageName();
const packageName = `@tokscale/${packagePart}`;
const destination = path.join(rootDir, "node_modules", "@tokscale", packagePart);
const binaryName = platform === "win32" ? "tokscale.exe" : "tokscale";
const binaryPath = path.join(destination, "bin", binaryName);
const installedPackagePath = path.join(destination, "package.json");

try {
  const installed = JSON.parse(fs.readFileSync(installedPackagePath, "utf8"));
  if (installed.version === tokscaleVersion && fs.existsSync(binaryPath)) {
    console.log(`[tokscale] ${packageName}@${tokscaleVersion} is ready`);
    process.exit(0);
  }
} catch {
  // Download the target package below.
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-tokscale-"));
try {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = spawnSync(
    npmCommand,
    ["pack", `${packageName}@${tokscaleVersion}`, "--json", "--pack-destination", tempDir],
    { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  );
  if (packed.status !== 0) {
    throw new Error(`npm pack failed for ${packageName}@${tokscaleVersion}`);
  }
  const result = JSON.parse(packed.stdout);
  const filename = result?.[0]?.filename;
  if (typeof filename !== "string" || !filename) {
    throw new Error(`npm pack returned no archive for ${packageName}`);
  }

  const extracted = path.join(tempDir, "extracted");
  fs.mkdirSync(extracted, { recursive: true });
  const untar = spawnSync(
    "tar",
    ["-xzf", path.join(tempDir, filename), "--strip-components=1", "-C", extracted],
    { cwd: rootDir, stdio: "inherit" }
  );
  if (untar.status !== 0) throw new Error(`Could not extract ${filename}`);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(extracted, destination, { recursive: true, force: true });
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`${packageName} archive did not contain ${binaryName}`);
  }
  if (platform !== "win32") fs.chmodSync(binaryPath, 0o755);
  console.log(`[tokscale] installed ${packageName}@${tokscaleVersion} for packaging`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
