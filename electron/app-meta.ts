import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { electronModule } from "./shared/electronModule.js";

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
  // ELECTRON_RUN_AS_NODE exposes Electron as its executable path. The package
  // file above is available for the normal development/test layouts; only a
  // real Electron main process may use the final runtime fallback.
  const app = electronModule()?.app;
  if (!app) throw new Error("Electron app APIs are unavailable while resolving the application version");
  return app.getVersion();
}

export const APP_VERSION = readAppVersion();
