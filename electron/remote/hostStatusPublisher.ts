import { randomBytes } from "node:crypto";
import {
  REMOTE_PROTOCOL_VERSION,
  parseRemoteFrame,
  type HostStatus,
  type RemoteFrame
} from "@freebuddy/protocol/remote";

import type { RelayClient } from "./relayClient.js";

/** The only D3 domain event. Broader EventHub mapping starts in D4. */
export type HostStatusInput = Omit<HostStatus, "serverTime"> & { serverTime?: string };

const HOST_STATUS_KEYS = new Set([
  "hostId", "displayName", "online", "appVersion", "protocolVersion",
  "remoteEnabled", "activeRunCount", "pendingDecisionCount", "activeTerminalCount", "serverTime"
]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMESTAMP_RE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?Z$/;

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP_RE.test(value);
}

/** Reject unknown fields and malformed status data before it reaches the transport. */
export function validateHostStatus(input: HostStatusInput, serverTime: string): HostStatus {
  if (Object.keys(input).some(key => !HOST_STATUS_KEYS.has(key))) throw new Error("host status contains an unapproved field");
  const status: HostStatus = { ...input, serverTime: input.serverTime ?? serverTime };
  if (
    typeof status.hostId !== "string" || !ID_RE.test(status.hostId) ||
    (status.displayName !== undefined && (typeof status.displayName !== "string" || status.displayName.length < 1 || status.displayName.length > 120)) ||
    typeof status.online !== "boolean" || typeof status.appVersion !== "string" || status.appVersion.length < 1 || status.appVersion.length > 64 ||
    status.protocolVersion !== REMOTE_PROTOCOL_VERSION || typeof status.remoteEnabled !== "boolean" ||
    !Number.isInteger(status.activeRunCount) || status.activeRunCount < 0 || status.activeRunCount > 10_000 ||
    !Number.isInteger(status.pendingDecisionCount) || status.pendingDecisionCount < 0 || status.pendingDecisionCount > 10_000 ||
    !Number.isInteger(status.activeTerminalCount) || status.activeTerminalCount < 0 || status.activeTerminalCount > 1_000 ||
    !isIsoTimestamp(status.serverTime)
  ) throw new Error("host status does not satisfy protocol/remote/v1");
  return status;
}

export function buildHostStatusChangedFrame(input: HostStatusInput, seq: number, now = Date.now()): RemoteFrame {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("host status event sequence is invalid");
  const sentAt = new Date(now).toISOString();
  const status = validateHostStatus(input, sentAt);
  const frame: RemoteFrame = {
    v: REMOTE_PROTOCOL_VERSION,
    type: "event",
    id: `msg_${randomBytes(12).toString("base64url")}`,
    hostId: status.hostId,
    sentAt,
    seq,
    payload: { name: "host.status.changed", data: status }
  };
  if (!parseRemoteFrame(frame).ok) throw new Error("host status event failed protocol envelope validation");
  return frame;
}

/**
 * D3's narrowly-scoped publisher. It can only emit host.status.changed; it
 * deliberately has no access to EventHub or arbitrary protocol event names.
 */
export class HostStatusPublisher {
  private seq = 0;
  constructor(private readonly relay: RelayClient, private readonly now: () => number = Date.now) {}

  publish(input: HostStatusInput): boolean {
    const frame = buildHostStatusChangedFrame(input, this.seq, this.now());
    if (!this.relay.send(frame)) return false;
    this.seq += 1;
    return true;
  }
}
