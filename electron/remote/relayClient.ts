import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { MAX_FRAME_BYTES, REMOTE_PROTOCOL_VERSION, parseRemoteFrame, type ChallengeFrame, type HostAuthFrame, type RemoteFrame } from "@freebuddy/protocol/remote";

export type RelayClientState = "disabled" | "disconnected" | "connecting" | "authenticating" | "online" | "backoff" | "stopped" | "auth_failed";
export interface RelayClientStatus { state: RelayClientState; detail?: string; attempt: number; }
export interface RelayClientOptions {
  endpoint: string;
  enabled?: boolean;
  development?: { enabled: true; hostToken: string; hostId: string };
  /** Host ID loaded from the local safeStorage credential record. Required outside DEV mode. */
  trustedHostId?: string;
  onStatus?: (status: RelayClientStatus) => void;
  webSocketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  random?: () => number;
  now?: () => number;
  heartbeatTimeoutMs?: number;
  authTimeoutMs?: number;
  onChallenge?: (challenge: ChallengeFrame["payload"]) => HostAuthFrame;
  /** D4 consumes only already-authenticated protocol frames. */
  onFrame?: (frame: RemoteFrame) => void;
}

const MAX_QUEUE = 64;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_AUTH_TIMEOUT_MS = 60_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMESTAMP_RE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function isId(value: unknown): value is string { return typeof value === "string" && ID_RE.test(value); }
function isTimestamp(value: unknown): value is string { return typeof value === "string" && TIMESTAMP_RE.test(value); }
function isBoundedInteger(value: unknown, min: number, max: number): boolean { return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max; }

/** D3 consumes only relay-to-host frames. This closes the gaps intentionally left by parseRemoteFrame's shallow parser. */
function validateInboundFrame(frame: RemoteFrame): boolean {
  if (!isRecord(frame.payload)) return false;
  const payload: Record<string, unknown> = frame.payload;
  if (frame.type === "challenge") {
    return frame.hostId === undefined && hasOnlyKeys(payload, ["connectionId", "challenge", "issuedAt", "expiresAt"])
      && isId(payload.connectionId) && typeof payload.challenge === "string" && /^[A-Za-z0-9_-]{43,86}$/.test(payload.challenge)
      && isTimestamp(payload.issuedAt) && isTimestamp(payload.expiresAt);
  }
  if (frame.type === "auth.ok") {
    const limits = payload.limits;
    return (frame.hostId === undefined || frame.hostId === payload.hostId) && hasOnlyKeys(payload, ["connectionId", "role", "hostId", "serverTime", "limits"])
      && isId(payload.connectionId) && payload.role === "host" && isId(payload.hostId) && isTimestamp(payload.serverTime)
      && isRecord(limits) && hasOnlyKeys(limits, ["maxFrameBytes", "maxChunkBytes", "maxConcurrentRpcs", "rpcReadTimeoutMs", "rpcWriteTimeoutMs", "heartbeatIntervalMs", "challengeTtlMs"])
      && limits.maxFrameBytes === MAX_FRAME_BYTES && limits.maxChunkBytes === 32_768
      && isBoundedInteger(limits.maxConcurrentRpcs, 1, 64) && isBoundedInteger(limits.rpcReadTimeoutMs, 1_000, 60_000)
      && isBoundedInteger(limits.rpcWriteTimeoutMs, 1_000, 120_000) && isBoundedInteger(limits.heartbeatIntervalMs, 5_000, 120_000)
      && isBoundedInteger(limits.challengeTtlMs, 1_000, 300_000);
  }
  if (frame.type === "error") {
    return hasOnlyKeys(payload, ["code", "message", "retryable", "details"])
      && typeof payload.code === "string" && typeof payload.message === "string" && payload.message.length >= 1 && payload.message.length <= 512
      && typeof payload.retryable === "boolean";
  }
  if (frame.type === "ping") return hasOnlyKeys(payload, ["nonce"]) && (payload.nonce === undefined || (typeof payload.nonce === "string" && payload.nonce.length >= 1 && payload.nonce.length <= 64));
  if (frame.type === "pong") return hasOnlyKeys(payload, ["nonce", "serverTime"]) && isTimestamp(payload.serverTime) && (payload.nonce === undefined || (typeof payload.nonce === "string" && payload.nonce.length >= 1 && payload.nonce.length <= 64));
  if (frame.type === "server.draining") return hasOnlyKeys(payload, ["reason", "reconnectAfterMs"])
    && (payload.reason === "shutdown" || payload.reason === "restart" || payload.reason === "version") && isBoundedInteger(payload.reconnectAfterMs, 0, 600_000);
  // RPC params and resume cursors are contract-validated by AdminDispatcher.
  // Keep transport validation structural: it must never become a second schema.
  if (frame.type === "rpc.request") return typeof frame.hostId === "string" && hasOnlyKeys(payload, ["method", "params"])
    && typeof payload.method === "string" && isRecord(payload.params);
  if (frame.type === "resume") return typeof frame.hostId === "string" && hasOnlyKeys(payload, ["resumeFrom"])
    && isBoundedInteger(payload.resumeFrom, 0, Number.MAX_SAFE_INTEGER);
  return false;
}

export function calculateReconnectDelay(attempt: number, random = Math.random): number {
  const cap = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 6));
  return Math.floor(cap / 2 + random() * cap / 2);
}

export function validateRelayEndpoint(endpoint: string, development = false): URL {
  const url = new URL(endpoint);
  if (url.username || url.password) throw new Error("Relay endpoint must not include URL userinfo");
  const literalLoopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (development) {
    if (url.protocol === "ws:" && literalLoopback) return url;
    throw new Error("development relay endpoint must use ws with an explicit literal-loopback address");
  }
  if (url.protocol === "wss:") return url;
  throw new Error("Relay endpoint must use wss; ws is allowed only for explicit literal-loopback development")
}

export class RelayClient {
  private socket: WebSocket | undefined;
  private state: RelayClientState = "disabled";
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatDeadline: NodeJS.Timeout | undefined;
  private authTimer: NodeJS.Timeout | undefined;
  private queue: string[] = [];
  private stopped = false;
  private authenticated = false;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: RelayClientOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }
  getStatus(): RelayClientStatus { return { state: this.state, attempt: this.attempt }; }
  start(): void {
    if (!this.options.enabled) return this.transition("disabled");
    this.stopped = false;
    this.transition("disconnected");
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.queue = [];
    this.socket?.close();
    this.socket = undefined;
    this.transition("stopped");
  }
  send(frame: RemoteFrame): boolean {
    if (!this.authenticated || this.state !== "online") return false;
    const serialized = JSON.stringify(frame);
    if (Buffer.byteLength(serialized) > MAX_FRAME_BYTES) return false;
    if (this.queue.length >= MAX_QUEUE) return false;
    if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(serialized); return true; }
    this.queue.push(serialized); return true;
  }
  private connect(): void {
    if (this.stopped) return;
    let endpoint: URL;
    try { endpoint = validateRelayEndpoint(this.options.endpoint, !!this.options.development?.enabled); }
    catch (error) { this.transition("auth_failed", error instanceof Error ? error.message : "invalid endpoint"); return; }
    const dev = this.options.development;
    if (endpoint.protocol === "ws:" && (!dev?.enabled || !dev.hostToken || !dev.hostId)) {
      this.transition("auth_failed", "loopback development requires an explicit host token and host ID"); return;
    }
    if (!dev?.enabled && !this.options.trustedHostId) {
      this.transition("auth_failed", "production relay requires a trusted local host ID"); return;
    }
    this.transition("connecting");
    const headers = dev ? { Authorization: `Bearer ${dev.hostToken}`, "X-Host-Id": dev.hostId } : undefined;
    const factory = this.options.webSocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
    const socket = factory(endpoint.toString(), { headers, maxPayload: MAX_FRAME_BYTES, rejectUnauthorized: true, followRedirects: false });
    this.socket = socket;
    socket.once("open", () => { this.transition("authenticating"); this.startAuthTimeout(); });
    socket.on("message", data => this.onMessage(data));
    socket.once("error", () => undefined);
    socket.once("close", (_code, reason) => this.onClose(reason.toString()));
  }
  private onMessage(data: WebSocket.RawData): void {
    const text = data.toString();
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) { this.rejectInbound("relay frame exceeds maximum size"); return; }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { this.rejectInbound("invalid relay frame"); return; }
    const parsed = parseRemoteFrame(raw);
    if (!parsed.ok) { this.rejectInbound(parsed.error.code === "unsupported_version" ? "unsupported relay protocol version" : "invalid relay frame"); return; }
    const frame = parsed.value;
    if (!validateInboundFrame(frame)) { this.rejectInbound("invalid relay frame"); return; }
    if (frame.hostId !== undefined && frame.hostId !== this.expectedHostId()) { this.rejectInbound("relay host identity changed"); return; }
    if (!this.authenticated && !["challenge", "auth.ok", "error"].includes(frame.type)) { this.rejectInbound("relay sent traffic before authentication"); return; }
    if (frame.type === "error" && (frame.payload.code === "unauthorized" || frame.payload.code === "forbidden" || frame.payload.code === "unsupported_version")) {
      this.rejectInbound(frame.payload.code); return;
    }
    if (frame.type === "auth.ok") {
      if (this.authenticated) { this.rejectInbound("duplicate relay authentication result"); return; }
      if (frame.payload.role !== "host" || frame.payload.hostId !== this.expectedHostId()) { this.rejectInbound("relay authenticated an unexpected host"); return; }
      this.authenticated = true; this.clearAuthTimeout(); this.attempt = 0; this.transition("online"); this.flush(); this.startHeartbeat(frame.payload.limits.heartbeatIntervalMs); return;
    }
    if (frame.type === "challenge") {
      if (this.authenticated || !this.options.onChallenge) { this.rejectInbound("unexpected relay challenge"); return; }
      try { this.sendAuthentication(this.options.onChallenge(frame.payload)); }
      catch { this.rejectInbound("host challenge signing failed"); }
      return;
    }
    if (frame.type === "ping") this.send({ v: REMOTE_PROTOCOL_VERSION, type: "pong", id: `msg_${randomBytes(12).toString("base64url")}`, sentAt: new Date(this.now()).toISOString(), payload: { nonce: frame.payload.nonce, serverTime: new Date(this.now()).toISOString() } });
    if (frame.type === "pong") this.clearHeartbeatDeadline();
    if (frame.type === "server.draining") { this.socket?.close(); }
    if (frame.type === "rpc.request" || frame.type === "resume") {
      try { this.options.onFrame?.(frame); } catch { this.rejectInbound("remote frame handler failed"); }
    }
  }
  private onClose(reason: string): void {
    this.clearHeartbeatTimers(); this.clearAuthTimeout(); this.socket = undefined;
    if (this.stopped || this.state === "auth_failed") return;
    this.authenticated = false; this.scheduleBackoff(reason || "connection closed");
  }
  private scheduleBackoff(detail: string): void {
    this.attempt += 1; this.transition("backoff", detail);
    const delay = calculateReconnectDelay(this.attempt, this.random);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
  private startHeartbeat(interval: number): void {
    this.clearHeartbeatTimers();
    const safeInterval = Math.max(1_000, Math.min(interval || 30_000, 60_000));
    this.heartbeatTimer = setInterval(() => {
      this.send({ v: REMOTE_PROTOCOL_VERSION, type: "ping", id: `msg_${randomBytes(12).toString("base64url")}`, sentAt: new Date(this.now()).toISOString(), payload: { nonce: randomBytes(12).toString("base64url") } });
      this.clearHeartbeatDeadline();
      this.heartbeatDeadline = setTimeout(() => this.socket?.close(), this.options.heartbeatTimeoutMs ?? 10_000);
    }, safeInterval);
  }
  private expectedHostId(): string | undefined { return this.options.development?.hostId ?? this.options.trustedHostId; }
  private sendAuthentication(frame: HostAuthFrame): void {
    if (frame.hostId !== this.expectedHostId() && this.expectedHostId() !== undefined) throw new Error("host credential identity mismatch");
    const parsed = parseRemoteFrame(frame);
    if (!parsed.ok || frame.type !== "host.auth" || frame.payload.hostId !== frame.hostId) throw new Error("invalid host authentication frame");
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("relay socket is not open");
    this.socket.send(JSON.stringify(frame));
  }
  private flush(): void { while (this.queue.length && this.socket?.readyState === WebSocket.OPEN && this.authenticated) this.socket.send(this.queue.shift()!); }
  private startAuthTimeout(): void { this.clearAuthTimeout(); this.authTimer = setTimeout(() => this.rejectInbound("relay authentication timed out"), this.options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS); }
  private clearAuthTimeout(): void { if (this.authTimer) clearTimeout(this.authTimer); this.authTimer = undefined; }
  private rejectInbound(detail: string): void { this.authenticated = false; this.clearAuthTimeout(); this.clearHeartbeatTimers(); this.queue = []; this.transition("auth_failed", detail); this.socket?.close(); }
  private clearHeartbeatDeadline(): void { if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline); this.heartbeatDeadline = undefined; }
  private clearHeartbeatTimers(): void { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; this.clearHeartbeatDeadline(); }
  private clearTimers(): void { if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.clearHeartbeatTimers(); this.clearAuthTimeout(); }
  private transition(state: RelayClientState, detail?: string): void { this.state = state; this.options.onStatus?.({ state, detail, attempt: this.attempt }); }
}
