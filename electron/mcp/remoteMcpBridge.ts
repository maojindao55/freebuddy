import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRemoteMcpTransport, type RemoteMcpConfig } from "../cli/remoteMcpTransport.js";

export interface RemoteMcpBridgeOptions {
  stdin?: Readable;
  stdout?: Writable;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export async function runRemoteMcpBridge(options: RemoteMcpBridgeOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const encoded = env.FREEBUDDY_REMOTE_MCP_CONFIG;
  // Do not let credentials survive in the environment of later child processes.
  delete env.FREEBUDDY_REMOTE_MCP_CONFIG;
  let config: RemoteMcpConfig;
  try {
    config = JSON.parse(encoded || "") as RemoteMcpConfig;
  } catch {
    throw new Error("Invalid remote MCP bridge configuration.");
  }

  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const remote = createRemoteMcpTransport(config, options.signal);
  const stdio = new StdioServerTransport(stdin, stdout);
  let stopped = false;
  let remoteReady!: Promise<void>;
  let initializeId: string | number | undefined;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Shutdown can happen while startup is still awaiting an SSE endpoint.
  // Mark the rejection handled until the startup path reaches `await done`.
  void done.catch(() => {});
  const timeout = setTimeout(() => { void stop(true); }, 15_000);

  async function stop(failed = false): Promise<void> {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    stdin.off("end", onEnd);
    stdin.off("close", onEnd);
    stdout.off("error", onFailure);
    process.off("SIGTERM", onEnd);
    process.off("SIGINT", onEnd);
    options.signal?.removeEventListener("abort", onEnd);
    await Promise.allSettled([stdio.close(), remote.close()]);
    if (failed) rejectDone(new Error("Remote MCP bridge connection failed."));
    else resolveDone();
  }
  function onEnd() { void stop(); }
  function onFailure() { void stop(true); }

  stdio.onmessage = (message) => {
    if (stopped) return;
    if ("method" in message && message.method === "initialize" && "id" in message) {
      initializeId = message.id;
    }
    // Start reading stdin immediately so EOF also closes a pending SSE startup.
    // Wait for the endpoint before sending buffered initialization messages.
    // Each message waits independently: serializing full send() calls can block
    // replies to server requests behind the request that needs those replies.
    void remoteReady.then(() => {
      if (!stopped) return remote.send(message);
    }).catch(onFailure);
  };
  remote.onmessage = (message) => {
    if (stopped) return;
    if ("id" in message && message.id === initializeId && "result" in message) {
      const result = message.result;
      if (typeof result.protocolVersion === "string") {
        remote.setProtocolVersion?.(result.protocolVersion);
      }
      clearTimeout(timeout);
      initializeId = undefined;
    }
    void stdio.send(message).catch(onFailure);
  };
  stdio.onerror = onFailure;
  remote.onerror = onFailure;
  stdio.onclose = onEnd;
  remote.onclose = onEnd;
  stdin.on("end", onEnd);
  stdin.on("close", onEnd);
  stdout.on("error", onFailure);
  process.on("SIGTERM", onEnd);
  process.on("SIGINT", onEnd);
  options.signal?.addEventListener("abort", onEnd, { once: true });
  try {
    if (options.signal?.aborted || stdin.readableEnded) await stop();
    else {
      remoteReady = remote.start();
      // Install a rejection handler before yielding to the stdio startup path.
      void remoteReady.catch(onFailure);
      await stdio.start();
      await remoteReady;
    }
  } catch {
    await stop(true);
  }
  await done;
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runRemoteMcpBridge().catch(() => {
    // Deliberately omit the error object: SDK/network errors may contain secrets.
    console.error("[FreeBuddy Remote MCP] Connection failed.");
    process.exitCode = 1;
  });
}
