import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

import { sendJson, readJsonBody } from "./httpUtils.js";
import {
  resolveWorkspaceRoots,
  isPathWithinRoots,
  parentWithinRoots
} from "./shared/workspaceRoots.js";
import {
  buildSessionCookieHeader,
  buildExpiredSessionCookieHeader,
  readSessionCookie,
  createSession,
  checkSession,
  destroySession,
  extractBearerToken,
  hashSessionToken,
  sessionUserId,
  setSessionRevocationListener,
  type SessionRevocation
} from "./remoteAuth.js";
import { verifyUserLogin, getOwnerUser, getUserById, listUsers } from "./cli/users.js";
import { getLanguage } from "./cli/settings.js";
import {
  remoteRootsForUser,
  remoteSourceRootsForUser
} from "./cli/remoteRoots.js";
import { recordAudit } from "./cli/remoteAudit.js";
import {
  checkLoginAllowed,
  loginAttemptKey,
  recordLoginFailure,
  recordLoginSuccess
} from "./remoteLoginLimit.js";
import { runAsCaller } from "./cli/callerContext.js";
import { getSessionOwner } from "./cli/sessionOwners.js";
import { getConversation } from "./cli/conversations.js";
import {
  classifyWsChannel,
  conversationIdFromPayload,
  ownerFromPayload,
  type WsChannelClass
} from "./shared/wsChannelPolicy.js";
import { localInvoke } from "./invokeRegistry.js";
import { setEventBroadcaster } from "./eventBus.js";
import {
  canServeAttachmentPath,
  prepareAttachmentFiles,
  type PrepareAttachmentPayload
} from "./cli/attachments.js";
import { handleDraftRequest, parseDraftUrl } from "./draftProtocol.js";
import {
  WEBUI_DEFAULT_PORT,
  normalizeWebUIPort
} from "./webUIConstants.js";

export {
  WEBUI_DEFAULT_PORT,
  WEBUI_MIN_PORT,
  WEBUI_MAX_PORT,
  normalizeWebUIPort
} from "./webUIConstants.js";

let webuiServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
const authedClients = new Set<WebSocket>();
const clientUsers = new Map<WebSocket, string>();
const clientTokenHashes = new Map<WebSocket, string>();
let currentPort = WEBUI_DEFAULT_PORT;
let requestedPort = WEBUI_DEFAULT_PORT;
let currentHost = "127.0.0.1";
let currentAllowRemote = false;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm"
};

let indexHtmlCache: string | null = null;
let indexHtmlDistDir = "";

function getIndexHtml(distDir: string): string | null {
  if (indexHtmlCache !== null && indexHtmlDistDir === distDir) return indexHtmlCache;
  try {
    const raw = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
    indexHtmlDistDir = distDir;
    indexHtmlCache = raw.includes("/web-preload.js")
      ? raw
      : raw.replace("</head>", '<script src="/web-preload.js"></script></head>');
    return indexHtmlCache;
  } catch {
    return null;
  }
}

function serveFile(res: ServerResponse, filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

function serveSpaIndex(res: ServerResponse, distDir: string): void {
  const html = getIndexHtml(distDir);
  if (html === null) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function serveStatic(
  res: ServerResponse,
  distDir: string,
  pathname: string
): boolean {
  if (!fs.existsSync(distDir)) return false;

  if (pathname === "/" || pathname === "/index.html") {
    serveSpaIndex(res, distDir);
    return true;
  }

  const decoded = decodeURIComponent(pathname);
  const filePath = path.resolve(path.join(distDir, decoded));
  const normalizedDist = path.resolve(distDir);
  if (filePath !== normalizedDist && !filePath.startsWith(normalizedDist + path.sep)) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return true;
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      serveFile(res, filePath);
      return true;
    }
    if (stat.isDirectory()) {
      const indexPath = path.join(filePath, "index.html");
      if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
        serveSpaIndex(res, distDir);
        return true;
      }
    }
  } catch {
    // fall through to SPA fallback
  }

  serveSpaIndex(res, distDir);
  return true;
}

function isAuthed(req: IncomingMessage): boolean {
  return (
    checkSession(extractBearerToken(req.headers.authorization)) ||
    checkSession(readSessionCookie(req.headers.cookie))
  );
}

/** Auth for <img>/<iframe> media routes: cookie, bearer, or ?token=. */
function mediaAuthToken(req: IncomingMessage): string | null {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const fromQuery = url.searchParams.get("token")?.trim();
  return (
    extractBearerToken(req.headers.authorization) ||
    readSessionCookie(req.headers.cookie) ||
    (fromQuery ? fromQuery : null)
  );
}

function isMediaAuthed(req: IncomingMessage): boolean {
  return checkSession(mediaAuthToken(req));
}

function requestToken(req: IncomingMessage): string | null {
  return (
    extractBearerToken(req.headers.authorization) ??
    readSessionCookie(req.headers.cookie)
  );
}

function clientIp(req: IncomingMessage): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof first === "string" && first.trim()) {
    return first.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? null;
}

function userAgent(req: IncomingMessage): string | null {
  const value = req.headers["user-agent"];
  return typeof value === "string" ? value.slice(0, 256) : null;
}

/** Closes the live sockets belonging to sessions an admin just revoked. */
function dropRevokedSockets(revocation: SessionRevocation): void {
  const tokens = new Set(revocation.tokens ?? []);
  const users = new Set(revocation.userIds ?? []);
  for (const client of [...authedClients]) {
    const matches =
      revocation.all === true ||
      tokens.has(clientTokenHashes.get(client) ?? "") ||
      users.has(clientUsers.get(client) ?? "");
    if (!matches) continue;
    authedClients.delete(client);
    clientUsers.delete(client);
    clientTokenHashes.delete(client);
    try {
      client.close(1008, "session_revoked");
    } catch {
      /* already gone */
    }
  }
}

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname !== "/api/login" || req.method !== "POST") return false;
  const body = (await readJsonBody(req)) as { username?: string; password?: string } | null;
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (listUsers().length === 0) {
    sendJson(res, 200, { ok: false, error: "remote_not_initialized" });
    return true;
  }

  const ip = clientIp(req);
  const attemptKey = loginAttemptKey(ip, username);
  const gate = checkLoginAllowed(attemptKey);
  if (!gate.allowed) {
    const retryAfter = Math.ceil(gate.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    sendJson(res, 429, { ok: false, error: "too_many_attempts", retryAfter });
    return true;
  }

  const user = verifyUserLogin(username, password);
  if (user) {
    recordLoginSuccess(attemptKey);
    const token = createSession(user.id, { ip, userAgent: userAgent(req) });
    res.setHeader("Set-Cookie", buildSessionCookieHeader(token));
    recordAudit({
      event: "login.success",
      actorId: user.id,
      actorName: user.username,
      ip,
      detail: userAgent(req)
    });
    sendJson(res, 200, { ok: true, token });
  } else {
    const lockedForMs = recordLoginFailure(attemptKey);
    recordAudit({
      event: lockedForMs > 0 ? "login.locked" : "login.failure",
      actorName: username || null,
      ip,
      detail: lockedForMs > 0 ? `locked for ${Math.ceil(lockedForMs / 1000)}s` : null
    });
    sendJson(res, 200, { ok: false, error: "invalid_credentials" });
  }
  return true;
}

async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname !== "/api/logout" || req.method !== "POST") return false;
  const token = requestToken(req);
  if (token) {
    const userId = sessionUserId(token);
    destroySession(token);
    if (userId) {
      recordAudit({
        event: "logout",
        actorId: userId,
        actorName: getUserById(userId)?.username ?? null,
        ip: clientIp(req)
      });
    }
  }
  res.setHeader("Set-Cookie", buildExpiredSessionCookieHeader());
  sendJson(res, 200, { ok: true });
  return true;
}

function handleStatus(res: ServerResponse): void {
  sendJson(res, 200, {
    ok: true,
    webui: true,
    hasPassword: listUsers().length > 0,
    // Unauthenticated login UI uses this so the page matches the host app locale
    // instead of whatever the browser happens to report.
    language: getLanguage()
  });
}

async function handleInvoke(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname !== "/api/invoke" || req.method !== "POST") return false;
  if (!isAuthed(req)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }
  const body = (await readJsonBody(req)) as
    | { channel?: unknown; args?: unknown }
    | null;
  const channel = body?.channel;
  if (typeof channel !== "string" || !channel) {
    sendJson(res, 200, { ok: false, error: "invalid_request" });
    return true;
  }
  const args = Array.isArray(body?.args) ? body.args : [];
  const userId =
    sessionUserId(extractBearerToken(req.headers.authorization)) ||
    sessionUserId(readSessionCookie(req.headers.cookie));
  if (!userId) {
    // Running without an identity would skip ownership scoping and fall back to
    // the host home directory for path checks.
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }
  try {
    const result = await runAsCaller(userId, () =>
      localInvoke(channel, { userId }, ...args)
    );
    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      error: (error as Error)?.message || String(error)
    });
  }
  return true;
}

function callerUserIdFromRequest(req: IncomingMessage): string | null {
  return (
    sessionUserId(extractBearerToken(req.headers.authorization)) ||
    sessionUserId(readSessionCookie(req.headers.cookie))
  );
}

function callerUserIdFromMediaRequest(req: IncomingMessage): string | null {
  return sessionUserId(mediaAuthToken(req));
}

async function handleSessionCookie(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname !== "/api/session-cookie" || req.method !== "POST") {
    return false;
  }
  const token = extractBearerToken(req.headers.authorization);
  if (!token || !checkSession(token)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }
  // Re-hydrate the HttpOnly cookie for <img> requests after a localStorage restore.
  res.setHeader("Set-Cookie", buildSessionCookieHeader(token));
  sendJson(res, 200, { ok: true });
  return true;
}

function handleAttachment(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname !== "/api/attachment" || req.method !== "GET") return false;
  if (!isMediaAuthed(req)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }
  const filePath = url.searchParams.get("path");
  if (!filePath) {
    sendJson(res, 400, { ok: false, error: "missing_path" });
    return true;
  }
  const roots = remoteRootsForUser(callerUserIdFromMediaRequest(req));
  if (!canServeAttachmentPath(filePath, roots)) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return true;
  }
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600"
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { ok: false, error: "not_found" });
  }
  return true;
}

async function handleDraftRender(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/draft-render") || req.method !== "GET") {
    return false;
  }
  if (!isMediaAuthed(req)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }

  const suffix = url.pathname.slice("/api/draft-render".length) || "/";
  // Strip the media auth token before handing the URL to the draft renderer.
  const draftUrl = new URL(suffix + url.search, "http://127.0.0.1/");
  draftUrl.searchParams.delete("token");
  let root: string;
  let rel: string;
  try {
    const parsed = parseDraftUrl(draftUrl.toString());
    root = parsed.root;
    rel = parsed.rel;
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid_draft_path" });
    return true;
  }

  const roots = remoteRootsForUser(callerUserIdFromMediaRequest(req));
  const abs = path.resolve(root, rel);
  if (!isPathWithinRoots(root, roots) && !isPathWithinRoots(abs, roots)) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return true;
  }

  const response = await handleDraftRequest(
    new Request(draftUrl.toString(), { method: "GET" })
  );
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, {
    "Content-Type":
      response.headers.get("Content-Type") || "application/octet-stream",
    "Cache-Control": response.headers.get("Cache-Control") || "no-cache"
  });
  res.end(body);
  return true;
}

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname !== "/api/upload" || req.method !== "POST") return false;
  if (!isAuthed(req)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }
  const body = (await readJsonBody(req, 80 * 1024 * 1024)) as
    | { files?: unknown }
    | null;
  const files = Array.isArray(body?.files) ? body.files : [];
  const payloads: PrepareAttachmentPayload[] = [];
  for (const entry of files) {
    if (!entry || typeof entry !== "object") continue;
    const f = entry as { name?: unknown; mimeType?: unknown; data?: unknown };
    if (typeof f.data !== "string") continue;
    try {
      const buffer = Buffer.from(f.data, "base64");
      payloads.push({
        kind: "buffer",
        name: typeof f.name === "string" ? f.name : "file",
        mimeType:
          typeof f.mimeType === "string" ? f.mimeType : "application/octet-stream",
        size: buffer.length,
        data: buffer
      });
    } catch {
      // skip invalid entry
    }
  }
  try {
    const result = prepareAttachmentFiles(payloads);
    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      error: (error as Error)?.message || String(error)
    });
  }
  return true;
}

function handleListDirs(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname !== "/api/listDirs" || req.method !== "GET") return false;
  if (!isAuthed(req)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }
  const callerUserId =
    sessionUserId(extractBearerToken(req.headers.authorization)) ||
    sessionUserId(readSessionCookie(req.headers.cookie));
  const roots = remoteSourceRootsForUser(callerUserId);
  if (roots.length === 0) {
    sendJson(res, 200, {
      ok: true,
      result: { path: "", parent: null, roots: [], entries: [] }
    });
    return true;
  }
  const requested = url.searchParams.get("path");
  const target = path.resolve(requested || roots[0]!);
  if (!isPathWithinRoots(target, roots)) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return true;
  }
  try {
    if (!fs.statSync(target).isDirectory()) {
      sendJson(res, 400, { ok: false, error: "not_a_directory" });
      return true;
    }
    const entries: { name: string }[] = [];
    for (const dirent of fs.readdirSync(target, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
      entries.push({ name: dirent.name });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, {
      ok: true,
      result: {
        path: target,
        parent: parentWithinRoots(target, roots),
        roots,
        entries
      }
    });
  } catch {
    sendJson(res, 400, { ok: false, error: "read_failed" });
  }
  return true;
}

function proxyToDevServer(
  req: IncomingMessage,
  res: ServerResponse,
  devServerUrl: string
): void {
  let target: URL;
  try {
    target = new URL(devServerUrl);
  } catch {
    sendJson(res, 502, { ok: false, error: "invalid_dev_server_url" });
    return;
  }
  const proxyReq = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: target.host,
        "accept-encoding": "identity"
      }
    },
    (proxyRes) => {
      const contentType = String(proxyRes.headers["content-type"] || "");
      if (contentType.includes("text/html")) {
        let body = "";
        proxyRes.setEncoding("utf8");
        proxyRes.on("data", (chunk: string) => {
          body += chunk;
        });
        proxyRes.on("end", () => {
          const injected = body.includes("/web-preload.js")
            ? body
            : body.replace(
                "</head>",
                '<script src="/web-preload.js"></script></head>'
              );
          const headers = { ...proxyRes.headers };
          delete headers["content-length"];
          delete headers["content-encoding"];
          res.writeHead(proxyRes.statusCode || 200, headers);
          res.end(injected);
        });
      } else {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    }
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: "dev_server_unreachable" });
    }
  });
  req.pipe(proxyReq);
}

function proxyUpgradeToDevServer(
  req: IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  devServerUrl: string
): void {
  let target: URL;
  try {
    target = new URL(devServerUrl);
  } catch {
    socket.destroy();
    return;
  }
  const proxyReq = http.request({
    hostname: target.hostname,
    port: target.port,
    path: req.url,
    headers: { ...req.headers, host: target.host }
  });
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n"
    );
    if (proxyHead.length) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on("error", () => {
      try { socket.destroy(); } catch { /* ignore */ }
    });
    socket.on("error", () => {
      try { proxySocket.destroy(); } catch { /* ignore */ }
    });
  });
  proxyReq.on("error", () => socket.destroy());
  proxyReq.end();
}

type ChannelAudience =
  | { kind: "all" }
  | { kind: "user"; userId: string | null }
  | { kind: "none" };

function conversationAudience(conversationId: string): ChannelAudience {
  const conversation = getConversation(conversationId);
  if (!conversation) return { kind: "none" };
  // Rows created before per-user ownership existed belong to the desktop owner.
  return {
    kind: "user",
    userId: conversation.ownerId ?? getOwnerUser()?.id ?? null
  };
}

function resolveChannelAudience(
  classified: WsChannelClass,
  payload: unknown
): ChannelAudience {
  switch (classified.kind) {
    case "global":
      return { kind: "all" };
    case "session":
      return { kind: "user", userId: getSessionOwner(classified.sessionId) };
    case "conversation":
      return conversationAudience(classified.conversationId);
    case "conversationPayload": {
      const conversationId = conversationIdFromPayload(payload);
      return conversationId
        ? conversationAudience(conversationId)
        : { kind: "none" };
    }
    case "ownerPayload": {
      const owner = ownerFromPayload(payload);
      if (owner.kind === "signal") return { kind: "all" };
      return { kind: "user", userId: owner.ownerId ?? getOwnerUser()?.id ?? null };
    }
    default:
      return { kind: "none" };
  }
}

function setupWebSocket(server: http.Server, devServerUrl = ""): void {
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/ws") {
      wss?.handleUpgrade(req, socket, head, (ws) => {
        wss?.emit("connection", ws, req);
      });
      return;
    }
    if (devServerUrl) {
      proxyUpgradeToDevServer(req, socket, head, devServerUrl);
      return;
    }
    socket.destroy();
  });

  wss.on("connection", (ws: WebSocket) => {
    let authed = false;
    ws.on("message", (data: Buffer) => {
      if (authed) return;
      try {
        const msg = JSON.parse(data.toString()) as {
          type?: unknown;
          token?: unknown;
        };
        const token =
          msg.type === "auth"
            ? extractBearerToken(`Bearer ${msg.token}`)
            : null;
        const userId = token ? sessionUserId(token) : null;
        if (userId && token) {
          authed = true;
          authedClients.add(ws);
          clientUsers.set(ws, userId);
          clientTokenHashes.set(ws, hashSessionToken(token));
          ws.send(JSON.stringify({ type: "authed" }));
        } else {
          ws.close(1008);
        }
      } catch {
        ws.close(1008);
      }
    });
    ws.on("close", () => {
      authedClients.delete(ws);
      clientUsers.delete(ws);
      clientTokenHashes.delete(ws);
    });
    ws.on("error", () => {
      authedClients.delete(ws);
      clientUsers.delete(ws);
      clientTokenHashes.delete(ws);
    });
  });

  setSessionRevocationListener(dropRevokedSockets);

  setEventBroadcaster((channel: string, payload: unknown) => {
    if (authedClients.size === 0) return;
    const classified = classifyWsChannel(channel);
    if (classified.kind === "drop") return;
    const audience = resolveChannelAudience(classified, payload);
    if (audience.kind === "none") return;
    const message = JSON.stringify({ channel, payload });
    for (const client of authedClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (audience.kind === "user") {
        const owner = audience.userId;
        if (owner !== clientUsers.get(client)) continue;
      }
      try {
        client.send(message);
      } catch {
        authedClients.delete(client);
        clientUsers.delete(client);
      }
    }
  });
}

function getLanIp(): string {
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface && iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

/** `local` keeps the listener on the loopback interface, for reverse proxies. */
export type WebUIBindMode = "local" | "lan";

export interface WebUIServerOptions {
  allowRemote?: boolean;
  bindMode?: WebUIBindMode;
  distDir?: string;
  port?: number;
  devServerUrl?: string;
}

export interface WebUIStatus {
  running: boolean;
  enabled: boolean;
  bindMode: WebUIBindMode;
  port: number;
  /** The port the admin asked for, which differs after a bind conflict. */
  requestedPort: number;
  host: string;
  lanIp: string;
  accessUrl: string;
  hasPassword: boolean;
  /** True when the listener is reachable off-device over plain HTTP. */
  exposedOverPlainHttp: boolean;
}

export function getWebUIStatus(): WebUIStatus {
  const lanIp = getLanIp();
  const onLan = currentHost === "0.0.0.0";
  return {
    running: webuiServer !== null,
    enabled: currentAllowRemote,
    bindMode: onLan ? "lan" : "local",
    port: currentPort,
    requestedPort: requestedPort,
    host: currentHost,
    lanIp,
    accessUrl: `http://${onLan ? lanIp : "127.0.0.1"}:${currentPort}`,
    hasPassword: listUsers().length > 0,
    exposedOverPlainHttp: webuiServer !== null && onLan
  };
}

/** Token hashes of the clients currently holding an authenticated socket. */
export function getConnectedSessionHashes(): string[] {
  return [...clientTokenHashes.values()];
}

export function startWebUIServer(options: WebUIServerOptions = {}): Promise<void> {
  return new Promise((resolve) => {
    if (webuiServer) {
      resolve();
      return;
    }

    const allowRemote = options.allowRemote === true;
    const distDir = options.distDir ? path.resolve(options.distDir) : "";
    const devServerUrl = options.devServerUrl || "";
    // Loopback-only is the safe choice when the admin fronts the WebUI with a
    // TLS-terminating proxy, so remote access and LAN exposure are separate.
    const bindMode: WebUIBindMode = options.bindMode ?? "lan";
    const host = allowRemote && bindMode === "lan" ? "0.0.0.0" : "127.0.0.1";
    const basePort = normalizeWebUIPort(options.port);

    currentAllowRemote = allowRemote;
    currentHost = host;
    requestedPort = basePort;

    let port = basePort;
    const maxPort = basePort + 20;

    function tryListen(p: number): void {
      if (p > maxPort) {
        console.error("[FreeBuddy] WebUI Server: Could not bind to any port in range.");
        resolve();
        return;
      }

      const server = http.createServer((req, res) => {
        void (async () => {
          if (await handleLogin(req, res)) return;
          if (await handleLogout(req, res)) return;
          if (await handleSessionCookie(req, res)) return;

          const url = new URL(req.url || "/", "http://127.0.0.1");
          if (url.pathname === "/api/status" && req.method === "GET") {
            handleStatus(res);
            return;
          }

          if (await handleInvoke(req, res)) return;
          if (handleAttachment(req, res)) return;
          if (await handleDraftRender(req, res)) return;
          if (await handleUpload(req, res)) return;
          if (handleListDirs(req, res)) return;

          if (req.method === "GET" && !url.pathname.startsWith("/api")) {
            if (devServerUrl) {
              proxyToDevServer(req, res, devServerUrl);
              return;
            }
            if (distDir && serveStatic(res, distDir, url.pathname)) return;
          }

          sendJson(res, 404, { ok: false, error: "not_found" });
        })().catch((error) => {
          if (res.headersSent) return;
          sendJson(res, 500, { ok: false, error: (error as Error)?.message || String(error) });
        });
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          server.close();
          tryListen(p + 1);
        } else {
          console.error(`[FreeBuddy] WebUI Server error on port ${p}:`, err);
          resolve();
        }
      });

      server.listen(p, host, () => {
        webuiServer = server;
        currentPort = p;
        setupWebSocket(server, devServerUrl);
        console.log(
          `[FreeBuddy] WebUI Server listening on ${host}:${p}` +
            (allowRemote ? " (remote access enabled)" : "")
        );
        resolve();
      });
    }

    tryListen(port);
  });
}

export function stopWebUIServer(): Promise<void> {
  return new Promise((resolve) => {
    if (wss) {
      try {
        wss.close();
      } catch {
        // ignore
      }
      wss = null;
    }
    authedClients.clear();
    clientUsers.clear();
    clientTokenHashes.clear();
    setSessionRevocationListener(null);
    const server = webuiServer;
    webuiServer = null;
    if (server) {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      server.close(finish);
      setTimeout(finish, 1500);
    } else {
      resolve();
    }
  });
}

export async function restartWebUIServer(
  options: WebUIServerOptions
): Promise<WebUIStatus> {
  await stopWebUIServer();
  await startWebUIServer(options);
  return getWebUIStatus();
}
