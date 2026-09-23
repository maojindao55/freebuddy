import { constants, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const RELAY_KEYS = new Set(["DEV_AUTH_HOST_ID", "DEV_AUTH_HOST_TOKEN", "LISTEN_ADDR"]);
const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const PID_LINE = /^[1-9][0-9]*$/;

function fail(message) {
  throw new Error(`read-only remote development: ${message}`);
}

function parseEnv(data) {
  const values = {};
  for (const rawLine of data.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(ENV_LINE);
    if (!match || !RELAY_KEYS.has(match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export async function readRelayDevelopmentEnv(envPath) {
  const before = await fs.lstat(envPath);
  if (!before.isFile() || before.isSymbolicLink()) fail("Relay env file must be a regular, non-symlink file");
  if (before.uid !== process.getuid()) fail("Relay env file must be owned by the current user");
  if (before.mode & 0o077 || ![0o400, 0o600].includes(before.mode & 0o777)) fail("Relay env file permissions must be 0400 or 0600");

  const handle = await fs.open(envPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.uid !== process.getuid() || opened.mode & 0o077 || ![0o400, 0o600].includes(opened.mode & 0o777)) {
      fail("Relay env file changed or failed secure descriptor validation");
    }
    const data = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(data) > 64 * 1024) fail("Relay env file exceeds 64 KiB");
    const values = parseEnv(data);
    if (!values.DEV_AUTH_HOST_ID || !values.DEV_AUTH_HOST_TOKEN) fail("Relay env file is missing development host credentials");
    return values;
  } finally {
    await handle.close();
  }
}

export function relayEndpoint(listenAddress) {
  const address = listenAddress || "127.0.0.1:8080";
  const match = address.match(/^127\.0\.0\.1:(\d{1,5})$/);
  if (!match) fail("Relay LISTEN_ADDR must be an explicit 127.0.0.1 port");
  const port = Number(match[1]);
  if (port < 1 || port > 65535) fail("Relay LISTEN_ADDR port is invalid");
  return `ws://127.0.0.1:${port}/v1/ws/host`;
}

export async function verifyRelayPid(pidPath) {
  const before = await fs.lstat(pidPath);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() || before.mode & 0o077) {
    fail("Relay PID record must be a private, current-user regular file");
  }
  const handle = await fs.open(pidPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let record;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.uid !== process.getuid() || opened.mode & 0o077) {
      fail("Relay PID record changed or failed secure descriptor validation");
    }
    record = await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
  const lines = record.split(/\r?\n/);
  const pid = lines[0]?.trim();
  const fields = new Map(lines.slice(1).map(line => {
    const index = line.indexOf("=");
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : ["", ""];
  }));
  const lstart = fields.get("LSTART")?.trim();
  const binary = fields.get("BIN")?.trim();
  if (!PID_LINE.test(pid || "") || !lstart || !binary || !/^relay(?:\.[A-Za-z0-9_-]+)?$/.test(path.basename(binary))) {
    fail("Relay PID record is incomplete or invalid");
  }
  try {
    process.kill(Number(pid), 0);
  } catch {
    fail("Relay PID is not running");
  }
  let lstartOutput;
  let commandOutput;
  try {
    ({ stdout: lstartOutput } = await execFile("ps", ["-p", pid, "-o", "lstart="]));
    ({ stdout: commandOutput } = await execFile("ps", ["-p", pid, "-o", "command="]));
  } catch {
    fail("could not verify Relay process identity");
  }
  let observedStartTime = lstartOutput.trim();
  if (observedStartTime !== lstart) {
    try {
      ({ stdout: lstartOutput } = await execFile("ps", ["-p", pid, "-o", "lstart="], {
        env: { ...process.env, LC_ALL: "zh_CN.UTF-8" }
      }));
      observedStartTime = lstartOutput.trim();
    } catch {
      fail("could not verify Relay process start time");
    }
  }
  if (observedStartTime !== lstart || !commandOutput.trim().includes(binary)) {
    fail("Relay PID identity does not match its launch record");
  }
}

async function availableLoopbackPort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = reservation.address();
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") fail("could not reserve a loopback Vite port");
  return address.port;
}

export async function createLoopbackViteServer(createServer, loadConfigFromFile, rootDir) {
  const loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, path.join(rootDir, "vite.config.ts"));
  if (!loaded) fail("could not load the Vite development configuration");
  const port = await availableLoopbackPort();
  const server = await createServer({
    ...loaded.config,
    configFile: false,
    root: rootDir,
    server: { ...loaded.config.server, host: "127.0.0.1", port, strictPort: true }
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    await server.close();
    fail("Vite did not bind a loopback TCP port");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}
