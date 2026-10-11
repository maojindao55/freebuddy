/** Matches renderer persist cap so a single IPC message stays cloneable. */
export const MAX_IPC_MESSAGE_CONTENT_CHARS = 400_000;
/** Keep the full list under Chromium's structured-clone CHECK range. */
export const MAX_IPC_LIST_MESSAGES_CHARS = 16 * 1024 * 1024;
/** Opening a conversation only hydrates the newest page over IPC. */
export const IPC_LIST_MESSAGES_PAGE_SIZE = 40;
const MAX_STREAM_STRING_CHARS = 12_000;
const MAX_ASSISTANT_TEXT_CHARS = 200_000;
const MAX_INLINE_IMAGE_BASE64 = 48 * 1024;
const TRUNCATION_MARKER = "\n… [truncated]";
const OMITTED_TEXT = "… [message omitted: too large to load] …";
export const OMITTED_ASSISTANT_CONTENT = JSON.stringify([
  { kind: "text", content: OMITTED_TEXT }
]);
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

function capAssistantString(value: string): string {
  const text = stripDataUrls(stripLoneSurrogates(value));
  if (text.length <= MAX_ASSISTANT_TEXT_CHARS) return text;
  const available = MAX_ASSISTANT_TEXT_CHARS - TRUNCATION_MARKER.length;
  const head = Math.floor(available * 0.6);
  return text.slice(0, head) + TRUNCATION_MARKER + text.slice(-(available - head));
}

function omittedContent(role: "user" | "assistant" | "system"): string {
  if (role === "assistant") {
    return OMITTED_ASSISTANT_CONTENT;
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
    return serialized.length > max ? capRawString(serialized, max) : value;
  } catch {
    return OMITTED_TEXT;
  }
}

function compactStreamItem(item: unknown, maxString = MAX_STREAM_STRING_CHARS): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const rec = item as Record<string, unknown>;
  const kind = rec.kind;
  if (kind === "content-block" && rec.blockType === "image" && typeof rec.data === "string") {
    if (rec.data.length > MAX_INLINE_IMAGE_BASE64) {
      return { kind: "raw", content: "… [inline image omitted from conversation snapshot: too large] …" };
    }
    // Base64 must remain complete; text truncation would persist a broken image.
    return { ...rec };
  }
  if (kind === "tool-call") {
    const next: Record<string, unknown> = { ...rec };
    if (next.input !== undefined) {
      next.input = compactUnknown(next.input, maxString);
    }
    if (typeof next.output === "string") {
      next.output = capRawString(next.output, maxString);
    }
    if (Array.isArray(next.toolOutputs)) {
      next.toolOutputs = next.toolOutputs.map((item) => compactStreamItem(item, maxString));
    }
    return next;
  }
  if (kind === "file-edit") {
    const next: Record<string, unknown> = { ...rec };
    for (const key of ["patch", "oldText", "newText"]) {
      if (typeof next[key] === "string") {
        next[key] = capRawString(next[key] as string, maxString);
        if (next[key] !== rec[key]) next.truncated = true;
      }
    }
    return next;
  }
  if (kind === "text" || kind === "thinking") {
    if (typeof rec.content !== "string") return rec;
    return {
      ...rec,
      content: capAssistantString(rec.content)
    };
  }
  const next: Record<string, unknown> = { ...rec };
  for (const [key, value] of Object.entries(next)) {
    if (key === "kind") continue;
    if (typeof value === "string") {
      next[key] = capRawString(value, maxString);
    } else if (value && typeof value === "object") {
      next[key] = compactUnknown(value, maxString);
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

interface SnapshotEntry {
  item: unknown;
  json: string;
  essential: boolean;
}

const STREAM_TRUNCATION_NOTICE = {
  kind: "raw", content: "… [earlier stream details truncated] …"
};
const STREAM_TRUNCATION_NOTICE_JSON = JSON.stringify(STREAM_TRUNCATION_NOTICE);

export function isTruncatedStreamNotice(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const rec = item as { kind?: string; content?: string };
  return (rec.kind === "raw" || rec.kind === "text") &&
    (rec.content === STREAM_TRUNCATION_NOTICE.content || rec.content === OMITTED_TEXT);
}

/** Fit an oversized final item using serialized lengths, including JSON escapes. */
function fitLastItemToBudget(item: unknown, max: number): string {
  const rec = item && typeof item === "object" && !Array.isArray(item)
    ? item as Record<string, unknown> : undefined;
  const key = typeof rec?.content === "string" ? "content" : "message";
  const raw = typeof rec?.[key] === "string" ? rec[key] as string : String(item ?? "");
  let base: Record<string, unknown> = rec ? { ...rec, [key]: "" } : { kind: "text", content: "" };
  if (JSON.stringify([base]).length > max) base = { kind: "text", content: "" };
  const contentKey = base.kind === "text" ? "content" : key;
  const serialize = (length: number) => JSON.stringify([
    { ...base, [contentKey]: TRUNCATION_MARKER + raw.slice(raw.length - length) }
  ]);
  let best = "[]";
  let lo = 0;
  let hi = raw.length;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const json = serialize(mid);
    if (json.length <= max) {
      best = json;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function capStreamJson(items: unknown[], max = MAX_IPC_MESSAGE_CONTENT_CHARS): string {
  // Each entry is compacted and serialized once. Dropping old updates must not
  // repeatedly serialize the complete history on the UI or Electron main thread.
  const entries: SnapshotEntry[] = items.map((item) => {
    const compacted = compactStreamItem(item, Math.max(32, Math.min(MAX_STREAM_STRING_CHARS, Math.floor(max / 8))));
    return {
      item: compacted,
      json: JSON.stringify(compacted) ?? "null",
      essential: keepEssentialStreamItem(compacted)
    };
  });
  const arraySize = (entries: SnapshotEntry[]) =>
    2 + entries.reduce((sum, entry) => sum + entry.json.length + 1, 0) -
    (entries.length ? 1 : 0);
  const serialize = (entries: SnapshotEntry[]) =>
    `[${entries.map((entry) => entry.json).join(",")}]`;
  if (arraySize(entries) <= max) return serialize(entries);

  const essential = entries.filter((entry) => entry.essential);
  const noticeCost = STREAM_TRUNCATION_NOTICE_JSON.length + 1;
  // An unusually small caller budget may not have room for the notice.
  const withNotice = max >= noticeCost + 2;
  const budget = max - (withNotice ? noticeCost : 0);
  // The run-metrics usage item is replaced in place while streaming, so it sits
  // at the very start of the stream and would be the first casualty of the
  // newest-first retention below. Pin the terminal snapshot of every run.
  const lastRunMetrics = new Map<string, SnapshotEntry>();
  for (const entry of entries) {
    const rec = entry.item as { kind?: unknown; runMetrics?: { runId?: unknown } } | undefined;
    if (rec?.kind !== "usage" || !rec.runMetrics || typeof rec.runMetrics !== "object") continue;
    const runId = typeof rec.runMetrics.runId === "string" ? rec.runMetrics.runId : "";
    lastRunMetrics.set(runId, entry);
  }
  const pinned = new Set<SnapshotEntry>();
  let pinnedSize = 2;
  for (const entry of lastRunMetrics.values()) {
    pinnedSize += entry.json.length + (pinned.size ? 1 : 0);
    pinned.add(entry);
  }
  // If even the pinned summaries exceed the budget, keep the old behavior.
  if (pinnedSize > budget) pinned.clear();
  const retained = new Set<SnapshotEntry>(pinned);
  let size = pinned.size ? pinnedSize : 2;
  let nonPinnedRetained = 0;
  for (let index = essential.length - 1; index >= 0; index -= 1) {
    const entry = essential[index]!;
    if (pinned.has(entry)) continue;
    const cost = entry.json.length + (retained.size ? 1 : 0);
    if (size + cost > budget) {
      if (nonPinnedRetained === 0) return fitLastItemToBudget(entry.item, max);
      break;
    }
    retained.add(entry);
    nonPinnedRetained += 1;
    size += cost;
  }
  // Fill the remaining space with recent tool activity, retaining chronology.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.essential) continue;
    const cost = entry.json.length + (retained.size ? 1 : 0);
    if (size + cost > budget) break;
    retained.add(entry);
    size += cost;
  }
  const selected = entries.filter((entry) => retained.has(entry));
  const json = serialize(selected);
  return withNotice
    ? `[${STREAM_TRUNCATION_NOTICE_JSON}${selected.length ? "," : ""}${json.slice(1)}`
    : json;
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
  role: "user" | "assistant" | "system"
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
export function serializeStreamItemsForPersist(
  items: unknown[], maxChars = MAX_IPC_MESSAGE_CONTENT_CHARS
): string {
  const max = Number.isFinite(maxChars) ? Math.max(2, Math.floor(maxChars)) : MAX_IPC_MESSAGE_CONTENT_CHARS;
  return capStreamJson(Array.isArray(items) ? items : [], max);
}
