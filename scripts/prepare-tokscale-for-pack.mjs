import { Arch } from "builder-util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function packagePart(platform, arch) {
  if (platform === "darwin") return `cli-darwin-${arch}`;
  if (platform === "win32") return `cli-win32-${arch}-msvc`;
  if (platform === "linux") return `cli-linux-${arch}-gnu`;
  throw new Error(`Unsupported tokscale packaging platform: ${platform}`);
}

export default async function prepareTokscaleForPack(context) {
  const arch = Arch[context.arch];
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`Unsupported tokscale packaging architecture: ${arch}`);
  }
  const packageName = packagePart(context.electronPlatformName, arch);
  const source = path.join(
    rootDir,
    "node_modules",
    "@tokscale",
    packageName,
    "bin"
  );
  if (!fs.existsSync(source)) {
    throw new Error(
      `Missing @tokscale/${packageName}. Run scripts/ensure-tokscale-platform.mjs ` +
        `for ${context.electronPlatformName}/${arch} before electron-builder.`
    );
  }

  const destination = path.join(rootDir, ".build", "tokscale");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
  console.log(`[tokscale] prepared @tokscale/${packageName} for ${context.electronPlatformName}/${arch}`);
}
