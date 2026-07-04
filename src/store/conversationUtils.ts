import type { CliStreamItem } from "@/services/cli/parsers";
import type { CLIMember } from "@/config/aiMembers";
import type { Conversation, ConversationMessage } from "@/services/cli/types";

type ToolResultItem = Extract<CliStreamItem, { kind: "tool-result" }>;
type CommandItem = Extract<CliStreamItem, { kind: "command" }>;
type PlanItem = Extract<CliStreamItem, { kind: "plan" }>;
type PlanEntry = PlanItem["entries"][number];
type ToolCallItem = Extract<CliStreamItem, { kind: "tool-call" }>;

function mergeStreamText(
  prev: Extract<CliStreamItem, { kind: "text" }>,
  next: Extract<CliStreamItem, { kind: "text" }>
): Extract<CliStreamItem, { kind: "text" }> {
  if (next.append) {
    return { ...prev, content: prev.content + next.content };
  }
  if (next.content === prev.content) return prev;
  if (next.content.startsWith(prev.content)) {
    return { ...prev, content: next.content };
  }
  return { ...prev, ...next };
}

function mergeStreamThinking(
  prev: Extract<CliStreamItem, { kind: "thinking" }>,
  next: Extract<CliStreamItem, { kind: "thinking" }>
): Extract<CliStreamItem, { kind: "thinking" }> {
  if (next.append) {
    return { ...prev, content: prev.content + next.content };
  }
  if (next.content === prev.content) return prev;
  if (next.content.startsWith(prev.content)) {
    return { ...prev, content: next.content };
  }
  return { ...prev, ...next };
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
      }
    } catch {
      /* ignore malformed snapshots */
    }
  }
  return [...ids];
}

export function mergeToolCalls(prev: ToolCallItem, next: ToolCallItem): ToolCallItem {
  const merged: ToolCallItem = {
    kind: "tool-call",
    id: prev.id!,
    tool: next.tool || prev.tool
  };

  const input = next.input !== undefined ? next.input : prev.input;
  if (input !== undefined) merged.input = input;

  const status = next.status ?? prev.status;
  if (status !== undefined) merged.status = status;

  const toolKind = next.toolKind ?? prev.toolKind;
  if (toolKind !== undefined) merged.toolKind = toolKind;

  const locations = next.locations ?? prev.locations;
  if (locations !== undefined) merged.locations = locations;

  const output = next.output !== undefined ? next.output : prev.output;
  if (output !== undefined) merged.output = output;

  const isError = next.isError ?? prev.isError;
  if (isError !== undefined) merged.isError = isError;

  if (next.toolOutputs) {
    merged.toolOutputs = next.replaceToolOutputs
      ? next.toolOutputs
      : [...(prev.toolOutputs ?? []), ...next.toolOutputs];
  } else if (prev.toolOutputs) {
    merged.toolOutputs = prev.toolOutputs;
  }

  return merged;
}

function toolResultKey(item: ToolResultItem) {
  return `${item.tool}\u0000${item.content.trim()}`;
}

export function dedupeToolResults(results: ToolResultItem[]): ToolResultItem[] {
  const seen = new Set<string>();
  const out: ToolResultItem[] = [];

  for (const result of results) {
    if (!result.content.trim()) {
      out.push(result);
      continue;
    }
    const key = toolResultKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }

  return out;
}

export function dedupeCommands(commands: CommandItem[]): CommandItem[] {
  const seen = new Set<string>();
  const out: CommandItem[] = [];

  for (const command of commands) {
    const key = command.command.trim();
    if (!key) {
      out.push(command);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(command);
  }

  return out;
}

function planPriority(value: unknown): PlanEntry["priority"] {
  return value === "high" || value === "low" ? value : "medium";
}

function planStatus(value: unknown): PlanEntry["status"] {
  return value === "in_progress" || value === "completed"
    ? value
    : "pending";
}

function normalizePlanEntries(entries: unknown): PlanEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      const item = entry as {
        content?: unknown;
        priority?: unknown;
        status?: unknown;
      };
      return {
        content: typeof item.content === "string" ? item.content.trim() : "",
        priority: planPriority(item.priority),
        status: planStatus(item.status)
      };
    })
    .filter((entry) => entry.content.length > 0);
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function legacyTodoPlan(item: CliStreamItem): PlanItem | undefined {
  if (item.kind === "tool-call") {
    const input = item.input as { todos?: unknown } | undefined;
    const entries = normalizePlanEntries(input?.todos);
    return entries.length ? { kind: "plan", entries } : undefined;
  }

  if (item.kind === "tool-result") {
    const raw = parseJsonObject(item.content);
    const metadata = raw?.metadata as { todos?: unknown } | undefined;
    const entries = normalizePlanEntries(metadata?.todos ?? raw?.todos);
    return entries.length ? { kind: "plan", entries } : undefined;
  }

  return undefined;
}

export function appendItems(
  prev: CliStreamItem[],
  next: CliStreamItem[]
): CliStreamItem[] {
  if (!next.length) return prev;
  const out = [...prev];
  for (const rawItem of next) {
    const item = legacyTodoPlan(rawItem) ?? rawItem;
    const last = out[out.length - 1];
    if (item.kind === "text" && item.messageId) {
      const index = out.findIndex(
        (previous) =>
          previous.kind === "text" &&
          previous.messageId === item.messageId &&
          previous.role === item.role
      );
      if (index >= 0) {
        const previous = out[index] as Extract<CliStreamItem, { kind: "text" }>;
        out[index] = mergeStreamText(previous, item);
        continue;
      }
    }
    if (item.kind === "thinking" && item.messageId) {
      const index = out.findIndex(
        (previous) =>
          previous.kind === "thinking" && previous.messageId === item.messageId
      );
      if (index >= 0) {
        const previous = out[index] as Extract<CliStreamItem, { kind: "thinking" }>;
        out[index] = mergeStreamThinking(previous, item);
        continue;
      }
    }
    if (item.kind === "terminal-embed") {
      const index = out.findIndex(
        (previous) =>
          previous.kind === "terminal-embed" &&
          previous.terminalId === item.terminalId
      );
      if (index >= 0) {
        out[index] = { ...out[index], ...item };
        continue;
      }
    }
    if (
      item.kind === "text" &&
      last &&
      last.kind === "text" &&
      last.role === item.role
    ) {
      if (item.append) {
        out[out.length - 1] = { ...last, content: last.content + item.content };
        continue;
      }
      if (item.content === last.content) continue;
      if (item.content.startsWith(last.content)) {
        out[out.length - 1] = { ...last, content: item.content };
        continue;
      }
    }
    if (
      item.kind === "thinking" &&
      last &&
      last.kind === "thinking"
    ) {
      if (item.append) {
        out[out.length - 1] = { ...last, content: last.content + item.content };
        continue;
      }
      if (item.content === last.content) continue;
      if (item.content.startsWith(last.content)) {
        out[out.length - 1] = { ...last, content: item.content };
        continue;
      }
    }
    if (
      item.kind === "error" &&
      last &&
      last.kind === "error" &&
      last.message === item.message
    ) {
      continue;
    }
    if (item.kind === "plan") {
      const planIndex = out.findIndex((previous) => previous.kind === "plan");
      if (planIndex >= 0) {
        out[planIndex] = item;
        continue;
      }
    }
    if (item.kind === "available-commands") {
      const index = out.findIndex((previous) => previous.kind === "available-commands");
      if (index >= 0) {
        out[index] = item;
        continue;
      }
    }
    if (item.kind === "config-options") {
      const index = out.findIndex((previous) => previous.kind === "config-options");
      if (index >= 0) {
        out[index] = item;
        continue;
      }
    }
    if (item.kind === "tool-call" && item.id) {
      const toolIndex = out.findIndex(
        (previous) => previous.kind === "tool-call" && previous.id === item.id
      );
      if (toolIndex >= 0) {
        out[toolIndex] = mergeToolCalls(out[toolIndex] as ToolCallItem, item);
        continue;
      }
    }
    if (
      item.kind === "command-output" &&
      last &&
      last.kind === "command-output" &&
      last.stream === item.stream
    ) {
      out[out.length - 1] = {
        ...last,
        content: `${last.content}\n${item.content}`
      };
      continue;
    }
    if (item.kind === "command" && item.command.trim()) {
      const trailingCommands: CommandItem[] = [];
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const previous = out[i];
        if (previous.kind === "tool-call") break;
        if (previous.kind !== "command") break;
        trailingCommands.unshift(previous);
      }
      if (dedupeCommands([...trailingCommands, item]).length === trailingCommands.length) {
        continue;
      }
    }
    if (
      item.kind === "tool-result" &&
      last &&
      last.kind === "tool-result" &&
      last.tool === item.tool &&
      ((last.id && item.id && last.id === item.id) || (!last.id && !item.id))
    ) {
      if (!item.content.trim() && last.content.trim()) continue;
      if (item.content === last.content) continue;
      out[out.length - 1] = {
        ...last,
        ...item,
        ...(item.isError ?? last.isError
          ? { isError: item.isError ?? last.isError }
          : {})
      };
      continue;
    }
    if (item.kind === "tool-result" && item.content.trim()) {
      const trailingResults: ToolResultItem[] = [];
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const previous = out[i];
        if (previous.kind === "tool-call") break;
        if (previous.kind !== "tool-result") break;
        trailingResults.unshift(previous);
      }
      if (dedupeToolResults([...trailingResults, item]).length === trailingResults.length) {
        continue;
      }
    }
    out.push(item);
  }
  return out;
}

export function plainAssistantText(items: CliStreamItem[]): string {
  return items
    .filter((i) => i.kind === "text" && i.role === "assistant")
    .map((i) => (i as Extract<CliStreamItem, { kind: "text" }>).content)
    .join("\n")
    .trim();
}

export function defaultTitleFor(member: CLIMember, cwd?: string): string {
  const tail = cwd
    ? cwd.split(/[/\\]/).filter(Boolean).slice(-1)[0]
    : undefined;
  return tail ? `${member.name} · ${tail}` : member.name;
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

function normalizeTitleText(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function defaultTitleForConversation(
  conversation: Pick<Conversation, "agentName" | "cwd">
): string {
  const tail = conversation.cwd
    ? conversation.cwd.split(/[/\\]/).filter(Boolean).slice(-1)[0]
    : undefined;
  return tail ? `${conversation.agentName} · ${tail}` : conversation.agentName;
}

export function shouldApplyAgentSessionTitle(
  conversation: Pick<Conversation, "title"> &
    Partial<Pick<Conversation, "agentName" | "cwd">>,
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
  if (messages.some((message) => Boolean(message.workflowRunId))) return false;
  if (!conversation.agentName) return true;
  return conversation.title ===
    defaultTitleForConversation({
      agentName: conversation.agentName,
      cwd: conversation.cwd
    });
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
    if (
      previous.status === message.status &&
      previous.content === message.content &&
      previous.updatedAt === message.updatedAt &&
      previous.attachments === attachments
    ) {
      continue;
    }
    byId.set(message.id, {
      ...previous,
      ...message,
      attachments
    });
    changed = true;
  }
  if (!changed && byId.size !== existing.length) changed = true;
  if (!changed) return existing;
  return Array.from(byId.values()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
}
