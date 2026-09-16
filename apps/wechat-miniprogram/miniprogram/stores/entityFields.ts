/**
 * Entity field whitelists.
 *
 * Every entity that reaches a store passes through here first. Two reasons, both deliberate:
 *
 * 1. **No invented fields.** `parseRemoteFrame` validates the envelope, not deep business
 *    payloads, so an entity can legally arrive with keys this client never asked for. Copying a
 *    whitelist means a future or hostile field is dropped instead of being cached and later
 *    rendered.
 * 2. **No secrets.** A cache entry is only ever what `protocol/remote/v1` declares. Tokens,
 *    `session_key`, `Authorization`, terminal secrets or anything else smuggled into an entity
 *    simply has no slot to land in — there is no "copy the rest" path anywhere in this file.
 *
 * An entity whose *required* fields are missing or of the wrong type is dropped (returns `null`)
 * rather than repaired: a half-invented conversation in the list is worse than a missing one.
 */

import type {
  AgentSummary,
  ConversationSummary,
  DecisionSummary,
  HostStatus,
  MessageSummary,
  ProjectSummary,
  RemoteId,
  RemoteTimestamp,
  RunSummary,
  SnapshotPayload,
  TaskSummary
} from "../protocol/remote.generated";

/** Bounded cache arrays: a snapshot is authoritative, not a licence to grow without limit. */
export const MAX_SNAPSHOT_ITEMS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function id(value: unknown): RemoteId | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

function optionalId(value: unknown): RemoteId | undefined {
  return id(value) ?? undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function timestamp(value: unknown): RemoteTimestamp | null {
  return typeof value === "string" && value.length > 0 && value.length <= 40 ? value : null;
}

function optionalTimestamp(value: unknown): RemoteTimestamp | undefined {
  return timestamp(value) ?? undefined;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function list(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

function pickArray<T>(value: unknown, pick: (item: unknown) => T | null): readonly T[] {
  const items = list(value);
  if (items === null) {
    return [];
  }
  const result: T[] = [];
  for (const item of items.slice(0, MAX_SNAPSHOT_ITEMS)) {
    const picked = pick(item);
    if (picked !== null) {
      result.push(picked);
    }
  }
  return result;
}

export function pickProject(value: unknown): ProjectSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const projectId = id(value.projectId);
  const name = text(value.name);
  const updatedAt = timestamp(value.updatedAt);
  if (projectId === null || name === null || updatedAt === null) {
    return null;
  }
  return { projectId, name, updatedAt };
}

export function pickAgent(value: unknown): AgentSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const agentId = id(value.agentId);
  const name = text(value.name);
  if (agentId === null || name === null || flag(value.available) === null) {
    return null;
  }
  return {
    agentId,
    name,
    available: value.available === true,
    ...(optionalText(value.kind) === undefined ? {} : { kind: value.kind as string })
  };
}

export function pickHostStatus(value: unknown): HostStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  const hostId = id(value.hostId);
  const appVersion = text(value.appVersion);
  const serverTime = timestamp(value.serverTime);
  if (
    hostId === null ||
    appVersion === null ||
    serverTime === null ||
    flag(value.online) === null ||
    flag(value.remoteEnabled) === null ||
    count(value.activeRunCount) === null ||
    count(value.pendingDecisionCount) === null ||
    count(value.activeTerminalCount) === null ||
    value.protocolVersion !== 1
  ) {
    return null;
  }
  return {
    hostId,
    online: value.online === true,
    appVersion,
    protocolVersion: 1,
    remoteEnabled: value.remoteEnabled === true,
    activeRunCount: value.activeRunCount as number,
    pendingDecisionCount: value.pendingDecisionCount as number,
    activeTerminalCount: value.activeTerminalCount as number,
    serverTime,
    ...(optionalText(value.displayName) === undefined ? {} : { displayName: value.displayName as string })
  };
}

export function pickConversation(value: unknown): ConversationSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const conversationId = id(value.conversationId);
  const title = text(value.title);
  const updatedAt = timestamp(value.updatedAt);
  if (conversationId === null || title === null || updatedAt === null || flag(value.archived) === null) {
    return null;
  }
  return {
    conversationId,
    title,
    archived: value.archived === true,
    updatedAt,
    ...(optionalId(value.projectId) === undefined ? {} : { projectId: value.projectId as RemoteId }),
    ...(optionalTimestamp(value.lastMessageAt) === undefined
      ? {}
      : { lastMessageAt: value.lastMessageAt as RemoteTimestamp })
  };
}

export function pickMessage(value: unknown): MessageSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const messageId = id(value.messageId);
  const conversationId = id(value.conversationId);
  const content = text(value.content);
  const createdAt = timestamp(value.createdAt);
  const role = oneOf(value.role, ["user", "assistant", "system"] as const);
  if (messageId === null || conversationId === null || content === null || createdAt === null || role === null) {
    return null;
  }
  return {
    messageId,
    conversationId,
    role,
    content,
    createdAt,
    ...(flag(value.truncated) === null ? {} : { truncated: value.truncated === true }),
    ...(optionalId(value.runId) === undefined ? {} : { runId: value.runId as RemoteId })
  };
}

export function pickRun(value: unknown): RunSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const runId = id(value.runId);
  const conversationId = id(value.conversationId);
  const status = oneOf(value.status, ["running", "finished", "failed", "stopped"] as const);
  if (runId === null || conversationId === null || status === null) {
    return null;
  }
  return {
    runId,
    conversationId,
    status,
    ...(optionalId(value.agentId) === undefined ? {} : { agentId: value.agentId as RemoteId }),
    ...(optionalTimestamp(value.startedAt) === undefined
      ? {}
      : { startedAt: value.startedAt as RemoteTimestamp })
  };
}

export function pickDecision(value: unknown): DecisionSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const decisionId = id(value.decisionId);
  const runId = id(value.runId);
  const conversationId = id(value.conversationId);
  const summary = text(value.summary);
  const kind = oneOf(value.kind, ["permission", "authentication"] as const);
  if (decisionId === null || runId === null || conversationId === null || summary === null || kind === null) {
    return null;
  }
  return {
    decisionId,
    kind,
    runId,
    conversationId,
    summary,
    ...(optionalText(value.tool) === undefined ? {} : { tool: value.tool as string })
  };
}

export function pickTask(value: unknown): TaskSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const taskId = id(value.taskId);
  const title = text(value.title);
  const updatedAt = timestamp(value.updatedAt);
  const status = oneOf(value.status, [
    "pending",
    "running",
    "blocked",
    "completed",
    "failed",
    "cancelled"
  ] as const);
  if (taskId === null || title === null || updatedAt === null || status === null) {
    return null;
  }
  return {
    taskId,
    title,
    status,
    updatedAt,
    ...(optionalId(value.projectId) === undefined ? {} : { projectId: value.projectId as RemoteId }),
    ...(optionalId(value.conversationId) === undefined
      ? {}
      : { conversationId: value.conversationId as RemoteId })
  };
}

/**
 * Whitelisted snapshot. `baseSeq` and `host` are required by `protocol/remote/v1`; a payload
 * without them is not a snapshot this client may apply, so it is rejected as a whole.
 */
export function pickSnapshotPayload(value: unknown): SnapshotPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const host = pickHostStatus(value.host);
  if (
    host === null ||
    typeof value.baseSeq !== "number" ||
    !Number.isSafeInteger(value.baseSeq) ||
    value.baseSeq < 0
  ) {
    return null;
  }
  return {
    baseSeq: value.baseSeq,
    host,
    ...(list(value.projects) === null ? {} : { projects: [...pickArray(value.projects, pickProject)] }),
    ...(list(value.agents) === null ? {} : { agents: [...pickArray(value.agents, pickAgent)] }),
    ...(list(value.conversations) === null
      ? {}
      : { conversations: [...pickArray(value.conversations, pickConversation)] }),
    ...(list(value.activeRuns) === null ? {} : { activeRuns: [...pickArray(value.activeRuns, pickRun)] }),
    ...(list(value.pendingDecisions) === null
      ? {}
      : { pendingDecisions: [...pickArray(value.pendingDecisions, pickDecision)] }),
    ...(list(value.activeTasks) === null ? {} : { activeTasks: [...pickArray(value.activeTasks, pickTask)] })
  };
}

export function pickConversationId(value: unknown): RemoteId | null {
  if (!isRecord(value)) {
    return null;
  }
  return id(value.conversationId);
}
