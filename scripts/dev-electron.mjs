import spawn from "cross-spawn";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveElectronCommand } from "./electron-shell.mjs";

const viteUrl = "http://127.0.0.1:5173";
const children = new Set();
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: false,
    ...options
  });

  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

async function waitForVite() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(viteUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Vite is still booting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Vite dev server did not become ready at ${viteUrl}`);
}

function shutdown() {
  for (const child of children) {
    child.kill();
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

run("npm", ["run", "build:electron"]);
const vite = run("npm", ["exec", "vite", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"]);

await waitForVite();

const electronCommand = resolveElectronCommand(rootDir, path.join(rootDir, "dist-electron/main.js"));
const electron = run(electronCommand.command, electronCommand.args, {
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: viteUrl
  }
});

electron.on("exit", (code) => {
  vite.kill();
  process.exit(code ?? 0);
});
