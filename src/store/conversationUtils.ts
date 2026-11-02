import { IPC_LIST_MESSAGES_PAGE_SIZE, serializeStreamItemsForPersist, plainAssistantText } from "@freebuddy/cli-stream";
import type { CliStreamItem } from "@freebuddy/cli-stream";
import type { CLIMember } from "@/config/aiMembers";
import type {
  Conversation,
  ConversationMessage,
  ConversationTitleSource
} from "@/services/cli/types";

export type { ConversationTitleSource };

export {
  appendItems,
  dedupeCommands,
  dedupeToolResults,
  MAX_MERGED_ASSISTANT_CHARS,
  MAX_MERGED_OUTPUT_CHARS,
  mergeToolCalls,
  plainAssistantText
} from "@freebuddy/cli-stream";

export const MAX_PERSISTED_STREAM_JSON_CHARS = 400_000;
export const INITIAL_VISIBLE_MESSAGES = IPC_LIST_MESSAGES_PAGE_SIZE;
export const VISIBLE_MESSAGE_STEP = IPC_LIST_MESSAGES_PAGE_SIZE;
const MERGED_STREAM_TRUNCATION_MARKER = "\n… [stream truncated] …\n";

export function visibleConversationSlice<T>(
  messages: readonly T[],
  visibleCount: number
): { hiddenCount: number; items: T[] } {
  if (visibleCount <= 0 || messages.length <= visibleCount) {
    return { hiddenCount: 0, items: [...messages] };
  }
  const hiddenCount = messages.length - visibleCount;
  return { hiddenCount, items: messages.slice(hiddenCount) };
}

/** Shared with delegate saves: valid JSON, bounded size, recent output retained. */
export function capPersistedStreamItems(
  items: CliStreamItem[],
  maxChars = MAX_PERSISTED_STREAM_JSON_CHARS
): CliStreamItem[] {
  return JSON.parse(serializeStreamItemsForPersist(items, maxChars)) as CliStreamItem[];
}

export function collectStreamMessageIds(
  messages: ConversationMessage[]
): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    try {
      const parsed = JSON.parse(message.content);
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed as CliStreamItem[]) {
        if (
          (item.kind === "text" || item.kind === "thinking") &&
          typeof item.messageId === "string" &&
          item.messageId.length > 0
        ) {
          ids.add(item.messageId);
        }
        if (
          item.kind === "tool-call" &&
          typeof item.id === "string" &&
          item.id.length > 0
        ) {
          ids.add(item.id);
        }
      }
    } catch {
      /* ignore malformed snapshots */
    }
  }
  return [...ids];
}

/**
 * Agent-chunk messageIds only (text/thinking), excluding tool-call ids.
 *
 * Used to detect adapters (e.g. Qoder) that stream live agent chunks WITHOUT a
 * messageId and only attach messageIds when replaying history on resume. When a
 * resumed session has zero persisted agent messageIds, FreeBuddy can safely
 * treat messageId-carrying chunks that arrive before any live chunk as replay.
 */
export function collectStreamAgentMessageIds(
  messages: ConversationMessage[]
): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    try {
      const parsed = JSON.parse(message.content);
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed as CliStreamItem[]) {
        if (
          (item.kind === "text" || item.kind === "thinking") &&
          typeof item.messageId === "string" &&
          item.messageId.length > 0
        ) {
          ids.add(item.messageId);
        }
      }
    } catch {
      /* ignore malformed snapshots */
    }
  }
  return [...ids];
}

export function normalizeReplaySignature(text: string): string {
  return text.trim();
}

export function collectStreamContentSignatures(
  messages: ConversationMessage[]
): string[] {
  const signatures = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = normalizeReplaySignature(value);
    if (normalized.length > 0) signatures.add(normalized);
  };
  for (const message of messages) {
    // Replay suppression is applied only to agent message/thought chunks.
    // User text must not cross-match and hide a live assistant chunk.
    if (message.role !== "assistant") continue;
    try {
      const parsed = JSON.parse(message.content);
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed as CliStreamItem[]) {
        if (item.kind === "text" || item.kind === "thinking") {
          add(item.content);
        }
      }
    } catch {
      /* ignore malformed snapshots */
    }
  }
  return [...signatures];
}

function assistantErrorSummary(items: CliStreamItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "error" && item.message.trim()) {
      return item.message.trim();
    }
  }
  return undefined;
}

function truncateFollowupBlock(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}\n[truncated]`;
}

/**
 * When FreeBuddy cannot resume an agent tool session (e.g. the previous turn
 * failed before a session id existed), inject recent conversation history so
 * a short follow-up like "continue" still has the unanswered user question.
 */
export function buildOrphanFollowupContext(
  messages: ConversationMessage[],
  options: {
    excludeMessageIds?: Iterable<string>;
    maxChars?: number;
    maxTurns?: number;
  } = {}
): string | undefined {
  const exclude = new Set(options.excludeMessageIds ?? []);
  const maxChars = options.maxChars ?? 6000;
  const maxTurns = options.maxTurns ?? 12;

  const prior = messages.filter((message) => {
    if (exclude.has(message.id)) return false;
    if (message.role === "assistant" && message.status === "running") {
      return false;
    }
    return message.role === "user" || message.role === "assistant";
  });
  if (prior.length === 0) return undefined;

  const recent = prior.slice(-maxTurns);
  const blocks: string[] = [];
  let hadUnansweredUser = false;

  for (const message of recent) {
    if (message.role === "user") {
      const text = message.content.trim();
      if (!text) continue;
      blocks.push(`User:\n${truncateFollowupBlock(text, 1500)}`);
      hadUnansweredUser = true;
      continue;
    }

    let items: CliStreamItem[] = [];
    try {
      const parsed = JSON.parse(message.content);
      if (Array.isArray(parsed)) items = parsed as CliStreamItem[];
    } catch {
      items = [];
    }
    const text = plainAssistantText(items);
    const error = assistantErrorSummary(items);
    if (text) {
      blocks.push(`Assistant:\n${truncateFollowupBlock(text, 2000)}`);
      hadUnansweredUser = false;
    } else if (error || message.status === "failed" || message.status === "killed") {
      blocks.push(
        `Assistant:\n[previous turn ${message.status === "killed" ? "interrupted" : "failed"}${
          error ? `: ${truncateFollowupBlock(error, 400)}` : ""
        }]`
      );
    } else if (message.content.trim() && !message.content.trim().startsWith("[")) {
      blocks.push(`Assistant:\n${truncateFollowupBlock(message.content, 2000)}`);
      hadUnansweredUser = false;
    }
  }

  if (blocks.length === 0) return undefined;

  const lines = [
    "You are continuing a FreeBuddy conversation, but there is no resumable agent session (the previous turn may have failed before a session was created).",
    "Use the prior messages below as the source of truth for what the user already asked.",
    hadUnansweredUser
      ? "The latest user question below was not successfully answered. If the current follow-up is a short continue/retry request, answer that unanswered question."
      : "Answer the current follow-up in light of this history.",
    "",
    "Prior conversation:"
  ];
  const header = lines.join("\n");
  let remaining = Math.max(0, maxChars - header.length - 1);
  const kept: string[] = [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const cost = block.length + (kept.length ? 1 : 0);
    if (cost > remaining) {
      if (kept.length === 0 && remaining > 12) {
        kept.push(truncateFollowupBlock(block, remaining - 12));
      }
      break;
    }
    kept.push(block);
    remaining -= cost;
  }
  // Spend the budget on the newest turns; truncating the joined history from
  // its beginning could discard the very question a retry needs to answer.
  return `${header}\n${kept.reverse().join("\n")}`.slice(0, maxChars);
}

export function composeOrphanFollowupPrompt(
  followup: string,
  context: string | undefined
): string {
  if (!context) return followup;
  return `${context}\n\nUser follow-up:\n${followup}`;
}

export function defaultTitleFor(member: CLIMember, cwd?: string): string {
  const tail = cwd
    ? cwd.split(/[/\\]/).filter(Boolean).slice(-1)[0]
    : undefined;
  return tail ? `${member.name} · ${tail}` : member.name;
}

export const USER_CONVERSATION_TITLE_MAX = 80;

export function sanitizeUserConversationTitle(value: string): string {
  return Array.from(value.replace(/\s+/g, " ").trim())
    .slice(0, USER_CONVERSATION_TITLE_MAX)
    .join("");
}

export function buildConversationTitle(input: {
  prompt?: string;
  attachmentName?: string;
  fallback: string;
  maxLength?: number;
}): string {
  const maxLength = input.maxLength ?? 80;
  const source =
    normalizeTitleText(input.prompt) ||
    normalizeTitleText(input.attachmentName) ||
    normalizeTitleText(input.fallback) ||
    "New chat";
  return Array.from(source).slice(0, maxLength).join("");
}

export function buildDelegationConversationTitle(
  teamName: string,
  goal: string,
  maxLength = 80
): string {
  const task = isInternalSkillAnnouncementTitle(goal) ? "" : goal;
  return buildConversationTitle({
    prompt: task,
    fallback: teamName,
    maxLength
  });
}

function normalizeTitleText(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

export function isInternalSkillAnnouncementTitle(
  title: string | undefined
): boolean {
  const normalized = normalizeTitleText(title);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (lower.includes("[freebuddy active skills]")) return true;
  if (lower.includes("freebuddy-skills mcp")) return true;
  if (lower.includes("self-organizing delegation")) return true;
  return /^[-\s]*delegation\s+\([^)]+\):/i.test(normalized);
}

export function isDelegationSkillAnnouncementTitle(
  title: string | undefined
): boolean {
  const normalized = normalizeTitleText(title);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (lower.includes("self-organizing delegation")) return true;
  if (/^[-\s]*delegation\s+\([^)]+\):/i.test(normalized)) return true;
  return (
    lower.includes("[freebuddy active skills]") && /\bdelegation\b/.test(lower)
  );
}

export function isDelegationConversation(
  conversation: Pick<Conversation, "kind" | "title">
): boolean {
  return (
    conversation.kind === "delegation" ||
    isDelegationSkillAnnouncementTitle(conversation.title)
  );
}

function defaultTitleForConversation(
  conversation: Pick<Conversation, "agentName" | "cwd">
): string {
  const tail = conversation.cwd
    ? conversation.cwd.split(/[/\\]/).filter(Boolean).slice(-1)[0]
    : undefined;
  return tail ? `${conversation.agentName} · ${tail}` : conversation.agentName;
}

export function displayConversationTitle(
  conversation: Pick<Conversation, "title" | "agentName" | "cwd" | "titleSource">,
  fallback?: string
): string {
  const title = normalizeTitleText(conversation.title);
  if (conversation.titleSource === "user" && title) return title;
  if (title && !isInternalSkillAnnouncementTitle(title)) return title;
  const recovered = defaultTitleForConversation(conversation);
  return (
    normalizeTitleText(fallback) ||
    normalizeTitleText(recovered) ||
    title ||
    "New chat"
  );
}

export function recoverConversationTitleFromMessages(
  conversation: ConversationForTitleSource,
  messages: Pick<ConversationMessage, "role" | "content">[]
): string | undefined {
  if (!isInternalSkillAnnouncementTitle(conversation.title)) return undefined;
  if (inferConversationTitleSource(conversation) === "user") return undefined;
  const firstUser = messages.find(
    (message) => message.role === "user" && normalizeTitleText(message.content)
  );
  const recovered = buildConversationTitle({
    prompt: firstUser?.content,
    fallback: defaultTitleForConversation(conversation)
  });
  if (!recovered || recovered === conversation.title) return undefined;
  if (isInternalSkillAnnouncementTitle(recovered)) return undefined;
  return recovered;
}

type ConversationForTitleSource = Pick<
  Conversation,
  "title" | "agentName" | "cwd" | "titleSource"
>;

export function inferConversationTitleSource(
  conversation: ConversationForTitleSource
): ConversationTitleSource {
  if (conversation.titleSource) return conversation.titleSource;
  if (!conversation.agentName) return "prompt";
  const defaultTitle = defaultTitleForConversation({
    agentName: conversation.agentName,
    cwd: conversation.cwd
  });
  return conversation.title === defaultTitle ? "default" : "prompt";
}

export function shouldApplyAgentSessionTitle(
  conversation: ConversationForTitleSource,
  messagesOrTitle:
    | Pick<ConversationMessage, "workflowRunId">[]
    | string
    | undefined,
  maybeTitle?: string
): boolean {
  const messages = Array.isArray(messagesOrTitle) ? messagesOrTitle : [];
  const title = normalizeTitleText(
    Array.isArray(messagesOrTitle) ? maybeTitle : messagesOrTitle
  );
  if (!title || conversation.title === title) return false;
  if (isInternalSkillAnnouncementTitle(title)) return false;
  if (messages.some((message) => Boolean(message.workflowRunId))) return false;
  const source = inferConversationTitleSource(conversation);
  return source === "default" || source === "prompt";
}

function clipConversationTitle(value: string, max = 80): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}...`;
}

function feedArticleTitleFromPrompt(content: string): string | undefined {
  const match =
    content.match(/(?:^|\n)\s*\u6587\u7ae0\u6807\u9898[:\uff1a]\s*([^\n\r]+)/) ??
    content.match(/(?:^|\n)\s*Article title:\s*([^\n\r]+)/i);
  const title = match?.[1]?.trim();
  return title ? clipConversationTitle(title) : undefined;
}

export function feedArticleTitleFromMessages(
  messages: Pick<ConversationMessage, "role" | "content">[]
): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const title = feedArticleTitleFromPrompt(message.content);
    if (title) return title;
  }
  return undefined;
}

function mergeMessageAttachments(
  preferred: ConversationMessage | undefined,
  fallback: ConversationMessage | undefined
): ConversationMessage["attachments"] | undefined {
  if (preferred?.attachments?.length) return preferred.attachments;
  if (fallback?.attachments?.length) return fallback.attachments;
  return preferred?.attachments ?? fallback?.attachments;
}

export function upsertConversationMessage(
  messages: ConversationMessage[],
  message: ConversationMessage
): ConversationMessage[] {
  const index = messages.findIndex((entry) => entry.id === message.id);
  if (index < 0) return [...messages, message];
  const previous = messages[index];
  const next = [...messages];
  next[index] = {
    ...previous,
    ...message,
    skillSnapshot: message.skillSnapshot ?? previous.skillSnapshot,
    attachments: mergeMessageAttachments(message, previous)
  };
  return next;
}

export function mergeConversationMessages(
  existing: ConversationMessage[],
  loaded: ConversationMessage[]
): ConversationMessage[] {
  const byId = new Map<string, ConversationMessage>();
  let changed = false;
  for (const message of existing) {
    byId.set(message.id, message);
  }
  for (const message of loaded) {
    const previous = byId.get(message.id);
    if (!previous) {
      byId.set(message.id, message);
      changed = true;
      continue;
    }
    const attachments = mergeMessageAttachments(message, previous);
    const skillSnapshot = message.skillSnapshot ?? previous.skillSnapshot;
    const sequence = message.sequence ?? previous.sequence;
    if (
      previous.createdAt === message.createdAt &&
      previous.sequence === sequence &&
      previous.status === message.status &&
      previous.content === message.content &&
      previous.updatedAt === message.updatedAt &&
      previous.attachments === attachments &&
      previous.skillSnapshot === skillSnapshot
    ) {
      continue;
    }
    byId.set(message.id, {
      ...previous,
      ...message,
      sequence,
      skillSnapshot,
      attachments
    });
    changed = true;
  }
  if (!changed && byId.size !== existing.length) changed = true;
  if (!changed) return existing;
  return Array.from(byId.values()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) ||
    (a.sequence !== undefined && b.sequence !== undefined
      ? a.sequence - b.sequence : 0)
  );
}
