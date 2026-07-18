import fs from "node:fs";
import path from "node:path";

import type { ConversationMessage } from "../cli/conversations.js";
import type {
  HandoffTranscriptMessage,
  HandoffTranscriptRef
} from "./handoffTypes.js";

const SNAPSHOT_DIRECTORY = "handoff-snapshots";
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_STRING_CHARS = 16_000;
const MAX_ARRAY_ITEMS = 500;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;
const DATA_URL_RE = /data:[^;,\s]+;base64,[a-z0-9+/=]+/gi;
const SENSITIVE_KEY_RE = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token|\benv\b)/i;

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}

function snapshotRoot(dataDir: string): string {
  return path.resolve(dataDir, SNAPSHOT_DIRECTORY);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeSnapshotPath(dataDir: string, snapshotPath: string): string | null {
  const root = snapshotRoot(dataDir);
  const candidate = path.resolve(snapshotPath);
  return isInside(root, candidate) ? candidate : null;
}

function sanitizeString(value: string): string {
  const withoutData = value.replace(DATA_URL_RE, "[inline media removed]");
  return withoutData.length <= MAX_STRING_CHARS
    ? withoutData
    : `${withoutData.slice(0, MAX_STRING_CHARS)}\n[truncated]`;
}

function sanitizeValue(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY_RE.test(key)) return "[redacted]";
  if (typeof value === "string") return sanitizeString(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (depth >= MAX_DEPTH) return "[nested content omitted]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeValue(entry, "", depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => typeof entry !== "function")
      .slice(0, MAX_OBJECT_KEYS);
    return Object.fromEntries(
      entries.map(([entryKey, entry]) => [
        entryKey,
        sanitizeValue(entry, entryKey, depth + 1)
      ])
    );
  }
  return String(value);
}

function sanitizeAssistantContent(content: string): unknown {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return sanitizeValue(parsed);
    return parsed
      .filter((item) => {
        if (!item || typeof item !== "object") return true;
        const kind = (item as { kind?: unknown }).kind;
        return kind !== "thinking" && kind !== "usage";
      })
      .map((item) => sanitizeValue(item));
  } catch {
    return sanitizeString(content);
  }
}

function toSnapshotMessage(message: ConversationMessage): HandoffTranscriptMessage {
  const snapshot: HandoffTranscriptMessage = {
    id: message.id,
    role: message.role,
    status: message.status,
    content:
      message.role === "assistant"
        ? sanitizeAssistantContent(message.content)
        : sanitizeString(message.content),
    attachments: message.attachments?.map((attachment) => ({
      name: attachment.name,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      size: attachment.size
    })),
    taskId: message.taskId,
    agentId: message.agentId,
    agentName: message.agentName,
    adapter: message.adapter,
    roleLabel: message.roleLabel,
    createdAt: message.createdAt
  };

  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= MAX_MESSAGE_BYTES) {
    return snapshot;
  }

  const contentText =
    typeof snapshot.content === "string"
      ? snapshot.content
      : JSON.stringify(snapshot.content);
  return {
    ...snapshot,
    attachments: undefined,
    content: `${truncateUtf8(contentText, 48 * 1024)}\n[message truncated]`,
    truncated: true
  };
}

function selectWithinLimit(
  messages: HandoffTranscriptMessage[]
): { messages: HandoffTranscriptMessage[]; truncated: boolean } {
  const lines = messages.map((message) => JSON.stringify(message));
  const sizes = lines.map((line) => Buffer.byteLength(`${line}\n`, "utf8"));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= MAX_SNAPSHOT_BYTES) return { messages, truncated: false };

  const selected = new Set<number>();
  let used = 0;
  if (messages.length > 0 && sizes[0] <= MAX_SNAPSHOT_BYTES) {
    selected.add(0);
    used += sizes[0];
  }
  for (let index = messages.length - 1; index >= 1; index -= 1) {
    if (used + sizes[index] > MAX_SNAPSHOT_BYTES) continue;
    selected.add(index);
    used += sizes[index];
  }
  return {
    messages: messages.filter((_, index) => selected.has(index)),
    truncated: true
  };
}

export function createHandoffTranscriptSnapshot(
  dataDir: string,
  briefId: string,
  messages: ConversationMessage[]
): HandoffTranscriptRef {
  const root = snapshotRoot(dataDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const safeId = briefId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const snapshotPath = path.join(root, `${safeId}.jsonl`);
  const temporaryPath = `${snapshotPath}.tmp`;
  const selected = selectWithinLimit(messages.map(toSnapshotMessage));
  const contents = selected.messages.map((message) => JSON.stringify(message)).join("\n");
  const serialized = contents ? `${contents}\n` : "";
  try {
    fs.writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, snapshotPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // best-effort cleanup of an incomplete atomic write
    }
    throw error;
  }
  return {
    format: "jsonl",
    path: snapshotPath,
    messageCount: selected.messages.length,
    byteSize: Buffer.byteLength(serialized, "utf8"),
    truncated: selected.truncated || selected.messages.some((message) => message.truncated)
  };
}

export function readHandoffTranscriptSnapshot(
  dataDir: string,
  transcript: HandoffTranscriptRef
): HandoffTranscriptMessage[] {
  const snapshotPath = safeSnapshotPath(dataDir, transcript.path);
  if (!snapshotPath) return [];
  try {
    const stat = fs.statSync(snapshotPath);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return [];
    return fs
      .readFileSync(snapshotPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HandoffTranscriptMessage);
  } catch {
    return [];
  }
}

export function deleteHandoffTranscriptSnapshot(
  dataDir: string,
  transcriptPath: string | undefined
): void {
  if (!transcriptPath) return;
  const snapshotPath = safeSnapshotPath(dataDir, transcriptPath);
  if (!snapshotPath) return;
  try {
    fs.unlinkSync(snapshotPath);
  } catch {
    // best-effort cleanup; a missing snapshot is already clean
  }
}

export function cleanupOrphanHandoffTranscriptSnapshots(
  dataDir: string,
  referencedPaths: Iterable<string>
): void {
  const root = snapshotRoot(dataDir);
  const referenced = new Set(
    [...referencedPaths]
      .map((snapshotPath) => safeSnapshotPath(dataDir, snapshotPath))
      .filter((snapshotPath): snapshotPath is string => Boolean(snapshotPath))
  );
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const candidate = path.join(root, entry.name);
      if (referenced.has(candidate)) continue;
      if (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".tmp")) continue;
      try {
        fs.unlinkSync(candidate);
      } catch {
        // best-effort crash recovery
      }
    }
  } catch {
    // The directory normally does not exist before the first handoff.
  }
}
