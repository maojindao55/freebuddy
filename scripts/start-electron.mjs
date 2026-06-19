import spawn from "cross-spawn";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveElectronCommand } from "./electron-shell.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronCommand = resolveElectronCommand(rootDir, path.join(rootDir, "dist-electron/main.js"));

const electron = spawn(electronCommand.command, electronCommand.args, {
  cwd: rootDir,
  stdio: "inherit",
  shell: false
});

electron.on("exit", (code) => {
  process.exit(code ?? 0);
});
