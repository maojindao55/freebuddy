/**
 * Real Go Relay process harness.
 *
 * The W2 unit tests drive `RelaySocket` through an in-memory fake transport, which can only
 * prove that this client behaves as *designed*. This harness proves it behaves correctly against
 * the *authoritative* implementation: it builds `services/remote-relay/cmd/relay` into a
 * throw-away directory, starts it on a random loopback port with a throw-away SQLite file and
 * crypto-random DEV tokens, and removes every artifact afterwards.
 *
 * Everything secret lives only in this process's memory and in the child's environment block:
 * no token is written to a file, a fixture, a log file or the repository.
 *
 * `extraEnv` lets a caller add the Relay's own production-auth variables (random AppID/AppSecret/
 * ADMIN_OPENID/pepper and a loopback `WECHAT_API_BASE_URL`) for the M4 auth integration test. They
 * take the same route as every other secret here: the child's environment block only. The Relay
 * config loader rejects an arbitrary `WECHAT_API_BASE_URL` while `DEV_AUTH_MODE=false`, so the only
 * external seam for a fake `code2Session` is the DEV loopback the harness already runs.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPO_ROOT } from "./paths";

const RELAY_MODULE_DIR = join(REPO_ROOT, "services", "remote-relay");

/**
 * 48 characters from the OpaqueToken alphabet, matching `protocol/remote/v1` and the Relay's
 * entropy rules (>= 32 chars, no whitespace, no weak repetition).
 */
export function randomOpaqueToken(): string {
  return randomBytes(36).toString("base64url");
}

export interface RelayInstance {
  readonly hostId: string;
  readonly adminToken: string;
  readonly hostToken: string;
  readonly httpBaseUrl: string;
  readonly adminSocketUrl: string;
  readonly hostSocketUrl: string;
  /** Directory that holds the temporary SQLite file; removed on stop. */
  readonly tempDir: string;
  /** stdout + stderr captured in memory. Never written to disk. */
  logs(): string;
  isRunning(): boolean;
  /** Graceful stop: SIGTERM (exercises `server.draining` + shutdown), then SIGKILL. */
  stop(): Promise<void>;
  /** Hard stop: SIGKILL, i.e. what a crash looks like to the client. */
  kill(): Promise<void>;
}

let builtBinary: string | null = null;

/** Builds the Relay once per test process into a temporary directory. */
function ensureBinary(): string {
  if (builtBinary !== null && existsSync(builtBinary)) {
    return builtBinary;
  }
  const dir = mkdtempSync(join(tmpdir(), "fb-relay-build-"));
  const out = join(dir, "relay");
  const result = spawnSync("go", ["build", "-o", out, "./cmd/relay"], {
    cwd: RELAY_MODULE_DIR,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `go build ./cmd/relay failed (status ${result.status}): ${result.stderr ?? "no stderr"}`
    );
  }
  builtBinary = out;
  return out;
}

/** Removes the temporary build output. Called from the test file's teardown. */
export function cleanupRelayBuild(): void {
  if (builtBinary === null) {
    return;
  }
  rmSync(join(builtBinary, ".."), { recursive: true, force: true });
  builtBinary = null;
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TCP connect probe. Deliberately not `fetch`: the global dispatcher keeps sockets alive, and a
 * lingering agent handle would keep the test process (and its reporting) alive.
 */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export interface StartRelayOptions {
  /** Extra environment for the Relay child; overrides the defaults above. Never written to disk. */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export async function startRelay(options: StartRelayOptions = {}): Promise<RelayInstance> {
  const binary = ensureBinary();
  const tempDir = mkdtempSync(join(tmpdir(), "fb-relay-w2-"));
  const port = await reserveLoopbackPort();

  const adminToken = randomOpaqueToken();
  const hostToken = randomOpaqueToken();
  const hostId = `host_w2_${randomBytes(4).toString("hex")}`;

  const child: ChildProcess = spawn(binary, [], {
    cwd: tempDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/local/go/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? tempDir,
      TMPDIR: tempDir,
      LISTEN_ADDR: `127.0.0.1:${port}`,
      SQLITE_PATH: join(tempDir, "relay.sqlite"),
      DEV_AUTH_MODE: "true",
      DEV_AUTH_ADMIN_TOKEN: adminToken,
      DEV_AUTH_HOST_TOKEN: hostToken,
      DEV_AUTH_HOST_ID: hostId,
      LOG_LEVEL: "debug",
      LOG_FORMAT: "text",
      // Short enough that a missed heartbeat is observable, still inside protocol bounds.
      HEARTBEAT_INTERVAL: "5s",
      HEARTBEAT_TIMEOUT: "2s",
      ...options.extraEnv
    }
  });

  const chunks: string[] = [];
  let exited = false;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: string) => chunks.push(chunk));
  child.once("exit", () => {
    exited = true;
  });

  const logs = (): string => chunks.join("");
  const httpBaseUrl = `http://127.0.0.1:${port}`;

  let ready = false;
  const deadline = Date.now() + 30_000;
  while (!ready && Date.now() < deadline) {
    if (exited) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new Error(`relay exited before becoming ready:\n${logs()}`);
    }
    ready = await probePort(port);
    if (!ready) {
      await delay(25);
    }
  }
  if (!ready) {
    child.kill("SIGKILL");
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`relay did not answer /healthz within 30s:\n${logs()}`);
  }

  async function terminate(signal: NodeJS.Signals): Promise<void> {
    if (!exited) {
      child.kill(signal);
      const killDeadline = Date.now() + 10_000;
      while (!exited && Date.now() < killDeadline) {
        await delay(25);
      }
      if (!exited) {
        child.kill("SIGKILL");
      }
    }
    // Abandon capture: nothing may keep the temp directory alive.
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    hostId,
    adminToken,
    hostToken,
    httpBaseUrl,
    adminSocketUrl: `ws://127.0.0.1:${port}/v1/ws/admin`,
    hostSocketUrl: `ws://127.0.0.1:${port}/v1/ws/host`,
    tempDir,
    logs,
    isRunning: () => !exited,
    stop: () => terminate("SIGTERM"),
    kill: () => terminate("SIGKILL")
  };
}
