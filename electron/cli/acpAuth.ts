import readline from "node:readline";
import { type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import spawn from "cross-spawn";

import {
  buildCommand,
  type CLIAdapterId
} from "./adapters.js";
import {
  buildInitializeRequest,
  buildLogoutRequest,
  type AcpMessage
} from "./acp.js";
import { killProcessTree } from "./process-kill.js";
import { mergeBuiltEnv } from "./runtime.js";
import {
  clearToolSessionsForAgent,
  resolveCliByokEnv
} from "./store.js";

export interface CliAuthControlArgs {
  agentId: string;
  adapter: CLIAdapterId;
  binary?: string;
  extraArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface CliAuthProbeResult {
  authMethods: Array<{
    methodId: string;
    name: string;
    description?: string;
    type: "agent" | "terminal" | "env_var";
  }>;
  logoutSupported: boolean;
}

async function withAcpAgent<T>(
  args: CliAuthControlArgs,
  operation: (request: (message: AcpMessage) => Promise<any>) => Promise<T>
): Promise<T> {
  const built = buildCommand({
    adapter: args.adapter,
    binary: args.binary,
    extraArgs: args.extraArgs,
    prompt: "",
    cwd: args.cwd
  });
  if (built.protocol !== "acp") {
    throw new Error("Authentication control requires an ACP agent.");
  }
  const env = mergeBuiltEnv(
    mergeBuiltEnv(
      { ...process.env, ...(args.env ?? {}) },
      resolveCliByokEnv(args.agentId, args.adapter)
    ),
    built.env
  );
  const child = spawn(built.bin, built.args, {
    cwd: args.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  }) as ChildProcessByStdio<Writable, Readable, Readable>;
  const pending = new Map<
    string,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  const output = readline.createInterface({ input: child.stdout });
  output.on("line", (line) => {
    let message: AcpMessage;
    try {
      message = JSON.parse(line) as AcpMessage;
    } catch {
      return;
    }
    if (message.id == null) return;
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
  });
  child.on("close", (code) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`ACP agent exited with code ${code ?? -1}.`));
    }
    pending.clear();
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const request = (message: AcpMessage) =>
    new Promise<any>((resolve, reject) => {
      if (message.id == null) {
        reject(new Error("ACP requests require an id."));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(String(message.id));
        reject(new Error(`ACP ${message.method ?? "request"} timed out.`));
      }, 10_000);
      pending.set(String(message.id), {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });

  try {
    return await operation(request);
  } finally {
    output.close();
    try {
      child.stdin.end();
    } catch {
      /* noop */
    }
    try {
      killProcessTree(child, "term");
    } catch {
      /* noop */
    }
  }
}

export async function probeAcpAuthentication(
  args: CliAuthControlArgs
): Promise<CliAuthProbeResult> {
  return withAcpAgent(args, async (request) => {
    const initialized = await request(buildInitializeRequest(1));
    if (initialized?.protocolVersion !== 1) {
      throw new Error(
        `Unsupported ACP protocol version ${String(initialized?.protocolVersion ?? "missing")}.`
      );
    }
    const methods = Array.isArray(initialized?.authMethods)
      ? initialized.authMethods
      : [];
    return {
      authMethods: methods
        .filter((method: any) => typeof method?.id === "string")
        .map((method: any) => ({
          methodId: method.id,
          name: typeof method.name === "string" ? method.name : method.id,
          ...(typeof method.description === "string"
            ? { description: method.description }
            : {}),
          type:
            method.type === "terminal" || method.type === "env_var"
              ? method.type
              : "agent"
        })),
      logoutSupported:
        initialized?.agentCapabilities?.auth?.logout != null
    };
  });
}

export async function logoutAcpAgent(
  args: CliAuthControlArgs
): Promise<void> {
  await withAcpAgent(args, async (request) => {
    const initialized = await request(buildInitializeRequest(1));
    if (initialized?.agentCapabilities?.auth?.logout == null) {
      throw new Error("This ACP agent does not advertise logout support.");
    }
    await request(buildLogoutRequest(2));
  });
  clearToolSessionsForAgent(args.agentId);
}
