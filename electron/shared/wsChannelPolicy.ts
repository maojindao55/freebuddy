export type WsChannelClass =
  | { kind: "global" }
  | { kind: "session"; sessionId: string }
  | { kind: "conversation"; conversationId: string }
  // The conversation id lives in the event payload instead of the channel name.
  | { kind: "conversationPayload" }
  // The payload itself carries the owning user (an owned record or a bare signal).
  | { kind: "ownerPayload" }
  | { kind: "drop" };

const GLOBAL_CHANNELS = new Set([
  "cli://runtime",
  "infoCards://changed",
  "conversations://changed"
]);
const CONVERSATION_PAYLOAD_CHANNELS = new Set([
  "messages://changed",
  // Draft MCP show/inspect/report events include conversationId in the payload.
  "freebuddy://draft-tool"
]);
const OWNER_PAYLOAD_CHANNELS = new Set(["scheduledTasks://changed"]);
const CLI_SESSION_PREFIX = "cli://";
const WORKFLOW_MESSAGE_PREFIX = "workflow://message/";
const WORKFLOW_EVENT_PREFIX = "workflow://event/";
const NON_SESSION_CLI_CHANNELS = new Set(["cli://runtime", "cli://install"]);

export function classifyWsChannel(channel: string): WsChannelClass {
  if (GLOBAL_CHANNELS.has(channel)) return { kind: "global" };
  if (CONVERSATION_PAYLOAD_CHANNELS.has(channel)) {
    return { kind: "conversationPayload" };
  }
  if (OWNER_PAYLOAD_CHANNELS.has(channel)) return { kind: "ownerPayload" };
  if (channel.startsWith(WORKFLOW_MESSAGE_PREFIX)) {
    const conversationId = channel.slice(WORKFLOW_MESSAGE_PREFIX.length);
    if (conversationId) return { kind: "conversation", conversationId };
  }
  if (channel.startsWith(WORKFLOW_EVENT_PREFIX)) {
    const conversationId = channel.slice(WORKFLOW_EVENT_PREFIX.length);
    if (conversationId) return { kind: "conversation", conversationId };
  }
  if (channel.startsWith(CLI_SESSION_PREFIX) && !NON_SESSION_CLI_CHANNELS.has(channel)) {
    const sessionId = channel.slice(CLI_SESSION_PREFIX.length);
    if (sessionId) return { kind: "session", sessionId };
  }
  return { kind: "drop" };
}

export function conversationIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { conversationId?: unknown }).conversationId;
  return typeof value === "string" && value ? value : null;
}

export type PayloadOwner =
  // No record attached, so the event is a bare "something changed" signal.
  | { kind: "signal" }
  | { kind: "owner"; ownerId: string | null };

export function ownerFromPayload(payload: unknown): PayloadOwner {
  if (!payload || typeof payload !== "object") return { kind: "signal" };
  const value = (payload as { ownerId?: unknown }).ownerId;
  return {
    kind: "owner",
    ownerId: typeof value === "string" && value ? value : null
  };
}
