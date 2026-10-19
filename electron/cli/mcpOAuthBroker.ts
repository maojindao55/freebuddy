import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

const BODY_LIMIT = 8 * 1024;
export const MCP_OAUTH_BROKER_PATH_PREFIX = "/mcp-oauth/token/";
const BROKER_PATH = /^\/mcp-oauth\/token\/[a-f0-9]{64}$/;

export interface McpOAuthBrokerOptions {
  getAccessToken(serverId: string, forceRefresh: boolean, rejectedToken?: string): Promise<string>;
  isAllowed?(serverId: string): boolean;
}

export interface McpOAuthBrokerBinding {
  endpoint: string;
  token: string;
}

interface Binding extends McpOAuthBrokerBinding {
  serverId: string;
  url: string;
  path: string;
  watchers: Set<http.ServerResponse>;
}

function brokerError(code: "broker_forbidden" | "failed"): Error & { code: string } {
  return Object.assign(new Error("MCP authorization broker unavailable."), { code });
}

/** The bridge may contact only this application's local, capability-bound route. */
export function isMcpOAuthBrokerEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port) &&
      !url.username && !url.password && !url.search && !url.hash &&
      BROKER_PATH.test(url.pathname) && url.href === value;
  } catch {
    return false;
  }
}

export function createMcpOAuthBroker(options: McpOAuthBrokerOptions) {
  const byServer = new Map<string, Binding>();
  const byPath = new Map<string, Binding>();
  const sockets = new Set<import("node:net").Socket>();
  let server: http.Server | undefined;
  let starting: Promise<number> | undefined;
  let disposed = false;

  function allowed(serverId: string): boolean {
    try { return options.isAllowed?.(serverId) !== false; }
    catch { return false; }
  }

  function reply(response: http.ServerResponse, status: number, value: object) {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(JSON.stringify(value));
  }

  function revokeBinding(binding: Binding): void {
    byPath.delete(binding.path);
    for (const watcher of binding.watchers) {
      // This stream contains only lifecycle events, never OAuth credentials.
      watcher.end("event: revoked\ndata: {}\n\n");
    }
    binding.watchers.clear();
  }

  async function handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const address = server?.address();
    const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
    const isWatch = request.url?.endsWith("/watch") === true;
    const binding = byPath.get(isWatch ? request.url!.slice(0, -6) : request.url ?? "");
    const authorization = request.headers.authorization;
    const provided = typeof authorization === "string" && /^Bearer /i.test(authorization)
      ? authorization.slice(7) : "";
    const expected = binding?.token ?? "";
    const tokenMatches = /^[A-Za-z0-9_-]{43}$/.test(provided) && expected.length > 0 &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    const hostCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === "host").length;
    if (
      disposed || request.method !== (isWatch ? "GET" : "POST") || request.headers.host !== host || hostCount !== 1 ||
      request.socket.remoteAddress !== "127.0.0.1" || request.headers.origin !== undefined ||
      !binding || !tokenMatches || !allowed(binding.serverId)
    ) {
      reply(response, 403, { code: "broker_forbidden" });
      request.resume();
      return;
    }
    if (isWatch) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      binding.watchers.add(response);
      const remove = () => binding.watchers.delete(response);
      response.once("close", remove);
      response.once("error", remove);
      request.once("aborted", remove);
      response.write("event: ready\ndata: {}\n\n");
      request.resume();
      return;
    }
    let body: { forceRefresh?: boolean; rejectedToken?: string };
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new Error();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > BODY_LIMIT) {
          reply(response, 413, { code: "broker_forbidden" });
          request.resume();
          return;
        }
        chunks.push(bytes);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const value = parsed as Record<string, unknown>;
      if (
        Object.keys(value).some((key) => key !== "forceRefresh" && key !== "rejectedToken") ||
        (value.forceRefresh !== undefined && typeof value.forceRefresh !== "boolean") ||
        (value.rejectedToken !== undefined && typeof value.rejectedToken !== "string")
      ) throw new Error();
      body = value as typeof body;
    } catch {
      if (!response.headersSent) reply(response, 400, { code: "broker_forbidden" });
      return;
    }
    try {
      const accessToken = await options.getAccessToken(binding.serverId, body.forceRefresh === true, body.rejectedToken);
      // Revocation or a changed URL while refreshing must prevent delivery.
      if (byServer.get(binding.serverId) !== binding || !allowed(binding.serverId) || disposed) {
        reply(response, 403, { code: "broker_forbidden" });
        return;
      }
      if (typeof accessToken !== "string" || !accessToken || accessToken.length > 16 * 1024 || /\s|[^\x21-\x7e]/.test(accessToken)) {
        throw new Error();
      }
      reply(response, 200, { accessToken });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const requiresLogin = code === "oauth_required";
      reply(response, requiresLogin ? 401 : 503, {
        code: requiresLogin ? "oauth_required" : code === "oauth_refresh_failed" ? "oauth_unavailable" : "failed"
      });
    }
  }

  async function start(): Promise<number> {
    if (disposed) throw brokerError("failed");
    if (!starting) {
      starting = new Promise<number>((resolve, reject) => {
        server = http.createServer((request, response) => {
          void handle(request, response).catch(() => {
            if (!response.headersSent) reply(response, 503, { code: "failed" });
            else response.destroy();
          });
        });
        server.requestTimeout = 5000;
        server.headersTimeout = 5000;
        server.on("connection", (socket) => {
          socket.unref();
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
        });
        server.once("error", () => reject(brokerError("failed")));
        server.listen(0, "127.0.0.1", () => {
          const address = server?.address();
          if (!address || typeof address === "string") { reject(brokerError("failed")); return; }
          server?.unref();
          resolve(address.port);
        });
      });
    }
    return starting;
  }

  return {
    async bind(serverId: string, value: string): Promise<McpOAuthBrokerBinding> {
      let url: URL;
      try {
        url = new URL(value);
        if (!serverId || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
      } catch { throw brokerError("failed"); }
      if (!allowed(serverId)) throw brokerError("broker_forbidden");
      const port = await start();
      if (disposed) throw brokerError("failed");
      const previous = byServer.get(serverId);
      if (previous?.url === url.href) return { endpoint: previous.endpoint, token: previous.token };
      if (previous) revokeBinding(previous);
      const route = `${MCP_OAUTH_BROKER_PATH_PREFIX}${randomBytes(32).toString("hex")}`;
      const binding: Binding = {
        serverId, url: url.href, path: route, watchers: new Set(),
        endpoint: `http://127.0.0.1:${port}${route}`,
        token: randomBytes(32).toString("base64url")
      };
      byServer.set(serverId, binding);
      byPath.set(route, binding);
      return { endpoint: binding.endpoint, token: binding.token };
    },
    revoke(serverId: string): void {
      const binding = byServer.get(serverId);
      if (binding) revokeBinding(binding);
      byServer.delete(serverId);
    },
    async dispose(): Promise<void> {
      disposed = true;
      for (const binding of byServer.values()) revokeBinding(binding);
      byServer.clear();
      byPath.clear();
      if (!starting) return;
      await starting.catch(() => {});
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  };
}
