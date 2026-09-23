import spawn from "cross-spawn";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, loadConfigFromFile } from "vite";

import { resolveElectronCommand } from "./electron-shell.mjs";
import { createLoopbackViteServer, readRelayDevelopmentEnv, relayEndpoint, verifyRelayPid } from "./readonly-remote-dev.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const relayDir = path.join(rootDir, "services", "remote-relay");
const envPath = path.join(relayDir, ".local", "dev.env");
const pidPath = path.join(relayDir, ".local", "relay.pid");
const children = new Set();

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: rootDir, stdio: "inherit", shell: false, ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function waitForExit(child, label) {
  return new Promise((resolve, reject) => child.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `code ${code}`}`));
  }));
}

let vite;
let shuttingDown = false;
async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  if (vite) await vite.close();
  process.exit(exitCode);
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

try {
  const relayEnv = await readRelayDevelopmentEnv(envPath);
  await verifyRelayPid(pidPath);
  const endpoint = relayEndpoint(relayEnv.LISTEN_ADDR);

  await waitForExit(run("npm", ["run", "build:packages"]), "build:packages");
  await waitForExit(run("npm", ["run", "build:electron"]), "build:electron");
  const viteServer = await createLoopbackViteServer(createServer, loadConfigFromFile, rootDir);
  vite = viteServer.server;

  const electronCommand = resolveElectronCommand(rootDir, path.join(rootDir, "dist-electron/main.js"));
  const electron = run(electronCommand.command, electronCommand.args, {
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: viteServer.url,
      FB_REMOTE_READONLY_DEV: "1",
      FB_REMOTE_DEV_ENDPOINT: endpoint,
      FB_REMOTE_DEV_HOST_ID: relayEnv.DEV_AUTH_HOST_ID,
      FB_REMOTE_DEV_HOST_TOKEN: relayEnv.DEV_AUTH_HOST_TOKEN
    }
  });
  electron.once("exit", code => void shutdown(code ?? 0));
} catch (error) {
  console.error(error instanceof Error ? error.message : "read-only remote development startup failed");
  await shutdown(1);
}
