import type { ConversationMessage } from "./conversations.js";

/** Matches renderer persist cap so a single IPC message stays cloneable. */
export const MAX_IPC_MESSAGE_CONTENT_CHARS = 400_000;
/** Keep the full list under Chromium's structured-clone CHECK range. */
export const MAX_IPC_LIST_MESSAGES_CHARS = 16 * 1024 * 1024;
/** Opening a conversation only hydrates the newest page over IPC. */
export const IPC_LIST_MESSAGES_PAGE_SIZE = 40;
const MAX_STREAM_STRING_CHARS = 12_000;
const MAX_ASSISTANT_TEXT_CHARS = 200_000;
const TRUNCATION_MARKER = "\n… [truncated]";
const OMITTED_TEXT = "… [message omitted: too large to load] …";
const DATA_URL_RE =
  /data:(?:image|video|audio|application)\/[a-z0-9.+*-]+;base64,[a-zA-Z0-9+/=\s]+/gi;
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATE_REPLACE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function stripLoneSurrogates(value: string): string {
  return LONE_SURROGATE_RE.test(value)
    ? value.replace(LONE_SURROGATE_REPLACE_RE, "\uFFFD")
    : value;
}

function stripDataUrls(value: string): string {
  if (!value.includes("base64,")) return value;
  return value.replace(DATA_URL_RE, "[inline media removed]");
}

function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  const available = Math.max(0, max - TRUNCATION_MARKER.length);
  return `${value.slice(0, available)}${TRUNCATION_MARKER}`;
}

function capRawString(value: string, max = MAX_IPC_MESSAGE_CONTENT_CHARS): string {
  return truncateChars(stripDataUrls(stripLoneSurrogates(value)), max);
}

function omittedContent(role: ConversationMessage["role"]): string {
  if (role === "assistant") {
    return JSON.stringify([{ kind: "text", content: OMITTED_TEXT }]);
  }
  return OMITTED_TEXT;
}

function compactUnknown(value: unknown, max = MAX_STREAM_STRING_CHARS): unknown {
  if (typeof value === "string") return capRawString(value, max);
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > max ? truncateChars(serialized, max) : value;
  } catch {
    return OMITTED_TEXT;
  }
}

function compactStreamItem(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const rec = item as Record<string, unknown>;
  const kind = rec.kind;
  if (kind === "tool-call") {
    const next: Record<string, unknown> = { ...rec };
    delete next.input;
    if (typeof next.output === "string") {
      next.output = capRawString(next.output, MAX_STREAM_STRING_CHARS);
    }
    if (Array.isArray(next.toolOutputs)) {
      next.toolOutputs = next.toolOutputs.map(compactStreamItem);
    }
    return next;
  }
  if (kind === "file-edit") {
    const next: Record<string, unknown> = { ...rec };
    for (const key of ["patch", "oldText", "newText"]) {
      if (typeof next[key] === "string") {
        next[key] = capRawString(next[key] as string, MAX_STREAM_STRING_CHARS);
      }
    }
    return next;
  }
  if (kind === "text" || kind === "thinking") {
    if (typeof rec.content !== "string") return rec;
    return {
      ...rec,
      content: capRawString(rec.content, MAX_ASSISTANT_TEXT_CHARS)
    };
  }
  const next: Record<string, unknown> = { ...rec };
  for (const [key, value] of Object.entries(next)) {
    if (key === "kind") continue;
    if (typeof value === "string") {
      next[key] = capRawString(value, MAX_STREAM_STRING_CHARS);
    } else if (value && typeof value === "object") {
      next[key] = compactUnknown(value);
    }
  }
  return next;
}

function keepEssentialStreamItem(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const kind = (item as { kind?: unknown }).kind;
  return (
    kind === "text" ||
    kind === "thinking" ||
    kind === "error" ||
    kind === "done" ||
    kind === "usage" ||
    kind === "session"
  );
}

function fitJsonArrayToBudget(items: unknown[], max: number): string {
  let serialized = JSON.stringify(items);
  if (serialized.length <= max) return serialized;

  let lo = 1;
  let hi = items.length;
  let best = items.slice(-1);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const slice = items.slice(-mid);
    const next = JSON.stringify(slice);
    if (next.length <= max) {
      best = slice;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  serialized = JSON.stringify(best);
  if (serialized.length <= max) return serialized;

  const last = best[0];
  if (last && typeof last === "object" && !Array.isArray(last)) {
    const rec: Record<string, unknown> = { ...(last as Record<string, unknown>) };
    const raw =
      typeof rec.content === "string" ? rec.content : JSON.stringify(rec);
    rec.kind = rec.kind ?? "text";
    const emptyWrap = JSON.stringify([{ ...rec, content: "" }]);
    const available = Math.max(
      0,
      max - emptyWrap.length - TRUNCATION_MARKER.length
    );
    rec.content = `${raw.slice(Math.max(0, raw.length - available))}${TRUNCATION_MARKER}`;
    serialized = JSON.stringify([rec]);
    if (serialized.length <= max) return serialized;
  }

  return JSON.stringify([
    {
      kind: "text",
      content: truncateChars(
        typeof last === "string" ? last : "…",
        Math.max(32, max - 40)
      )
    }
  ]);
}

function capStreamJson(items: unknown[]): string {
  const compacted = items.map(compactStreamItem);
  let serialized = JSON.stringify(compacted);
  if (serialized.length <= MAX_IPC_MESSAGE_CONTENT_CHARS) return serialized;

  const essential = compacted.filter(keepEssentialStreamItem);
  let extras = compacted.filter((item) => !keepEssentialStreamItem(item));
  serialized = JSON.stringify([...essential, ...extras]);
  while (
    extras.length > 0 &&
    serialized.length > MAX_IPC_MESSAGE_CONTENT_CHARS
  ) {
    extras = extras.slice(1);
    serialized = JSON.stringify([...essential, ...extras]);
  }
  if (serialized.length <= MAX_IPC_MESSAGE_CONTENT_CHARS) return serialized;
  return fitJsonArrayToBudget(essential, MAX_IPC_MESSAGE_CONTENT_CHARS);
}

function contentNeedsSanitize(content: string): boolean {
  return (
    content.length > MAX_IPC_MESSAGE_CONTENT_CHARS ||
    content.includes("base64,") ||
    LONE_SURROGATE_RE.test(content)
  );
}

export function sanitizeMessageContent(
  content: string,
  role: ConversationMessage["role"]
): string {
  if (typeof content !== "string") return omittedContent(role);
  // JSON.parse / regex over multi-megabyte blobs freeze the Electron main
  // process (macOS shows a spinning wait cursor). Slice first, and never
  // parse a payload that already exceeds the IPC cap.
  if (content.length > MAX_IPC_MESSAGE_CONTENT_CHARS) {
    if (role === "assistant") return omittedContent(role);
    return capRawString(content.slice(0, MAX_IPC_MESSAGE_CONTENT_CHARS));
  }
  if (role !== "assistant") {
    return contentNeedsSanitize(content)
      ? capRawString(content)
      : content;
  }
  if (!contentNeedsSanitize(content)) return content;

  const normalized = stripLoneSurrogates(content);
  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) return capStreamJson(parsed);
  } catch {
    /* fall through to raw cap */
  }
  return capRawString(normalized);
}

/** Cap live stream items before writing them to SQLite. */
export function serializeStreamItemsForPersist(items: unknown[]): string {
  return capStreamJson(Array.isArray(items) ? items : []);
}

export function sanitizeMessageForIpc(
  message: ConversationMessage
): ConversationMessage {
  const content = sanitizeMessageContent(message.content, message.role);
  if (content === message.content) return message;
  return { ...message, content };
}

export function sanitizeMessagesForIpc(
  messages: ConversationMessage[]
): ConversationMessage[] {
  const sanitized = messages.map(sanitizeMessageForIpc);
  let budget = MAX_IPC_LIST_MESSAGES_CHARS;
  const out = new Array<ConversationMessage>(sanitized.length);
  for (let index = sanitized.length - 1; index >= 0; index -= 1) {
    const entry = sanitized[index];
    const size = entry.content.length;
    if (size <= budget) {
      out[index] = entry;
      budget -= size;
      continue;
    }
    out[index] = { ...entry, content: omittedContent(entry.role) };
    budget = Math.max(0, budget - out[index].content.length);
  }
  return out;
}
