import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isMcpOAuthBrokerEndpoint } from "./mcpOAuthBroker.js";

export interface RemoteMcpConfig {
  transport: "http" | "sse";
  url: string;
  headers: Record<string, string>;
  oauth?: { endpoint: string; token: string };
}

// SDK errors can include response bodies, URLs, or authentication challenges.
// Only errors constructed here may escape the remote connection boundary.
class RemoteMcpError extends Error {
  constructor(message: string, readonly code = "remote_connection_failed") {
    super(message);
  }
}

function safeError(error?: unknown): RemoteMcpError {
  return error instanceof RemoteMcpError
    ? error
    : new RemoteMcpError("Remote MCP connection failed.");
}

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new RemoteMcpError("Remote MCP connection closed."));
    if (signal.aborted) {
      // Attach a rejection handler even when the operation was already started.
      void operation.catch(() => {});
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export function createRemoteMcpTransport(
  config: RemoteMcpConfig,
  signal?: AbortSignal
): Transport {
  let url: URL;
  let headers: Headers;
  try {
    url = new URL(config.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.hash ||
      !["http", "sse"].includes(config.transport) ||
      !config.headers || Array.isArray(config.headers) ||
      Object.values(config.headers).some((value) => typeof value !== "string")
    ) {
      throw new Error();
    }
    headers = new Headers(config.headers);
    if (config.oauth !== undefined && (
      !config.oauth || typeof config.oauth !== "object" ||
      !isMcpOAuthBrokerEndpoint(config.oauth.endpoint) ||
      typeof config.oauth.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(config.oauth.token) ||
      headers.has("authorization")
    )) throw new Error();
  } catch {
    throw new RemoteMcpError("Invalid remote MCP configuration.", "remote_config_invalid");
  }

  const controller = new AbortController();
  let closed = false;
  let closing: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let failure: RemoteMcpError | undefined;
  const tokenRequests = new Map<string, Promise<string>>();
  const oauthRequired = () => new RemoteMcpError("Sign in to this MCP server again.", "oauth_required");
  const oauthUnavailable = () => new RemoteMcpError("Authorization is temporarily unavailable. Try again.", "oauth_unavailable");

  async function startWatch(): Promise<void> {
    if (!config.oauth) return;
    let ready!: () => void;
    let rejectReady!: (error: Error) => void;
    const watchReady = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    // Do not await this reader from close(): the reader itself can initiate
    // close after a revocation or a lost main-process connection.
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetch(`${config.oauth!.endpoint}/watch`, {
          method: "GET",
          headers: { Authorization: `Bearer ${config.oauth!.token}` },
          redirect: "error",
          signal: controller.signal
        });
        if (!response.ok || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) {
          void response.body?.cancel().catch(() => {});
          throw response.status === 503 ? oauthUnavailable() : oauthRequired();
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let hasReady = false;
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) throw oauthRequired();
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
          if (buffer.length > 8 * 1024) throw oauthRequired();
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, boundary).split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
            buffer = buffer.slice(boundary + 2);
            if (event === "revoked") throw oauthRequired();
            if (event === "ready" && !hasReady) { hasReady = true; ready(); }
          }
        }
      } catch (error) {
        const safe = closed
          ? failure ?? new RemoteMcpError("Remote MCP connection closed.")
          : error instanceof RemoteMcpError ? error : oauthRequired();
        rejectReady(safe);
        if (!closed) {
          failure = safe;
          // Mark closed before notifying owners so a queued MCP event can no
          // longer reach the bridge, even if its socket has not closed yet.
          void transport.close();
          transport.onerror?.(safe);
        }
      } finally {
        // Abort normally cancels the fetch body. Cancel explicitly as well
        // when rejecting a malformed lifecycle event or completing startup.
        void reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    })();
    await watchReady;
  }

  async function getAccessToken(requestSignal: AbortSignal, forceRefresh = false, rejectedToken?: string): Promise<string> {
    if (!config.oauth) throw oauthRequired();
    // Main-process storage owns token freshness and revocation. Query it for
    // every MCP request; share only requests that are currently in flight.
    const key = forceRefresh ? `refresh:${rejectedToken ?? ""}` : "current";
    const existing = tokenRequests.get(key);
    if (existing) return untilAborted(existing, requestSignal);
    const pending = (async () => {
      try {
        const response = await fetch(config.oauth!.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.oauth!.token}` },
          body: JSON.stringify({ forceRefresh, ...(rejectedToken ? { rejectedToken } : {}) }),
          redirect: "error",
          signal: controller.signal
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw response.status === 401 || response.status === 403 ? oauthRequired() : oauthUnavailable();
        }
        const result = await response.json() as { accessToken?: unknown };
        if (typeof result.accessToken !== "string" || !result.accessToken || result.accessToken.length > 16 * 1024 || /\s|[^\x21-\x7e]/.test(result.accessToken)) {
          throw oauthUnavailable();
        }
        return result.accessToken;
      } catch (error) {
        throw error instanceof RemoteMcpError ? error : oauthUnavailable();
      }
    })();
    tokenRequests.set(key, pending);
    try { return await untilAborted(pending, requestSignal); }
    finally { if (tokenRequests.get(key) === pending) tokenRequests.delete(key); }
  }

  const guardedFetch: FetchLike = async (input, init) => {
    try {
      const target = new URL(String(input));
      // Legacy SSE announces its POST endpoint in an event. Check every fetch
      // as well as relying on the SDK's endpoint-origin validation.
      if (target.origin !== url.origin || target.username || target.password) {
        throw new RemoteMcpError("Remote MCP endpoint must use the configured origin.", "remote_origin_rejected");
      }
      const requestHeaders = new Headers(headers);
      new Headers(init?.headers).forEach((value, name) => requestHeaders.set(name, value));
      const requestSignal = init?.signal
        ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
      let usedToken: string | undefined;
      if (config.oauth) {
        usedToken = await getAccessToken(requestSignal);
        requestHeaders.set("Authorization", `Bearer ${usedToken}`);
      }
      const send = () => fetch(target, {
        ...init, headers: requestHeaders, redirect: "error", signal: requestSignal
      });
      let response = await send();
      if (config.oauth && response.status === 401) {
        void response.body?.cancel().catch(() => {});
        const refreshed = await getAccessToken(requestSignal, true, usedToken);
        requestHeaders.set("Authorization", `Bearer ${refreshed}`);
        response = await send();
      }
      // GET 405 is an explicitly supported Streamable HTTP capability response.
      if (!response.ok && !((init?.method ?? "GET") === "GET" && response.status === 405)) {
        void response.body?.cancel().catch(() => {});
        if (config.oauth && (response.status === 401 || response.status === 403)) throw oauthRequired();
        throw new RemoteMcpError(
          `Remote MCP request failed (HTTP ${response.status}).`,
          response.status === 401 || response.status === 403
            ? "remote_auth_failed"
            : "remote_http_error"
        );
      }
      return response;
    } catch (error) {
      failure = closed && failure ? failure : safeError(error);
      throw failure;
    }
  };

  const requestInit = { headers, redirect: "error" as const };
  const underlying: Transport = config.transport === "sse"
    ? new SSEClientTransport(url, {
        requestInit,
        fetch: guardedFetch,
        eventSourceInit: { fetch: guardedFetch }
      })
    : new StreamableHTTPClientTransport(url, {
        requestInit,
        fetch: guardedFetch,
        // A failed connection is closed by its owner, rather than silently
        // reconnecting with credentials after the stdio session has ended.
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1
        }
      });

  const onAbort = () => { void transport.close(); };
  const transport: Transport = {
    get sessionId() { return underlying.sessionId; },
    setProtocolVersion(version) { underlying.setProtocolVersion?.(version); },
    start() {
      if (closed) return Promise.reject(failure ?? new RemoteMcpError("Remote MCP connection closed."));
      starting ??= (async () => {
        try {
          await startWatch();
          if (closed) throw failure ?? new RemoteMcpError("Remote MCP connection closed.");
          await untilAborted(underlying.start(), controller.signal);
          if (closed) throw failure ?? new RemoteMcpError("Remote MCP connection closed.");
        } catch (error) {
          await transport.close();
          throw failure ?? safeError(error);
        }
      })();
      return starting;
    },
    async send(message, options) {
      if (closed) throw failure ?? new RemoteMcpError("Remote MCP connection closed.");
      try {
        await untilAborted(underlying.send(message, options), controller.signal);
      } catch (error) {
        throw failure ?? safeError(error);
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      controller.abort();
      signal?.removeEventListener("abort", onAbort);
      closing = Promise.resolve().then(async () => {
        try { await underlying.close(); } catch { /* Never expose SDK errors. */ }
        transport.onclose?.();
      });
      return closing;
    }
  };
  underlying.onmessage = (message, extra) => {
    if (!closed) transport.onmessage?.(message, extra);
  };
  underlying.onerror = (error) => {
    if (!closed) transport.onerror?.(failure ?? safeError(error));
  };
  underlying.onclose = () => { if (!closed) void transport.close(); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return transport;
}

export async function selfCheckRemoteMcpServer(
  config: RemoteMcpConfig,
  timeoutMs = 15_000
): Promise<string[]> {
  const controller = new AbortController();
  const transport = createRemoteMcpTransport(config, controller.signal);
  const client = new Client({ name: "freebuddy-mcp-check", version: "1.0.0" });
  let failure: Error | undefined;
  let timedOut = false;
  transport.onerror = (error) => {
    failure = error;
    controller.abort();
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
    const tools = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        signal: controller.signal,
        timeout: timeoutMs
      });
      for (const tool of result.tools) tools.add(tool.name);
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) {
        throw new RemoteMcpError("Remote MCP returned an invalid tools cursor.");
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...tools];
  } catch (error) {
    if (timedOut) throw new RemoteMcpError("Remote MCP connection timed out.", "remote_timeout");
    throw safeError(failure ?? error);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await client.close().catch(() => {});
    await transport.close();
  }
}
