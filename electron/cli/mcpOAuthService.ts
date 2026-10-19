import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  auth, discoverOAuthServerInfo, extractWWWAuthenticateParams,
  refreshAuthorization, selectResourceURL,
  type OAuthClientProvider, type OAuthDiscoveryState
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const MAX_OAUTH_RESPONSE_BYTES = 1024 * 1024;

export interface McpOAuthServer {
  id: string;
  url: string;
  clientId?: string;
  scope?: string;
}

export interface McpOAuthStatus {
  state: "disconnected" | "authorizing" | "connected" | "error";
  error?: string;
  expiresAt?: number;
}

/** Store this entire record encrypted; it contains credentials and discovery bindings. */
export interface McpOAuthStoredState {
  version: 1;
  serverUrl: string;
  configuredClientId?: string;
  configuredScope?: string;
  issuer: string;
  discovery: OAuthDiscoveryState;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
}

export interface McpOAuthServiceOptions {
  read(id: string): McpOAuthStoredState | undefined;
  write(id: string, record: McpOAuthStoredState | undefined): void;
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

class OAuthServiceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function required(): OAuthServiceError {
  return new OAuthServiceError("oauth_required", "Connect this MCP server with OAuth to continue.");
}

function refreshFailed(): OAuthServiceError {
  return new OAuthServiceError("oauth_refresh_failed", "MCP OAuth token refresh failed temporarily. Please try again.");
}

function safeError(error?: unknown): OAuthServiceError {
  return error instanceof OAuthServiceError
    ? error : new OAuthServiceError("oauth_failed", "MCP OAuth authorization failed. Please try again.");
}

function checkedUrl(value: string, issuer = false): URL {
  try {
    const url = new URL(value);
    if (
      url.username || url.password || url.hash || (issuer && url.search) ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
    ) throw new Error();
    return url;
  } catch {
    throw new OAuthServiceError("oauth_invalid_config", "MCP OAuth requires HTTPS or a local loopback HTTP server.");
  }
}

function normalized(server: McpOAuthServer): McpOAuthServer {
  return {
    id: server.id, url: checkedUrl(server.url).href,
    clientId: server.clientId?.trim() || undefined,
    scope: server.scope?.trim() || undefined
  };
}

function binding(server: McpOAuthServer): string {
  return JSON.stringify([server.url, server.clientId ?? "", server.scope ?? ""]);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason instanceof OAuthServiceError
      ? signal.reason : new OAuthServiceError("oauth_cancelled", "MCP OAuth authorization was cancelled."));
    if (signal.aborted) { void promise.catch(() => {}); aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function boundedResponseBody(response: Response, signal: AbortSignal): Promise<ArrayBuffer> {
  const tooLarge = () => new OAuthServiceError("oauth_failed", "MCP OAuth response exceeded the size limit.");
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_OAUTH_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > MAX_OAUTH_RESPONSE_BYTES) throw tooLarge();
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body.buffer;
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

interface Session {
  binding: string;
  controllers: Set<AbortController>;
  authorization?: Promise<McpOAuthStatus>;
  refresh?: Promise<string>;
  error?: string;
  refreshedRejectedToken?: string;
}

export class McpOAuthService {
  private readonly sessions = new Map<string, Session>();
  private readonly networkFetch: typeof fetch;
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly options: McpOAuthServiceOptions) {
    this.networkFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private session(server: McpOAuthServer): Session {
    const key = binding(server);
    const previous = this.sessions.get(server.id);
    if (previous?.binding === key) return previous;
    if (previous) {
      this.cancel(previous);
      this.options.write(server.id, undefined);
    }
    const session: Session = { binding: key, controllers: new Set() };
    this.sessions.set(server.id, session);
    return session;
  }

  private current(server: McpOAuthServer, session: Session): void {
    if (this.disposed || this.sessions.get(server.id) !== session) {
      throw new OAuthServiceError("oauth_cancelled", "MCP OAuth authorization was cancelled.");
    }
  }

  private cancel(session: Session): void {
    for (const controller of session.controllers) controller.abort();
  }

  private load(server: McpOAuthServer): McpOAuthStoredState | undefined {
    const record = this.options.read(server.id);
    if (!record) return undefined;
    try {
      if (
        record.version !== 1 || record.serverUrl !== server.url ||
        record.configuredClientId !== server.clientId || record.configuredScope !== server.scope ||
        record.issuer !== record.discovery.authorizationServerUrl
      ) throw new Error();
      this.validateDiscovery(record.discovery);
      return structuredClone(record);
    } catch {
      this.options.write(server.id, undefined);
      return undefined;
    }
  }

  private validateDiscovery(discovery: OAuthDiscoveryState): void {
    checkedUrl(discovery.authorizationServerUrl, true);
    const metadata = discovery.authorizationServerMetadata;
    if (!metadata || metadata.issuer !== discovery.authorizationServerUrl) {
      throw new OAuthServiceError("oauth_failed", "MCP OAuth authorization server metadata is invalid.");
    }
    checkedUrl(metadata.issuer, true);
    checkedUrl(metadata.authorization_endpoint);
    checkedUrl(metadata.token_endpoint);
    if (metadata.registration_endpoint) checkedUrl(metadata.registration_endpoint);
    if (discovery.resourceMetadataUrl) checkedUrl(discovery.resourceMetadataUrl);
    for (const issuer of discovery.resourceMetadata?.authorization_servers ?? []) checkedUrl(issuer, true);
    if (
      !metadata.response_types_supported.includes("code") ||
      (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256"))
    ) throw new OAuthServiceError("oauth_failed", "MCP OAuth requires authorization code and PKCE S256 support.");
  }

  status(input: McpOAuthServer): McpOAuthStatus {
    try {
      const server = normalized(input);
      const session = this.session(server);
      const record = this.load(server);
      if (this.disposed) return { state: "disconnected" };
      if (session.authorization) return { state: "authorizing" };
      if (session.error) return { state: "error", error: session.error };
      if (record?.tokens?.access_token && (
        record.expiresAt === undefined || record.expiresAt > this.now() || record.tokens.refresh_token
      )) return { state: "connected", expiresAt: record.expiresAt };
      return { state: "disconnected" };
    } catch (error) {
      return { state: "error", error: safeError(error).message };
    }
  }

  private controller(session: Session, timeoutMs: number): { controller: AbortController; cleanup(): void } {
    const controller = new AbortController();
    session.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(
      new OAuthServiceError("oauth_timeout", "MCP OAuth authorization timed out. Please try again.")
    ), timeoutMs);
    return { controller, cleanup() { clearTimeout(timeout); session.controllers.delete(controller); } };
  }

  private sdkFetch(signal: AbortSignal, allowedPosts: Set<string>): FetchLike {
    return async (input, init) => {
      const target = checkedUrl(String(input));
      if ((init?.method ?? "GET").toUpperCase() !== "GET" && !allowedPosts.has(target.href)) {
        throw new OAuthServiceError("oauth_failed", "MCP OAuth endpoint was not declared by its authorization server.");
      }
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.options.timeoutMs ?? 15_000, 15_000)));
      const combined = AbortSignal.any([signal, timeout, ...(init?.signal ? [init.signal] : [])]);
      const response = await raceAbort(this.networkFetch(target, {
        ...init, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: combined
      }), combined);
      if (response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw new OAuthServiceError("oauth_failed", "MCP OAuth redirects are not allowed for credential requests.");
      }
      // Include finite JSON body consumption in the timeout and cap decoded
      // bytes even when Content-Length is absent or describes compressed data.
      const body = await boundedResponseBody(response, combined);
      return new Response([204, 205, 304].includes(response.status) ? null : body, {
        status: response.status, statusText: response.statusText, headers: response.headers
      });
    };
  }

  private async discover(server: McpOAuthServer, signal: AbortSignal): Promise<{
    discovery: OAuthDiscoveryState; scope?: string;
  }> {
    const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(this.options.timeoutMs ?? 15_000, 15_000)))]);
    const response = await raceAbort(this.networkFetch(server.url, {
      method: "GET", headers: { Accept: "application/json, text/event-stream" },
      redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: probeSignal
    }), probeSignal);
    const challenge = response.status === 401 ? extractWWWAuthenticateParams(response) : {};
    void response.body?.cancel().catch(() => {});
    if (response.redirected) throw new OAuthServiceError("oauth_failed", "MCP OAuth discovery redirects are not allowed.");
    if (challenge.resourceMetadataUrl) checkedUrl(challenge.resourceMetadataUrl.href);
    const discovered = await discoverOAuthServerInfo(server.url, {
      resourceMetadataUrl: challenge.resourceMetadataUrl,
      fetchFn: this.sdkFetch(signal, new Set())
    });
    const discovery: OAuthDiscoveryState = {
      ...discovered,
      resourceMetadataUrl: challenge.resourceMetadataUrl?.href,
      resourceMetadata: discovered.resourceMetadata ? { ...discovered.resourceMetadata } : { resource: server.url }
    };
    this.validateDiscovery(discovery);
    // The SDK otherwise treats scopes_supported as a request for every scope.
    // Retain discovery/resource validation while requesting only explicit scope.
    if (discovery.resourceMetadata) delete discovery.resourceMetadata.scopes_supported;
    return { discovery, scope: server.scope ?? challenge.scope };
  }

  authorize(input: McpOAuthServer): Promise<McpOAuthStatus> {
    let server: McpOAuthServer;
    let session: Session;
    try {
      server = normalized(input);
      session = this.session(server);
      this.current(server, session);
      if (session.authorization) return session.authorization;
      // A refresh using the previous grant must not overwrite a newly completed
      // browser grant. Replacing the session also invalidates its pending writes.
      if (session.refresh) {
        this.cancel(session);
        session = { binding: binding(server), controllers: new Set() };
        this.sessions.set(server.id, session);
      }
    } catch (error) {
      return Promise.resolve({ state: "error", error: safeError(error).message });
    }
    const running = this.authorizeSession(server, session);
    session.authorization = running;
    void running.finally(() => { if (session.authorization === running) session.authorization = undefined; }).catch(() => {});
    return running;
  }

  private async authorizeSession(server: McpOAuthServer, session: Session): Promise<McpOAuthStatus> {
    const { controller, cleanup } = this.controller(session, this.options.timeoutMs ?? 10 * 60_000);
    const signal = controller.signal;
    let listener: http.Server | undefined;
    let verifier: string | undefined;
    let callbackTaken = false;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const callbackCode = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    void callbackCode.catch(() => {});
    const onAbort = () => rejectCode(signal.reason instanceof OAuthServiceError
      ? signal.reason : new OAuthServiceError("oauth_cancelled", "MCP OAuth authorization was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    session.error = undefined;
    try {
      const { discovery, scope } = await this.discover(server, signal);
      this.current(server, session);
      const metadata = discovery.authorizationServerMetadata!;
      const state = randomBytes(32).toString("base64url");
      const callbackPath = "/freebuddy/mcp/oauth/callback";
      let callbackAuthority = "";
      listener = http.createServer((request, response) => {
        const reply = (status: number, message: string) => {
          response.writeHead(status, {
            "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'", "Referrer-Policy": "no-referrer"
          });
          response.end(message);
        };
        let callback: URL;
        try { callback = new URL(request.url ?? "", "http://127.0.0.1"); }
        catch { reply(400, "Invalid OAuth callback."); return; }
        if (request.headers.host !== callbackAuthority) {
          reply(400, "Invalid OAuth callback."); return;
        }
        if (request.method !== "GET" || callback.pathname !== callbackPath) {
          reply(404, "Not found."); return;
        }
        const supplied = callback.searchParams.get("state") ?? "";
        if (
          callbackTaken || callback.searchParams.getAll("state").length !== 1 ||
          Buffer.byteLength(supplied) !== Buffer.byteLength(state) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(state))
        ) { reply(400, "Invalid OAuth callback."); return; }
        const issuer = callback.searchParams.get("iss");
        if (
          callback.searchParams.getAll("iss").length > 1 ||
          ((issuer !== null || (metadata as { authorization_response_iss_parameter_supported?: boolean }).authorization_response_iss_parameter_supported === true) && issuer !== discovery.authorizationServerUrl)
        ) {
          callbackTaken = true;
          reply(400, "OAuth authorization could not be completed.");
          rejectCode(new OAuthServiceError("oauth_failed", "MCP OAuth authorization server did not match."));
          return;
        }
        if (callback.searchParams.has("error")) {
          callbackTaken = true;
          reply(400, "OAuth authorization could not be completed.");
          rejectCode(new OAuthServiceError("oauth_failed", "MCP OAuth authorization was not approved."));
          return;
        }
        const code = callback.searchParams.get("code");
        if (!code || callback.searchParams.getAll("code").length !== 1) {
          reply(400, "Invalid OAuth callback."); return;
        }
        callbackTaken = true;
        reply(200, "Authorization received. Return to FreeBuddy.");
        resolveCode(code);
      });
      await raceAbort(new Promise<void>((resolve, reject) => {
        listener!.once("error", reject);
        listener!.listen({ host: "127.0.0.1", port: 0 }, resolve);
      }), signal);
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error();
      callbackAuthority = `127.0.0.1:${address.port}`;
      const redirectUrl = `http://127.0.0.1:${address.port}${callbackPath}`;
      const record: McpOAuthStoredState = {
        version: 1, serverUrl: server.url, configuredClientId: server.clientId,
        configuredScope: server.scope, issuer: discovery.authorizationServerUrl, discovery,
        clientInformation: server.clientId ? { client_id: server.clientId } : undefined
      };
      if (!server.clientId && !metadata.registration_endpoint) {
        throw new OAuthServiceError("oauth_failed", "This MCP OAuth server requires a pre-registered client ID.");
      }
      const allowedPosts = new Set([metadata.token_endpoint, ...(metadata.registration_endpoint ? [metadata.registration_endpoint] : [])].map((value) => checkedUrl(value).href));
      const provider: OAuthClientProvider = {
        redirectUrl,
        clientMetadata: {
          redirect_uris: [redirectUrl], token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
          client_name: "FreeBuddy", ...(scope ? { scope } : {})
        },
        state: () => state,
        clientInformation: () => record.clientInformation,
        saveClientInformation: (information) => { this.current(server, session); record.clientInformation = information; },
        tokens: () => undefined,
        saveTokens: (tokens) => {
          this.current(server, session);
          if (signal.aborted) throw new Error();
          if (tokens.token_type.toLowerCase() !== "bearer") throw new Error();
          record.tokens = tokens;
          record.expiresAt = tokens.expires_in === undefined ? undefined : this.now() + tokens.expires_in * 1000;
          this.options.write(server.id, structuredClone(record));
        },
        redirectToAuthorization: async (url) => {
          this.current(server, session);
          checkedUrl(url.href);
          if (url.origin !== new URL(metadata.authorization_endpoint).origin || url.pathname !== new URL(metadata.authorization_endpoint).pathname) throw new Error();
          await raceAbort(this.options.openExternal(url.href), signal);
        },
        saveCodeVerifier: (value) => { verifier = value; },
        codeVerifier: () => { if (!verifier) throw new Error(); return verifier; },
        discoveryState: () => discovery,
        invalidateCredentials: (scope) => {
          if (scope === "all" || scope === "client") record.clientInformation = server.clientId ? { client_id: server.clientId } : undefined;
          if (scope === "all" || scope === "verifier") verifier = undefined;
        }
      };
      const fetchFn = this.sdkFetch(signal, allowedPosts);
      await raceAbort(auth(provider, { serverUrl: server.url, scope, fetchFn }), signal);
      const code = await raceAbort(callbackCode, signal);
      await raceAbort(auth(provider, { serverUrl: server.url, authorizationCode: code, scope, fetchFn }), signal);
      this.current(server, session);
      session.error = undefined;
      return { state: "connected", expiresAt: record.expiresAt };
    } catch (error) {
      if (this.sessions.get(server.id) !== session || this.disposed || (signal.aborted && !(signal.reason instanceof OAuthServiceError))) {
        return { state: "disconnected" };
      }
      session.error = safeError(error).message;
      return { state: "error", error: session.error };
    } finally {
      cleanup();
      signal.removeEventListener("abort", onAbort);
      controller.abort();
      verifier = undefined;
      if (listener) {
        await new Promise<void>((resolve) => {
          listener!.close(() => resolve());
          listener!.closeAllConnections();
        });
      }
    }
  }

  async accessToken(input: McpOAuthServer, forceRefresh = false, rejectedToken?: string): Promise<string> {
    const server = normalized(input);
    const session = this.session(server);
    this.current(server, session);
    if (session.authorization) throw required();
    const record = this.load(server);
    if (!record?.tokens?.access_token) throw required();
    const fresh = record.expiresAt === undefined || record.expiresAt > this.now() + 30_000;
    // Another broker request may already have replaced the rejected token.
    if (fresh && (!forceRefresh || (rejectedToken !== undefined && (
      record.tokens.access_token !== rejectedToken || session.refreshedRejectedToken === rejectedToken
    )))) return record.tokens.access_token;
    if (session.refresh) return session.refresh;
    if (!record.tokens.refresh_token || !record.clientInformation) throw required();
    const running = this.refreshSession(server, session, record, rejectedToken);
    session.refresh = running;
    try { return await running; }
    finally { if (session.refresh === running) session.refresh = undefined; }
  }

  private async refreshSession(server: McpOAuthServer, session: Session, record: McpOAuthStoredState, rejectedToken?: string): Promise<string> {
    const { controller, cleanup } = this.controller(session, Math.min(this.options.timeoutMs ?? 15_000, 15_000));
    try {
      const metadata = record.discovery.authorizationServerMetadata!;
      const provider = {} as OAuthClientProvider;
      const resource = await selectResourceURL(server.url, provider, record.discovery.resourceMetadata);
      const sdkFetch = this.sdkFetch(controller.signal, new Set([checkedUrl(metadata.token_endpoint).href]));
      const tokens = await raceAbort(refreshAuthorization(record.issuer, {
        metadata, clientInformation: record.clientInformation!, refreshToken: record.tokens!.refresh_token!,
        resource: resource && record.discovery.resourceMetadata ? record.discovery.resourceMetadata.resource : resource,
        fetchFn: async (input, init) => {
          const response = await sdkFetch(input, init);
          // A server outage must not invalidate a grant, even if an upstream
          // proxy incorrectly sends an OAuth grant error in its 5xx body.
          if (response.status >= 500) {
            void response.body?.cancel().catch(() => {});
            throw refreshFailed();
          }
          return response;
        }
      }), controller.signal);
      this.current(server, session);
      if (controller.signal.aborted || tokens.token_type.toLowerCase() !== "bearer") throw required();
      record.tokens = tokens;
      record.expiresAt = tokens.expires_in === undefined ? undefined : this.now() + tokens.expires_in * 1000;
      this.options.write(server.id, record);
      session.error = undefined;
      session.refreshedRejectedToken = rejectedToken;
      return tokens.access_token;
    } catch (error) {
      // Refresh must never fall back to opening a browser or reveal OAuth bodies.
      if (this.sessions.get(server.id) !== session || this.disposed) throw required();
      if (error instanceof InvalidGrantError || error instanceof InvalidClientError || error instanceof UnauthorizedClientError) {
        this.options.write(server.id, undefined);
        session.error = required().message;
        throw required();
      }
      // Network failures, timeouts and temporarily unavailable endpoints leave
      // the last grant intact so a later request can retry without a browser.
      throw refreshFailed();
    } finally { cleanup(); controller.abort(); }
  }

  async disconnect(input: McpOAuthServer): Promise<McpOAuthStatus> {
    const server = normalized(input);
    const previous = this.session(server);
    this.sessions.set(server.id, { binding: binding(server), controllers: new Set() });
    this.options.write(server.id, undefined);
    this.cancel(previous);
    await Promise.allSettled([previous.authorization, previous.refresh].filter((value) => value !== undefined));
    return { state: "disconnected" };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const pending: Promise<unknown>[] = [];
    for (const session of this.sessions.values()) {
      this.cancel(session);
      if (session.authorization) pending.push(session.authorization);
      if (session.refresh) pending.push(session.refresh);
    }
    await Promise.allSettled(pending);
    this.sessions.clear();
  }
}
