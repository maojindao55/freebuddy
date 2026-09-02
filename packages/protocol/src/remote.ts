export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 262_144;
export const MAX_CHUNK_BYTES = 32_768;
export const DEFAULT_READ_TIMEOUT_MS = 15_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 30_000;
export const CHALLENGE_TTL_MS = 60_000;
export const HOST_AUTH_CANONICAL_PREFIX = "freebuddy-remote-host-auth-v1";
export const PAIRING_START_CANONICAL_PREFIX = "freebuddy-remote-pairing-start-v1";
export const PAIRING_TTL_MS = 300_000;
export const PAIRING_SECRET_MIN_BYTES = 32;
export const HTTP_SCHEMA_ID = "https://freebuddy.dev/protocol/remote/v1/http.schema.json";
export const REMOTE_PROTOCOL_ID = "https://freebuddy.dev/protocol/remote/v1";

export const REMOTE_FRAME_TYPES = [
  "challenge",
  "host.auth",
  "admin.auth",
  "auth.ok",
  "error",
  "rpc.request",
  "rpc.response",
  "event",
  "resume",
  "snapshot",
  "ping",
  "pong",
  "server.draining"
] as const;

export type RemoteFrameType = (typeof REMOTE_FRAME_TYPES)[number];

export const REMOTE_ERROR_CODES = [
  "invalid_request",
  "unsupported_version",
  "unauthorized",
  "forbidden",
  "host_offline",
  "method_not_allowed",
  "request_expired",
  "duplicate_request",
  "rpc_timeout",
  "backpressure",
  "conflict",
  "not_found",
  "internal_error"
] as const;

export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number];

export const FORBIDDEN_REMOTE_METHODS = [
  "ipc.invoke",
  "shell.exec",
  "fs.read",
  "fs.write",
  "process.spawn"
] as const;

export const READ_REMOTE_METHODS = [
  "host.status",
  "sync.snapshot",
  "project.list",
  "agent.list",
  "conversation.list",
  "conversation.get",
  "message.list",
  "task.list",
  "task.readLog",
  "workflow.list",
  "workflow.get",
  "delegation.list",
  "delegation.get"
] as const;

export const WRITE_REMOTE_METHODS = [
  "conversation.create",
  "conversation.rename",
  "conversation.archive",
  "conversation.delete",
  "conversation.send",
  "run.stop",
  "permission.respond",
  "authentication.respond",
  "workflow.start",
  "workflow.stop",
  "delegation.start",
  "delegation.stop",
  "terminal.create",
  "terminal.input",
  "terminal.resize",
  "terminal.snapshot",
  "terminal.close"
] as const;

export const REMOTE_METHODS = [...READ_REMOTE_METHODS, ...WRITE_REMOTE_METHODS] as const;

export type ReadRemoteMethod = (typeof READ_REMOTE_METHODS)[number];
export type WriteRemoteMethod = (typeof WRITE_REMOTE_METHODS)[number];
export type RemoteMethod = (typeof REMOTE_METHODS)[number];

export const REMOTE_EVENT_NAMES = [
  "host.status.changed",
  "conversation.created",
  "conversation.updated",
  "conversation.deleted",
  "message.created",
  "message.updated",
  "run.started",
  "run.stream",
  "run.finished",
  "run.failed",
  "run.stopped",
  "permission.requested",
  "permission.resolved",
  "authentication.requested",
  "authentication.resolved",
  "task.updated",
  "task.log.appended",
  "workflow.updated",
  "delegation.updated",
  "terminal.opened",
  "terminal.output",
  "terminal.closed"
] as const;

export type RemoteEventName = (typeof REMOTE_EVENT_NAMES)[number];

export type RemoteId = string;
export type RemoteTimestamp = string;
export type RemoteSeq = number;

export interface RemoteStructuredError {
  code: RemoteErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null>;
}

export interface RemoteMeta {
  [key: string]: string | number | boolean | null;
}

export interface RemotePageParams {
  cursor?: string;
  limit?: number;
}

export interface RemotePageResult<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ProjectSummary {
  projectId: RemoteId;
  name: string;
  updatedAt: RemoteTimestamp;
}

export interface AgentSummary {
  agentId: RemoteId;
  name: string;
  kind?: string;
  available: boolean;
}

export interface ConversationSummary {
  conversationId: RemoteId;
  projectId?: RemoteId;
  title: string;
  archived: boolean;
  updatedAt: RemoteTimestamp;
  lastMessageAt?: RemoteTimestamp;
}

export interface MessageSummary {
  messageId: RemoteId;
  conversationId: RemoteId;
  role: "user" | "assistant" | "system";
  content: string;
  truncated?: boolean;
  createdAt: RemoteTimestamp;
  runId?: RemoteId;
}

export interface TaskSummary {
  taskId: RemoteId;
  title: string;
  status: "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  projectId?: RemoteId;
  conversationId?: RemoteId;
  updatedAt: RemoteTimestamp;
}

export interface TaskLogItem {
  seq: RemoteSeq;
  text: string;
  createdAt: RemoteTimestamp;
}

export interface RunSummary {
  runId: RemoteId;
  conversationId: RemoteId;
  agentId?: RemoteId;
  status: "running" | "finished" | "failed" | "stopped";
  startedAt?: RemoteTimestamp;
}

export interface DecisionSummary {
  decisionId: RemoteId;
  kind: "permission" | "authentication";
  runId: RemoteId;
  conversationId: RemoteId;
  summary: string;
  tool?: string;
}

export interface WorkflowSummary {
  workflowId: RemoteId;
  name: string;
  status: "idle" | "running" | "paused" | "blocked" | "completed" | "failed" | "stopped";
  updatedAt: RemoteTimestamp;
}

export interface DelegationSummary {
  delegationId: RemoteId;
  teamId?: RemoteId;
  name: string;
  status: "idle" | "running" | "blocked" | "completed" | "failed" | "stopped";
  updatedAt: RemoteTimestamp;
}

export interface TerminalSummary {
  terminalId: RemoteId;
  projectId: RemoteId;
  cols: number;
  rows: number;
  createdAt?: RemoteTimestamp;
}

export interface HostStatus {
  hostId: RemoteId;
  displayName?: string;
  online: boolean;
  appVersion: string;
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  remoteEnabled: boolean;
  activeRunCount: number;
  pendingDecisionCount: number;
  activeTerminalCount: number;
  serverTime: RemoteTimestamp;
}

export interface ConnectionLimits {
  maxFrameBytes: typeof MAX_FRAME_BYTES;
  maxChunkBytes: typeof MAX_CHUNK_BYTES;
  maxConcurrentRpcs: number;
  rpcReadTimeoutMs: number;
  rpcWriteTimeoutMs: number;
  heartbeatIntervalMs: number;
  challengeTtlMs: number;
}

export interface SnapshotPayload {
  baseSeq: RemoteSeq;
  host: HostStatus;
  projects?: ProjectSummary[];
  agents?: AgentSummary[];
  conversations?: ConversationSummary[];
  activeRuns?: RunSummary[];
  pendingDecisions?: DecisionSummary[];
  activeWorkflows?: WorkflowSummary[];
  activeDelegations?: DelegationSummary[];
  activeTasks?: TaskSummary[];
  activeTerminals?: TerminalSummary[];
}

export type RemoteStreamItem =
  | {
      kind: "text";
      role: "user" | "assistant" | "system";
      content: string;
      append?: boolean;
      messageId?: RemoteId;
    }
  | {
      kind: "thinking";
      content: string;
      append?: boolean;
      messageId?: RemoteId;
    }
  | {
      kind: "tool-call";
      tool: string;
      id?: RemoteId;
      status?: "pending" | "running" | "completed" | "failed";
      toolKind?:
        | "read"
        | "edit"
        | "delete"
        | "move"
        | "search"
        | "execute"
        | "think"
        | "fetch"
        | "mode"
        | "other";
      inputPreview?: string;
    }
  | {
      kind: "tool-result";
      tool: string;
      id?: RemoteId;
      content: string;
      isError?: boolean;
    }
  | { kind: "command"; command: string }
  | { kind: "command-output"; content: string; stream?: "stdout" | "stderr" }
  | {
      kind: "file-edit";
      path: string;
      action: "create" | "update" | "delete";
      patch?: string;
    }
  | {
      kind: "usage";
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      totalCost?: number;
    }
  | { kind: "error"; message: string; terminal?: boolean }
  | { kind: "done"; exitCode?: number };

export interface RemoteMethodParamsMap {
  "host.status": Record<string, never>;
  "sync.snapshot": { conversationLimit?: number };
  "project.list": RemotePageParams;
  "agent.list": RemotePageParams & { projectId?: RemoteId };
  "conversation.list": RemotePageParams & { projectId?: RemoteId };
  "conversation.get": { conversationId: RemoteId };
  "message.list": RemotePageParams & { conversationId: RemoteId };
  "task.list": RemotePageParams & { projectId?: RemoteId; conversationId?: RemoteId };
  "task.readLog": RemotePageParams & { taskId: RemoteId };
  "workflow.list": RemotePageParams;
  "workflow.get": { workflowId: RemoteId };
  "delegation.list": RemotePageParams;
  "delegation.get": { delegationId: RemoteId };
  "conversation.create": { projectId: RemoteId; title?: string; agentId?: RemoteId };
  "conversation.rename": { conversationId: RemoteId; title: string };
  "conversation.archive": { conversationId: RemoteId };
  "conversation.delete": { conversationId: RemoteId };
  "conversation.send": { conversationId: RemoteId; content: string };
  "run.stop": { runId: RemoteId };
  "permission.respond": { decisionId: RemoteId; allow: boolean };
  "authentication.respond": { decisionId: RemoteId; allow: boolean };
  "workflow.start": { workflowId: RemoteId; conversationId?: RemoteId };
  "workflow.stop": { workflowId: RemoteId };
  "delegation.start": { teamId: RemoteId; conversationId: RemoteId; prompt: string };
  "delegation.stop": { delegationId: RemoteId };
  "terminal.create": { projectId: RemoteId; cols?: number; rows?: number };
  "terminal.input": { terminalId: RemoteId; data: string };
  "terminal.resize": { terminalId: RemoteId; cols: number; rows: number };
  "terminal.snapshot": { terminalId: RemoteId };
  "terminal.close": { terminalId: RemoteId };
}

export interface RemoteMethodResultMap {
  "host.status": HostStatus;
  "sync.snapshot": SnapshotPayload;
  "project.list": RemotePageResult<ProjectSummary>;
  "agent.list": RemotePageResult<AgentSummary>;
  "conversation.list": RemotePageResult<ConversationSummary>;
  "conversation.get": ConversationSummary;
  "message.list": RemotePageResult<MessageSummary>;
  "task.list": RemotePageResult<TaskSummary>;
  "task.readLog": RemotePageResult<TaskLogItem>;
  "workflow.list": RemotePageResult<WorkflowSummary>;
  "workflow.get": WorkflowSummary & { stepCount?: number };
  "delegation.list": RemotePageResult<DelegationSummary>;
  "delegation.get": DelegationSummary;
  "conversation.create": {
    conversationId: RemoteId;
    projectId: RemoteId;
    title: string;
    createdAt: RemoteTimestamp;
  };
  "conversation.rename": {
    conversationId: RemoteId;
    title: string;
    updatedAt: RemoteTimestamp;
  };
  "conversation.archive": {
    conversationId: RemoteId;
    archived: true;
    updatedAt: RemoteTimestamp;
  };
  "conversation.delete": { conversationId: RemoteId; deleted: true };
  "conversation.send": {
    conversationId: RemoteId;
    messageId: RemoteId;
    runId: RemoteId;
  };
  "run.stop": { runId: RemoteId; status: "stopped" };
  "permission.respond": { decisionId: RemoteId; resolved: true };
  "authentication.respond": { decisionId: RemoteId; resolved: true };
  "workflow.start": { workflowId: RemoteId; runId?: RemoteId; status: "running" };
  "workflow.stop": { workflowId: RemoteId; status: "stopped" };
  "delegation.start": { delegationId: RemoteId; status: "running" };
  "delegation.stop": { delegationId: RemoteId; status: "stopped" };
  "terminal.create": TerminalSummary;
  "terminal.input": { terminalId: RemoteId; accepted: true };
  "terminal.resize": { terminalId: RemoteId; cols: number; rows: number };
  "terminal.snapshot": {
    terminalId: RemoteId;
    cols: number;
    rows: number;
    output: string;
    truncated: boolean;
    seq: RemoteSeq;
  };
  "terminal.close": { terminalId: RemoteId; closed: true };
}

export interface RemoteMethodSpec<M extends RemoteMethod = RemoteMethod> {
  method: M;
  kind: M extends WriteRemoteMethod ? "write" : "read";
  timeoutMs: number;
  autoRetry: boolean;
  idempotencyRequired: boolean;
  expiresAtRequired: boolean;
  events: readonly RemoteEventName[];
}

const METHOD_EVENT_MAP: { [K in RemoteMethod]: readonly RemoteEventName[] } = {
  "host.status": [],
  "sync.snapshot": [],
  "project.list": [],
  "agent.list": [],
  "conversation.list": [],
  "conversation.get": [],
  "message.list": [],
  "task.list": [],
  "task.readLog": [],
  "workflow.list": [],
  "workflow.get": [],
  "delegation.list": [],
  "delegation.get": [],
  "conversation.create": ["conversation.created"],
  "conversation.rename": ["conversation.updated"],
  "conversation.archive": ["conversation.updated"],
  "conversation.delete": ["conversation.deleted"],
  "conversation.send": [
    "message.created",
    "run.started",
    "run.stream",
    "run.finished",
    "run.failed"
  ],
  "run.stop": ["run.stopped"],
  "permission.respond": ["permission.resolved"],
  "authentication.respond": ["authentication.resolved"],
  "workflow.start": ["workflow.updated"],
  "workflow.stop": ["workflow.updated"],
  "delegation.start": ["delegation.updated"],
  "delegation.stop": ["delegation.updated"],
  "terminal.create": ["terminal.opened"],
  "terminal.input": ["terminal.output"],
  "terminal.resize": [],
  "terminal.snapshot": [],
  "terminal.close": ["terminal.closed"]
};

export const REMOTE_METHOD_SPECS: { [K in RemoteMethod]: RemoteMethodSpec<K> } =
  Object.fromEntries(
    REMOTE_METHODS.map((method) => {
      const write = (WRITE_REMOTE_METHODS as readonly string[]).includes(method);
      const spec = {
        method,
        kind: write ? "write" : "read",
        timeoutMs: write ? DEFAULT_WRITE_TIMEOUT_MS : DEFAULT_READ_TIMEOUT_MS,
        autoRetry: !write,
        idempotencyRequired: write,
        expiresAtRequired: write,
        events: METHOD_EVENT_MAP[method]
      };
      return [method, spec];
    })
  ) as { [K in RemoteMethod]: RemoteMethodSpec<K> };

export interface EnvelopeBase {
  v: typeof REMOTE_PROTOCOL_VERSION;
  id: RemoteId;
  sentAt: RemoteTimestamp;
  hostId?: RemoteId;
  expiresAt?: RemoteTimestamp;
  idempotencyKey?: string;
  seq?: RemoteSeq;
  meta?: RemoteMeta;
}

export interface ChallengeFrame extends EnvelopeBase {
  type: "challenge";
  payload: {
    connectionId: RemoteId;
    challenge: string;
    issuedAt: RemoteTimestamp;
    expiresAt: RemoteTimestamp;
  };
}

export interface HostAuthFrame extends EnvelopeBase {
  type: "host.auth";
  hostId: RemoteId;
  payload: {
    hostId: RemoteId;
    keyId: RemoteId;
    publicKey: string;
    signature: string;
    clientVersion: string;
    protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  };
}

export interface AdminAuthFrame extends EnvelopeBase {
  type: "admin.auth";
  payload: {
    accessToken: string;
    clientVersion: string;
    protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  };
}

export interface AuthOkFrame extends EnvelopeBase {
  type: "auth.ok";
  payload: {
    connectionId: RemoteId;
    role: "host" | "admin";
    hostId?: RemoteId;
    serverTime: RemoteTimestamp;
    limits: ConnectionLimits;
  };
}

export interface ErrorFrame extends EnvelopeBase {
  type: "error";
  payload: RemoteStructuredError;
}

export interface RpcRequestFrame<M extends RemoteMethod = RemoteMethod> extends EnvelopeBase {
  type: "rpc.request";
  hostId: RemoteId;
  payload: {
    method: M;
    params: RemoteMethodParamsMap[M];
  };
}

export interface RpcSuccessPayload<M extends RemoteMethod = RemoteMethod> {
  requestId: RemoteId;
  ok: true;
  result: RemoteMethodResultMap[M];
}

export interface RpcFailurePayload {
  requestId: RemoteId;
  ok: false;
  error: RemoteStructuredError;
}

export interface RpcResponseFrame extends EnvelopeBase {
  type: "rpc.response";
  hostId: RemoteId;
  payload: RpcSuccessPayload | RpcFailurePayload;
}

export type RemoteEventDataMap = {
  "host.status.changed": HostStatus;
  "conversation.created": ConversationSummary;
  "conversation.updated": ConversationSummary;
  "conversation.deleted": { conversationId: RemoteId };
  "message.created": MessageSummary;
  "message.updated": MessageSummary;
  "run.started": { runId: RemoteId; conversationId: RemoteId; agentId?: RemoteId };
  "run.stream": {
    runId: RemoteId;
    conversationId?: RemoteId;
    item: RemoteStreamItem;
    index?: number;
  };
  "run.finished": { runId: RemoteId; conversationId: RemoteId };
  "run.failed": {
    runId: RemoteId;
    conversationId: RemoteId;
    error: RemoteStructuredError;
  };
  "run.stopped": { runId: RemoteId; conversationId: RemoteId };
  "permission.requested": DecisionSummary;
  "permission.resolved": { decisionId: RemoteId; allow: boolean };
  "authentication.requested": DecisionSummary;
  "authentication.resolved": { decisionId: RemoteId; allow: boolean };
  "task.updated": TaskSummary;
  "task.log.appended": { taskId: RemoteId; item: TaskLogItem };
  "workflow.updated": WorkflowSummary;
  "delegation.updated": DelegationSummary;
  "terminal.opened": TerminalSummary;
  "terminal.output": {
    terminalId: RemoteId;
    data: string;
    seq: RemoteSeq;
    truncated?: boolean;
  };
  "terminal.closed": { terminalId: RemoteId };
};

export interface EventFrame<N extends RemoteEventName = RemoteEventName> extends EnvelopeBase {
  type: "event";
  hostId: RemoteId;
  seq: RemoteSeq;
  payload: { name: N; data: RemoteEventDataMap[N] };
}

export interface ResumeFrame extends EnvelopeBase {
  type: "resume";
  hostId: RemoteId;
  payload: { resumeFrom: RemoteSeq };
}

export interface SnapshotFrame extends EnvelopeBase {
  type: "snapshot";
  hostId: RemoteId;
  seq: RemoteSeq;
  payload: SnapshotPayload;
}

export interface PingFrame extends EnvelopeBase {
  type: "ping";
  payload: { nonce?: string };
}

export interface PongFrame extends EnvelopeBase {
  type: "pong";
  payload: { nonce?: string; serverTime: RemoteTimestamp };
}

export interface ServerDrainingFrame extends EnvelopeBase {
  type: "server.draining";
  payload: {
    reason: "shutdown" | "restart" | "version";
    reconnectAfterMs: number;
  };
}

export type RemoteFrame =
  | ChallengeFrame
  | HostAuthFrame
  | AdminAuthFrame
  | AuthOkFrame
  | ErrorFrame
  | RpcRequestFrame
  | RpcResponseFrame
  | EventFrame
  | ResumeFrame
  | SnapshotFrame
  | PingFrame
  | PongFrame
  | ServerDrainingFrame;

export interface ParseFailure {
  code: RemoteErrorCode;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ParseFailure };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMESTAMP_RE =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?Z$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{22,128}$/;

const ENVELOPE_KEYS = new Set([
  "v",
  "type",
  "id",
  "hostId",
  "sentAt",
  "expiresAt",
  "idempotencyKey",
  "seq",
  "payload",
  "meta"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRemoteId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && ID_RE.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP_RE.test(value);
}

export function isRemoteErrorCode(value: unknown): value is RemoteErrorCode {
  return typeof value === "string" && (REMOTE_ERROR_CODES as readonly string[]).includes(value);
}

export function isRemoteFrameType(value: unknown): value is RemoteFrameType {
  return typeof value === "string" && (REMOTE_FRAME_TYPES as readonly string[]).includes(value);
}

export function isRemoteMethod(value: unknown): value is RemoteMethod {
  return typeof value === "string" && (REMOTE_METHODS as readonly string[]).includes(value);
}

export function isWriteMethod(method: RemoteMethod): method is WriteRemoteMethod {
  return (WRITE_REMOTE_METHODS as readonly string[]).includes(method);
}

export function isForbiddenMethod(value: unknown): boolean {
  return typeof value === "string" && (FORBIDDEN_REMOTE_METHODS as readonly string[]).includes(value);
}

export function isRemoteEventName(value: unknown): value is RemoteEventName {
  return typeof value === "string" && (REMOTE_EVENT_NAMES as readonly string[]).includes(value);
}

export function getMethodSpec<M extends RemoteMethod>(method: M): RemoteMethodSpec<M> {
  return REMOTE_METHOD_SPECS[method];
}

function fail(code: RemoteErrorCode, message: string): ParseResult<never> {
  return { ok: false, error: { code, message } };
}

function hasUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).some((key) => !allowed.has(key));
}

/** Structural envelope parse. Does not enforce MAX_FRAME_BYTES / MAX_CHUNK_BYTES or deep method params/result schemas. */
export function parseRemoteFrame(value: unknown): ParseResult<RemoteFrame> {
  if (!isRecord(value)) {
    return fail("invalid_request", "Frame must be a JSON object");
  }
  if (hasUnknownKeys(value, ENVELOPE_KEYS)) {
    return fail("invalid_request", "Frame contains unknown envelope fields");
  }
  if (value.v !== REMOTE_PROTOCOL_VERSION) {
    return fail("unsupported_version", "Unsupported protocol version");
  }
  if (!isRemoteFrameType(value.type)) {
    return fail("invalid_request", "Unknown frame type");
  }
  if (!isRemoteId(value.id) || !isTimestamp(value.sentAt) || !isRecord(value.payload)) {
    return fail("invalid_request", "Frame is missing required envelope fields");
  }
  if (value.hostId !== undefined && !isRemoteId(value.hostId)) {
    return fail("invalid_request", "hostId is invalid");
  }
  if (value.expiresAt !== undefined && !isTimestamp(value.expiresAt)) {
    return fail("invalid_request", "expiresAt is invalid");
  }
  if (value.idempotencyKey !== undefined && !IDEMPOTENCY_RE.test(String(value.idempotencyKey))) {
    return fail("invalid_request", "idempotencyKey is invalid");
  }
  if (value.seq !== undefined && !(typeof value.seq === "number" && Number.isInteger(value.seq) && value.seq >= 0)) {
    return fail("invalid_request", "seq is invalid");
  }

  if (value.type === "rpc.request") {
    return parseRpcRequest(value);
  }
  if (value.type === "event") {
    if (typeof value.seq !== "number" || !isRemoteId(value.hostId)) {
      return fail("invalid_request", "event requires hostId and seq");
    }
    const name = value.payload.name;
    if (!isRemoteEventName(name) || !isRecord(value.payload.data)) {
      return fail("invalid_request", "event payload is invalid");
    }
  }
  if (value.type === "snapshot") {
    if (typeof value.seq !== "number" || !isRemoteId(value.hostId)) {
      return fail("invalid_request", "snapshot requires hostId and seq");
    }
  }
  if ((value.type === "rpc.response" || value.type === "resume" || value.type === "host.auth") && !isRemoteId(value.hostId)) {
    return fail("invalid_request", `${value.type} requires hostId`);
  }

  return { ok: true, value: value as unknown as RemoteFrame };
}

function parseRpcRequest(value: Record<string, unknown>): ParseResult<RpcRequestFrame> {
  if (value.seq !== undefined) {
    return fail("invalid_request", "rpc.request must not include seq");
  }
  if (!isRemoteId(value.hostId)) {
    return fail("invalid_request", "rpc.request requires hostId");
  }
  const payload = value.payload as Record<string, unknown>;
  if (isForbiddenMethod(payload.method) || !isRemoteMethod(payload.method)) {
    return fail("method_not_allowed", "Method is not in the v1 registry");
  }
  if (!isRecord(payload.params)) {
    return fail("invalid_request", "RPC params must be an object");
  }
  if ("cwd" in payload.params || "env" in payload.params || "binary" in payload.params || "channel" in payload.params) {
    return fail("invalid_request", "RPC params must not include cwd, env, binary, or channel");
  }
  const spec = getMethodSpec(payload.method);
  if (spec.idempotencyRequired && !IDEMPOTENCY_RE.test(String(value.idempotencyKey ?? ""))) {
    return fail("invalid_request", "Write RPC requires idempotencyKey");
  }
  if (spec.expiresAtRequired && !isTimestamp(value.expiresAt)) {
    return fail("invalid_request", "Write RPC requires expiresAt");
  }
  return { ok: true, value: value as unknown as RpcRequestFrame };
}

export function isRemoteFrame(value: unknown): value is RemoteFrame {
  return parseRemoteFrame(value).ok;
}

export interface HostAuthCanonicalInput {
  hostId: string;
  challenge: string;
  connectionId: string;
  issuedAt: string;
}

export function buildHostAuthCanonicalPayload(input: HostAuthCanonicalInput): string {
  return [
    HOST_AUTH_CANONICAL_PREFIX,
    `hostId:${input.hostId}`,
    `challenge:${input.challenge}`,
    `connectionId:${input.connectionId}`,
    `issuedAt:${input.issuedAt}`,
    ""
  ].join("\n");
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8ByteLength(text: string): number {
  return encodeUtf8(text).byteLength;
}

/** UTF-8 byte length of a `ChunkText` value. Transport and stream producers must enforce this; `parseRemoteFrame` does not. */
export function exceedsChunkLimit(text: string): boolean {
  return utf8ByteLength(text) > MAX_CHUNK_BYTES;
}

/** UTF-8 byte length of a raw WebSocket text frame, before JSON.parse. */
export function exceedsFrameLimit(raw: string | Uint8Array): boolean {
  const bytes = typeof raw === "string" ? utf8ByteLength(raw) : raw.byteLength;
  return bytes > MAX_FRAME_BYTES;
}

export const HTTP_BODY_KINDS = [
  "WeChatAuthRequest",
  "WeChatAuthResponse",
  "RefreshRequest",
  "RefreshResponse",
  "LogoutRequest",
  "PairingStartRequest",
  "PairingStartResponse",
  "PairingClaimRequest",
  "PairingClaimResponse",
  "HttpError"
] as const;

export type HttpBodyKind = (typeof HTTP_BODY_KINDS)[number];

export interface WeChatAuthRequest {
  code: string;
  clientVersion: string;
  deviceLabel?: string;
}

export interface WeChatAuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

export type RefreshRequest = { refreshToken: string };
export type RefreshResponse = WeChatAuthResponse;
export type LogoutRequest = Record<string, never>;
export type HttpError = RemoteStructuredError;

export interface PairingStartRequest {
  hostId: RemoteId;
  keyId: RemoteId;
  publicKey: string;
  displayName: string;
  secretHash: string;
  proof: string;
}

export interface PairingStartResponse {
  pairingId: RemoteId;
  displayCode: string;
  expiresAt: RemoteTimestamp;
}

export interface PairingClaimRequest {
  pairingId: RemoteId;
  secret: string;
}

export interface PairingClaimResponse {
  hostId: RemoteId;
  keyId?: RemoteId;
  displayName: string;
}

export interface HttpBodyMap {
  WeChatAuthRequest: WeChatAuthRequest;
  WeChatAuthResponse: WeChatAuthResponse;
  RefreshRequest: RefreshRequest;
  RefreshResponse: RefreshResponse;
  LogoutRequest: LogoutRequest;
  PairingStartRequest: PairingStartRequest;
  PairingStartResponse: PairingStartResponse;
  PairingClaimRequest: PairingClaimRequest;
  PairingClaimResponse: PairingClaimResponse;
  HttpError: HttpError;
}

export interface PairingStartCanonicalInput {
  hostId: string;
  keyId: string;
  publicKey: string;
  secretHash: string;
}

const PAIRING_SECRET_RE = /^[A-Za-z0-9_-]{43,86}$/;
const PAIRING_SECRET_HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const ED25519_PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const ED25519_SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;
const PAIRING_DISPLAY_CODE_RE = /^[A-Z0-9]{8,12}$/;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9._~-]{32,512}$/;
const DISPLAY_NAME_RE = /^.{1,120}$/;
const PAIRING_QR_RE =
  /^freebuddy-remote:\/\/pair\/v1\?pairingId=([A-Za-z0-9][A-Za-z0-9._:-]{0,127})&secret=([A-Za-z0-9_-]{43,86})$/;

const HTTP_ALLOWED_KEYS: { [K in HttpBodyKind]: ReadonlySet<string> } = {
  WeChatAuthRequest: new Set(["code", "clientVersion", "deviceLabel"]),
  WeChatAuthResponse: new Set(["accessToken", "refreshToken", "expiresIn", "refreshExpiresIn"]),
  RefreshRequest: new Set(["refreshToken"]),
  RefreshResponse: new Set(["accessToken", "refreshToken", "expiresIn", "refreshExpiresIn"]),
  LogoutRequest: new Set(),
  PairingStartRequest: new Set(["hostId", "keyId", "publicKey", "displayName", "secretHash", "proof"]),
  PairingStartResponse: new Set(["pairingId", "displayCode", "expiresAt"]),
  PairingClaimRequest: new Set(["pairingId", "secret"]),
  PairingClaimResponse: new Set(["hostId", "keyId", "displayName"]),
  HttpError: new Set(["code", "message", "retryable", "details"])
};

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function buildPairingStartCanonicalPayload(input: PairingStartCanonicalInput): string {
  return [
    PAIRING_START_CANONICAL_PREFIX,
    `hostId:${input.hostId}`,
    `keyId:${input.keyId}`,
    `publicKey:${input.publicKey}`,
    `secretHash:${input.secretHash}`,
    ""
  ].join("\n");
}

export function buildPairingQrPayload(pairingId: string, secret: string): string {
  return `freebuddy-remote://pair/v1?pairingId=${pairingId}&secret=${secret}`;
}

export function parsePairingQrPayload(
  value: unknown
): ParseResult<{ pairingId: string; secret: string }> {
  if (typeof value !== "string") {
    return fail("invalid_request", "Pairing QR payload must be a string");
  }
  const match = PAIRING_QR_RE.exec(value);
  if (!match) {
    return fail("invalid_request", "Pairing QR payload is invalid");
  }
  return { ok: true, value: { pairingId: match[1], secret: match[2] } };
}

export function parsePairingStartRequest(value: unknown): ParseResult<PairingStartRequest> {
  return parseHttpBody("PairingStartRequest", value);
}

export function parsePairingStartResponse(value: unknown): ParseResult<PairingStartResponse> {
  return parseHttpBody("PairingStartResponse", value);
}

export function parsePairingClaimRequest(value: unknown): ParseResult<PairingClaimRequest> {
  return parseHttpBody("PairingClaimRequest", value);
}

export function parsePairingClaimResponse(value: unknown): ParseResult<PairingClaimResponse> {
  return parseHttpBody("PairingClaimResponse", value);
}

export function parseHttpBody<K extends HttpBodyKind>(
  kind: K,
  value: unknown
): ParseResult<HttpBodyMap[K]> {
  if (!isRecord(value)) {
    return fail("invalid_request", `${kind} must be a JSON object`);
  }
  if (hasUnknownKeys(value, HTTP_ALLOWED_KEYS[kind])) {
    return fail("invalid_request", `${kind} contains unknown fields`);
  }

  if (kind === "LogoutRequest") {
    return { ok: true, value: value as HttpBodyMap[K] };
  }

  if (kind === "WeChatAuthRequest") {
    if (!isBoundedHttpString(value.code, 1, 256) || !isBoundedHttpString(value.clientVersion, 1, 64)) {
      return fail("invalid_request", "WeChatAuthRequest is invalid");
    }
    if (value.deviceLabel !== undefined && !isBoundedHttpString(value.deviceLabel, 1, 64)) {
      return fail("invalid_request", "deviceLabel is invalid");
    }
    return { ok: true, value: value as HttpBodyMap[K] };
  }

  if (kind === "WeChatAuthResponse" || kind === "RefreshResponse") {
    if (
      typeof value.accessToken !== "string" ||
      !OPAQUE_TOKEN_RE.test(value.accessToken) ||
      typeof value.refreshToken !== "string" ||
      !OPAQUE_TOKEN_RE.test(value.refreshToken) ||
      !isIntInRange(value.expiresIn, 60, 86400) ||
      !isIntInRange(value.refreshExpiresIn, 60, 7_776_000)
    ) {
      return fail("invalid_request", `${kind} is invalid`);
    }
    return { ok: true, value: value as HttpBodyMap[K] };
  }

  if (kind === "RefreshRequest") {
    if (typeof value.refreshToken !== "string" || !OPAQUE_TOKEN_RE.test(value.refreshToken)) {
      return fail("invalid_request", "RefreshRequest is invalid");
    }
    return { ok: true, value: value as HttpBodyMap[K] };
  }

  if (kind === "PairingStartRequest") {
    if (
      !isRemoteId(value.hostId) ||
      !isRemoteId(value.keyId) ||
      typeof value.publicKey !== "string" ||
      !ED25519_PUBLIC_KEY_RE.test(value.publicKey) ||
      typeof value.displayName !== "string" ||
      !DISPLAY_NAME_RE.test(value.displayName) ||
      typeof value.secretHash !== "string" ||
      !PAIRING_SECRET_HASH_RE.test(value.secretHash) ||
      typeof value.proof !== "string" ||
      !ED25519_SIGNATURE_RE.test(value.proof)
    ) {
      return fail("invalid_request", "PairingStartRequest is invalid");
    }
    return { ok: true, value: value as HttpBodyMap[K] };
  }

  if (kind === "PairingStartResponse") {
    if (
      !isRemoteId(value.pairingId) ||
      typeof value.displayCode !== "string" ||
      !PAIRING_DISPLAY_CODE_RE.test(value.displayCode) ||
      !isTimestamp(value.expiresAt)
    ) {
      return fail("invalid_request", "PairingStartResponse is invalid");
    }
    return { ok: true, value: value as HttpBodyMap[K] };
  }

  if (kind === "PairingClaimRequest") {
    if (
      !isRemoteId(value.pairingId) ||
      typeof value.secret !== "string" ||
      !PAIRING_SECRET_RE.test(value.secret)
    ) {
      return fail("invalid_request", "PairingClaimRequest is invalid");
    }
    return { ok: true, value: value as HttpBodyMap[K] };
  }

  if (kind === "PairingClaimResponse") {
    if (
      !isRemoteId(value.hostId) ||
      typeof value.displayName !== "string" ||
      !DISPLAY_NAME_RE.test(value.displayName)
    ) {
      return fail("invalid_request", "PairingClaimResponse is invalid");
    }
    if (value.keyId !== undefined && !isRemoteId(value.keyId)) {
      return fail("invalid_request", "keyId is invalid");
    }
    return { ok: true, value: value as HttpBodyMap[K] };
  }

  if (kind === "HttpError") {
    if (
      !isRemoteErrorCode(value.code) ||
      !isBoundedHttpString(value.message, 1, 512) ||
      typeof value.retryable !== "boolean"
    ) {
      return fail("invalid_request", "HttpError is invalid");
    }
    if (value.details !== undefined && !isRecord(value.details)) {
      return fail("invalid_request", "HttpError details is invalid");
    }
    return { ok: true, value: value as HttpBodyMap[K] };
  }

  return fail("invalid_request", "Unknown HTTP body kind");
}

function isBoundedHttpString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}
