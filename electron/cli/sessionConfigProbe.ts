import readline from "node:readline";
import { createHash } from "node:crypto";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import spawn from "cross-spawn";

import {
  acpSessionSetupToItems,
  buildInitializeRequest,
  buildSessionCloseRequest,
  buildSessionNewRequest,
  parseAcpLine,
  type AcpMessage
} from "./acp.js";
import { buildCommand, getAdapterDefinition } from "./adapters.js";
import { waitForCodexToolchainAutoUpdate } from "./check.js";
import { killProcessTree } from "./process-kill.js";
import { mergeBuiltEnv } from "./runtime.js";
import {
  cliByokModelSignature,
  mergeCliByokModelOption,
  resolveCliByokEnv
} from "./store.js";
import { getSetting, setSetting } from "./settings.js";

export interface SessionConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  currentLabel?: string;
  description?: string;
  values?: { id: string; name?: string }[];
}

export interface SessionConfigProbeInput {
  agentId: string;
  adapter: string;
  binary?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const CACHE_VERSION = 1;
const CACHE_PREFIX = "session-config-options:";

function sessionConfigCacheKey(input: SessionConfigProbeInput): string {
  // Deliberately exclude env values because they may contain API keys. Env
  // names, launch configuration, and the public BYOK model list are enough to
  // invalidate most stale catalogs, while a successful probe refreshes them.
  const signature = JSON.stringify({
    agentId: input.agentId,
    adapter: input.adapter,
    binary: input.binary ?? "",
    extraArgs: input.extraArgs ?? [],
    envKeys: Object.keys(input.env ?? {}).sort(),
    byokModels: cliByokModelSignature(input.agentId, input.adapter)
  });
  return `${CACHE_PREFIX}${createHash("sha256").update(signature).digest("hex")}`;
}

function validCachedOptions(value: unknown): SessionConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is SessionConfigOption =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as SessionConfigOption).id === "string"
  );
}

export function getCachedSessionConfigOptions(
  input: SessionConfigProbeInput
): SessionConfigOption[] {
  const raw = getSetting(sessionConfigCacheKey(input));
  if (!raw) return [];
  try {
    const cached = JSON.parse(raw) as {
      version?: number;
      options?: unknown;
    };
    if (cached.version !== CACHE_VERSION) return [];
    return validCachedOptions(cached.options);
  } catch {
    return [];
  }
}

function cacheSessionConfigOptions(
  input: SessionConfigProbeInput,
  options: SessionConfigOption[]
): void {
  // A transient empty response must not erase the last usable catalog.
  if (options.length === 0) return;
  setSetting(
    sessionConfigCacheKey(input),
    JSON.stringify({
      version: CACHE_VERSION,
      updatedAt: new Date().toISOString(),
      options
    })
  );
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${PROBE_TIMEOUT_MS}ms`)),
      PROBE_TIMEOUT_MS
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Starts a short-lived ACP session to discover the agent's real model/config
 * catalog before a FreeBuddy conversation exists. No prompt is sent and the
 * discovered ACP session is closed immediately when the agent supports close.
 */
export async function inspectSessionConfigOptions(
  input: SessionConfigProbeInput
): Promise<SessionConfigOption[]> {
  const definition = getAdapterDefinition(input.adapter);
  if (definition?.protocol !== "acp") return [];

  await waitForCodexToolchainAutoUpdate(input.adapter);
  const built = buildCommand({
    adapter: input.adapter,
    binary: input.binary,
    extraArgs: input.extraArgs,
    prompt: "",
    cwd: input.cwd
  });
  if (built.protocol !== "acp") return [];

  const env = mergeBuiltEnv(
    mergeBuiltEnv(
      { ...process.env, ...(input.env ?? {}) },
      built.env
    ),
    resolveCliByokEnv(
      input.agentId,
      input.adapter,
      built.env?.ANTHROPIC_MODEL
    )
  );
  const child = spawn(built.bin, built.args, {
    cwd: input.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  let nextRequestId = 0;
  let closed = false;
  const pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (reason: Error) => void }
  >();
  const stdout = readline.createInterface({ input: child.stdout });
  // Drain diagnostics so a verbose agent cannot fill the stderr pipe and
  // deadlock this otherwise short-lived metadata probe.
  child.stderr.resume();

  const rejectPending = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const request = (message: AcpMessage) =>
    withTimeout(
      new Promise<any>((resolve, reject) => {
        if (message.id == null) {
          reject(new Error("ACP requests require an id"));
          return;
        }
        pending.set(String(message.id), { resolve, reject });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }),
      message.method ?? "ACP request"
    );

  stdout.on("line", (line) => {
    const message = parseAcpLine(line);
    if (!message) return;
    if (message.id != null && (message.result !== undefined || message.error)) {
      const waiter = pending.get(String(message.id));
      if (!waiter) return;
      pending.delete(String(message.id));
      if (message.error) {
        const error = new Error(message.error.message);
        (error as Error & { code?: number }).code = message.error.code;
        waiter.reject(error);
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id != null) {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `FreeBuddy config probe does not implement ACP method ${message.method}`
          }
        })}\n`
      );
    }
  });

  child.once("close", (code) => {
    closed = true;
    rejectPending(new Error(`ACP config probe exited with code ${code ?? -1}`));
  });

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      "ACP config probe spawn"
    );

    const initialized = await request(
      buildInitializeRequest(++nextRequestId)
    );
    if (initialized?.protocolVersion !== 1) {
      throw new Error(
        `Unsupported ACP protocol version ${String(initialized?.protocolVersion ?? "missing")}`
      );
    }

    const created = await request(
      buildSessionNewRequest(++nextRequestId, input.cwd, [])
    );
    const sessionId = created?.sessionId ?? created?.session_id;
    const discoveredOptions = sessionId
      ? acpSessionSetupToItems(sessionId, created).find(
          (item) => item.kind === "config-options"
        )?.options ?? []
      : [];
    const options = mergeCliByokModelOption(
      input.agentId,
      input.adapter,
      discoveredOptions
    );

    if (
      sessionId &&
      initialized?.agentCapabilities?.sessionCapabilities?.close
    ) {
      await request(
        buildSessionCloseRequest(++nextRequestId, sessionId)
      ).catch(() => undefined);
    }
    cacheSessionConfigOptions(input, options);
    return options;
  } finally {
    stdout.close();
    rejectPending(new Error("ACP config probe finished"));
    try {
      child.stdin.end();
    } catch {
      /* noop */
    }
    if (!closed) {
      try {
        killProcessTree(child, "term");
      } catch {
        /* noop */
      }
    }
  }
}
