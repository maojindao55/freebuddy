/**
 * Frame admission rules for the admin client, derived from the generated binding.
 *
 * The v1 protocol plan fixes the direction of every frame type:
 *
 * | type | direction |
 * | --- | --- |
 * | challenge | Relay → Host |
 * | host.auth | Host → Relay |
 * | admin.auth | Admin → Relay |
 * | auth.ok | Relay → Client |
 * | error | bidirectional |
 * | rpc.request | Admin → Host |
 * | rpc.response | Host → Admin |
 * | event | Host → Admin |
 * | resume | Admin → Relay/Host |
 * | snapshot | Host → Admin |
 * | ping / pong | bidirectional |
 * | server.draining | Relay → Client |
 *
 * Anything arriving from Relay that is not addressed *to* the admin is a protocol violation:
 * it is dropped, counted and reported as a redacted diagnostic — never applied to a store.
 * Nothing here invents wire fields; the direction table only reads the binding's frame types.
 */

import {
  exceedsFrameLimit,
  parseRemoteFrame,
  REMOTE_FRAME_TYPES,
  type AdminAuthFrame,
  type EventFrame,
  type PingFrame,
  type PongFrame,
  type RemoteFrame,
  type RemoteFrameType,
  type RemoteMethodParamsMap,
  type RemoteMethod,
  type ResumeFrame,
  type RpcRequestFrame,
  type RpcResponseFrame,
  type RemoteId,
  type RemoteTimestamp
} from "./remote.generated";

export type FrameDirection =
  | "relayToHost"
  | "hostToRelay"
  | "adminToRelay"
  | "relayToClient"
  | "adminToHost"
  | "hostToAdmin"
  | "bidirectional";

export const FRAME_DIRECTIONS: Readonly<Record<RemoteFrameType, FrameDirection>> = {
  challenge: "relayToHost",
  "host.auth": "hostToRelay",
  "admin.auth": "adminToRelay",
  "auth.ok": "relayToClient",
  error: "bidirectional",
  "rpc.request": "adminToHost",
  "rpc.response": "hostToAdmin",
  event: "hostToAdmin",
  resume: "adminToHost",
  snapshot: "hostToAdmin",
  ping: "bidirectional",
  pong: "bidirectional",
  "server.draining": "relayToClient"
};

const DIRECTIONS_TO_CLIENT: ReadonlySet<FrameDirection> = new Set<FrameDirection>([
  "relayToClient",
  "hostToAdmin",
  "bidirectional"
]);

const DIRECTIONS_FROM_CLIENT: ReadonlySet<FrameDirection> = new Set<FrameDirection>([
  "adminToRelay",
  "adminToHost",
  "bidirectional"
]);

function typesFor(directions: ReadonlySet<FrameDirection>): ReadonlySet<RemoteFrameType> {
  const set = new Set<RemoteFrameType>();
  for (const type of REMOTE_FRAME_TYPES) {
    if (directions.has(FRAME_DIRECTIONS[type])) {
      set.add(type);
    }
  }
  return set;
}

/** Frame types Relay may legitimately deliver to this admin client. */
export const ADMIN_INBOUND_FRAME_TYPES: ReadonlySet<RemoteFrameType> = typesFor(DIRECTIONS_TO_CLIENT);

/** Frame types this client may legitimately emit. */
export const ADMIN_OUTBOUND_FRAME_TYPES: ReadonlySet<RemoteFrameType> = typesFor(DIRECTIONS_FROM_CLIENT);

/** Before `auth.ok` the client only accepts the handshake result or a connection-level error. */
export const PRE_AUTH_INBOUND_FRAME_TYPES: ReadonlySet<RemoteFrameType> = new Set<RemoteFrameType>([
  "auth.ok",
  "error"
]);

/** Frames that always carry the host identity, and therefore must match the configured host. */
export const HOST_SCOPED_INBOUND_FRAME_TYPES: ReadonlySet<RemoteFrameType> = new Set<RemoteFrameType>([
  "event",
  "snapshot",
  "rpc.response"
]);

export type InboundViolationCode =
  | "frame_too_large"
  | "invalid_json"
  | "frame_schema"
  | "frame_direction"
  | "frame_pre_auth"
  | "frame_identity";

export interface InboundViolation {
  readonly code: InboundViolationCode;
  /** Short, already redacted single-line diagnostic. Never contains frame payloads. */
  readonly detail: string;
  readonly frameType?: RemoteFrameType;
}

export type InboundOutcome =
  | { readonly kind: "frame"; readonly frame: RemoteFrame }
  | { readonly kind: "violation"; readonly violation: InboundViolation };

export interface InboundContext {
  /** True once `auth.ok` has been accepted for the current connection. */
  readonly authenticated: boolean;
  /** Explicitly configured host identity, or null while unconfigured. */
  readonly expectedHostId: string | null;
}

function violation(
  code: InboundViolationCode,
  detail: string,
  frameType?: RemoteFrameType
): InboundOutcome {
  return { kind: "violation", violation: { code, detail, frameType } };
}

export interface HostScopedFrame {
  readonly hostId?: RemoteId;
}

/** Reads the host identity a frame claims, without assuming a specific frame type. */
export function readFrameHostId(frame: unknown): RemoteId | undefined {
  if (typeof frame !== "object" || frame === null) {
    return undefined;
  }
  const value = (frame as HostScopedFrame).hostId;
  return typeof value === "string" ? value : undefined;
}

/**
 * Admission pipeline: JSON text in, typed frame or violation out.
 *
 * Order matters: the byte ceiling is checked *before* `JSON.parse`, and the direction check
 * runs before any store mutation, so a hostile or buggy Relay cannot reach application state.
 */
export function classifyInboundFrame(raw: unknown, context: InboundContext): InboundOutcome {
  if (typeof raw !== "string") {
    return violation("frame_schema", "inbound message must be a text frame");
  }
  if (exceedsFrameLimit(raw)) {
    return violation("frame_too_large", "inbound frame exceeds MAX_FRAME_BYTES");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return violation("invalid_json", "inbound frame is not valid JSON");
  }

  const result = parseRemoteFrame(parsed);
  if (!result.ok) {
    return violation("frame_schema", `${result.error.code}: ${result.error.message}`, undefined);
  }

  const frame = result.value;
  if (!ADMIN_INBOUND_FRAME_TYPES.has(frame.type)) {
    return violation("frame_direction", `${frame.type} is never sent to the admin client`, frame.type);
  }
  if (!context.authenticated && !PRE_AUTH_INBOUND_FRAME_TYPES.has(frame.type)) {
    return violation("frame_pre_auth", `${frame.type} arrived before auth.ok`, frame.type);
  }

  const frameHostId = readFrameHostId(frame);
  if (context.expectedHostId === null) {
    if (HOST_SCOPED_INBOUND_FRAME_TYPES.has(frame.type)) {
      return violation("frame_identity", "host-scoped frame arrived while no host is configured", frame.type);
    }
    if (frameHostId !== undefined) {
      return violation("frame_identity", "frame claims a hostId while no host is configured", frame.type);
    }
  } else if (frameHostId !== undefined && frameHostId !== context.expectedHostId) {
    return violation("frame_identity", "frame hostId does not match the configured host", frame.type);
  }

  return { kind: "frame", frame };
}

/** `rpc.response` correlation uses `payload.requestId`, never the event sequence. */
export function readRpcRequestId(frame: RpcResponseFrame): string | null {
  const payload = frame.payload as { requestId?: unknown };
  const value = payload.requestId;
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

/** Every frame type declared by the binding must have a direction; guards protocol additions. */
export function hasCompleteDirectionTable(): boolean {
  return REMOTE_FRAME_TYPES.every((type) => typeof FRAME_DIRECTIONS[type] === "string");
}

/*
 * Outbound frame builders.
 *
 * Only fields defined by `protocol/remote/v1` are emitted, and each builder returns a typed
 * frame from the generated binding so the compiler rejects invented fields.
 */

export interface BuildAdminAuthInput {
  readonly id: RemoteId;
  readonly sentAt: RemoteTimestamp;
  readonly accessToken: string;
  readonly clientVersion: string;
}

export function buildAdminAuthFrame(input: BuildAdminAuthInput): AdminAuthFrame {
  return {
    v: 1,
    id: input.id,
    type: "admin.auth",
    sentAt: input.sentAt,
    payload: {
      accessToken: input.accessToken,
      clientVersion: input.clientVersion,
      protocolVersion: 1
    }
  };
}

export interface BuildPingInput {
  readonly id: RemoteId;
  readonly sentAt: RemoteTimestamp;
  readonly nonce?: string;
}

export function buildPingFrame(input: BuildPingInput): PingFrame {
  return {
    v: 1,
    id: input.id,
    type: "ping",
    sentAt: input.sentAt,
    payload: input.nonce === undefined ? {} : { nonce: input.nonce }
  };
}

export interface BuildPongInput {
  readonly id: RemoteId;
  readonly sentAt: RemoteTimestamp;
  readonly nonce?: string;
  readonly serverTime: RemoteTimestamp;
}

export function buildPongFrame(input: BuildPongInput): PongFrame {
  return {
    v: 1,
    id: input.id,
    type: "pong",
    sentAt: input.sentAt,
    payload: {
      ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
      serverTime: input.serverTime
    }
  };
}

export interface BuildRpcRequestInput<M extends RemoteMethod> {
  readonly id: RemoteId;
  readonly sentAt: RemoteTimestamp;
  readonly hostId: RemoteId;
  readonly method: M;
  readonly params: RemoteMethodParamsMap[M];
  readonly expiresAt?: RemoteTimestamp;
}

export function buildRpcRequestFrame<M extends RemoteMethod>(
  input: BuildRpcRequestInput<M>
): RpcRequestFrame<M> {
  const frame: RpcRequestFrame<M> = {
    v: 1,
    id: input.id,
    type: "rpc.request",
    sentAt: input.sentAt,
    hostId: input.hostId,
    payload: { method: input.method, params: input.params }
  };
  return input.expiresAt === undefined ? frame : { ...frame, expiresAt: input.expiresAt };
}

export interface BuildResumeInput {
  readonly id: RemoteId;
  readonly sentAt: RemoteTimestamp;
  readonly hostId: RemoteId;
  readonly resumeFrom: number;
}

export function buildResumeFrame(input: BuildResumeInput): ResumeFrame {
  return {
    v: 1,
    id: input.id,
    type: "resume",
    sentAt: input.sentAt,
    hostId: input.hostId,
    payload: { resumeFrom: input.resumeFrom }
  };
}

export type AdminOutboundFrame =
  | AdminAuthFrame
  | PingFrame
  | PongFrame
  | ResumeFrame
  | RpcRequestFrame;

export function isAdminOutboundFrame(frame: RemoteFrame): frame is AdminOutboundFrame {
  return ADMIN_OUTBOUND_FRAME_TYPES.has(frame.type);
}

/** Events always carry `seq`; defensively re-checked for consumers that receive unknown frames. */
export function readEventSeq(frame: EventFrame): number | null {
  return typeof frame.seq === "number" && Number.isInteger(frame.seq) && frame.seq >= 0 ? frame.seq : null;
}
