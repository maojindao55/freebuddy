import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

export const APP_NAME = "FreeBuddy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readAppVersion(): string {
  // In dev, Electron is launched against dist-electron/main.js, so
  // app.getAppPath() is dist-electron/ (no package.json) and app.getVersion()
  // falls back to Electron's own version. Read package.json directly so the
  // value matches the release tag in both dev and packaged builds.
  try {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    /* fall back to app.getVersion() below */
  }
  return app.getVersion();
}

export const APP_VERSION = readAppVersion();
