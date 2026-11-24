import { nanoid } from "nanoid";

import { logMain } from "../debugLog.js";
import type {
  ConversationDigest,
  ConversationDigestChangedEvent,
  ConversationDigestConfig,
  ConversationDigestConfigState,
  ConversationDigestSource,
  ConversationDigestStatus,
  ConversationTopic,
  ConversationTopicSearchHit,
  ConversationTopicStatus
} from "../shared/conversationDigestTypes.js";
import { getCallerUserId, isCallerAdmin } from "./callerContext.js";
import {
  getConversation,
  requireOwnedConversation,
  type Conversation
} from "./conversations.js";
import {
  callDigestLlm,
  resolveDigestProvider,
  type DigestTurnInput,
  type RawDigestTopicOutput
} from "./conversationDigestLlm.js";
import { getDb } from "./db.js";
import { getSetting, setSetting } from "./settings.js";

const DIGEST_CONFIG_SETTING_KEY = "butlerbuddy.conversationDigest.config";
const DEFAULT_DEBOUNCE_MS = 3_500;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_USER_TEXT_CHARS = 1_200;
const MAX_ASSISTANT_TEXT_CHARS = 1_200;
const MAX_FILES_PER_TOPIC = 15;
const MAX_KEYWORDS_PER_TOPIC = 8;
const DEFAULT_MIN_USER_TURNS = 2;

const EDIT_TOOL_NAMES = new Set([
  "apply_patch",
  "write",
  "edit",
  "update",
  "str_replace",
  "create_file",
  "edit_file",
  "multi_edit"
]);

const TOPIC_STATUSES = new Set<ConversationTopicStatus>([
  "open",
  "done",
  "blocked",
  "abandoned"
]);

interface RawMessageRow {
  id: string;
  sequence: number;
  role: "user" | "assistant" | "system";
  status: string;
  content: string | null;
  created_at: string;
  updated_at: string;
}

interface DigestStateRow {
  conversation_id: string;
  overall_summary: string | null;
  source: string;
  status: string;
  last_message_id: string | null;
  last_message_seq: number;
  last_error: string | null;
  updated_at: string;
}

interface TopicRow {
  id: string;
  conversation_id: string;
  sort_order: number;
  title: string;
  summary: string;
  status: string;
  source: string;
  start_message_id: string;
  end_message_id: string;
  turn_count: number;
  keywords_json: string;
  files_json: string;
  created_at: string;
  updated_at: string;
}

export interface ExtractedTurn extends DigestTurnInput {
  startMessageId: string;
  endMessageId: string;
  startSeq: number;
  endSeq: number;
  hasActiveAssistant: boolean;
  updatedAt: string;
}

let digestNotifier: ((event: ConversationDigestChangedEvent) => void) | null =
  null;
let testFetchImpl: typeof fetch | null = null;
let debounceMsOverride: number | null = null;

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingForceRebuild = new Map<string, boolean>();
const queuedIds: string[] = [];
const queuedSet = new Set<string>();
const activeForceRebuild = new Map<string, boolean>();
let runningConversationId: string | null = null;
let runningAbortController: AbortController | null = null;
let queueDrainPromise: Promise<void> | null = null;

export function bindConversationDigestNotifier(
  fn: ((event: ConversationDigestChangedEvent) => void) | null
): void {
  digestNotifier = fn;
}

export function setDigestFetchForTest(fn: typeof fetch | null): void {
  testFetchImpl = fn;
}

export function setDigestDebounceMsForTest(ms: number | null): void {
  debounceMsOverride = ms;
}

function emitDigestChanged(event: ConversationDigestChangedEvent): void {
  try {
    digestNotifier?.(event);
  } catch {
    // Broadcaster errors must never interrupt digest persistence.
  }
}

function stripInlineMedia(text: string): string {
  return text.replace(
    /data:[^;,\s]+;base64,[a-z0-9+/=]+/gi,
    "[inline media removed]"
  );
}

function clipLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const chars = Array.from(normalized);
  if (chars.length <= max) return normalized;
  return `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

function clipMultiline(value: string, max: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  const chars = Array.from(normalized);
  if (chars.length <= max) return normalized;
  return `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line
      .replace(/^#+\s*/, "")
      .replace(/^\s*[-*•]\s*/, "")
      .trim();
    if (cleaned) return cleaned;
  }
  return text.trim();
}

function extractAssistantTextAndFiles(content: string | null): {
  text: string;
  files: string[];
} {
  if (!content) return { text: "", files: [] };
  let items: unknown;
  try {
    items = JSON.parse(content);
  } catch {
    return { text: stripInlineMedia(content), files: [] };
  }
  if (!Array.isArray(items)) return { text: "", files: [] };

  const textParts: string[] = [];
  const files: string[] = [];
  const seenFiles = new Set<string>();

  const addFile = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 4096 || seenFiles.has(trimmed)) return;
    seenFiles.add(trimmed);
    files.push(trimmed);
  };

  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      continue;
    }
    const item = rawItem as Record<string, unknown>;
    const kind = String(item.kind ?? "");
    // Strictly exclude thinking, command-output, tool-result, and patches.
    if (kind === "text" && (item.role === undefined || item.role === "assistant")) {
      const piece = typeof item.content === "string" ? item.content : "";
      if (piece) {
        if (item.append && textParts.length > 0) {
          textParts[textParts.length - 1] += piece;
        } else {
          textParts.push(piece);
        }
      }
    } else if (kind === "error") {
      const msg =
        typeof item.message === "string"
          ? item.message
          : typeof item.content === "string"
            ? item.content
            : "";
      if (msg.trim()) textParts.push(msg.trim());
    } else if (kind === "file-edit") {
      addFile(item.path);
    } else if (kind === "tool-call") {
      const toolKind = typeof item.toolKind === "string" ? item.toolKind : "";
      const toolName = typeof item.tool === "string" ? item.tool : "";
      const isEdit =
        toolKind === "edit" ||
        toolKind === "delete" ||
        toolKind === "move" ||
        EDIT_TOOL_NAMES.has(toolName);
      if (!isEdit) continue;
      if (Array.isArray(item.locations)) {
        for (const loc of item.locations) {
          if (loc && typeof loc === "object") {
            addFile((loc as Record<string, unknown>).path);
          }
        }
      }
      if (item.input && typeof item.input === "object") {
        const inp = item.input as Record<string, unknown>;
        addFile(inp.path ?? inp.file_path ?? inp.filePath);
      }
      if (Array.isArray(item.toolOutputs)) {
        for (const out of item.toolOutputs) {
          if (out && typeof out === "object") {
            addFile((out as Record<string, unknown>).path);
          }
        }
      }
    }
  }

  return {
    text: stripInlineMedia(textParts.join("\n\n")),
    files: files.slice(0, MAX_FILES_PER_TOPIC)
  };
}

function statusFromAssistantMessages(
  assistants: RawMessageRow[]
): { status: ConversationTopicStatus; hasActive: boolean } {
  if (assistants.length === 0) {
    return { status: "open", hasActive: false };
  }
  const hasActive = assistants.some(
    (m) => m.status === "running" || m.status === "starting"
  );
  if (hasActive) {
    return { status: "open", hasActive: true };
  }
  const last = assistants[assistants.length - 1];
  if (last.status === "failed" || last.status === "killed") {
    return { status: "blocked", hasActive: false };
  }
  if (last.status === "done" || last.status === "sent") {
    return { status: "done", hasActive: false };
  }
  return { status: "open", hasActive: false };
}

/**
 * Layer 0 deterministic turn extractor: groups `conversation_messages` into
 * user-initiated turns without any LLM call or heavy stdout/thinking payloads.
 */
export function extractConversationTurns(
  conversationId: string
): { turns: ExtractedTurn[]; validMessageIds: Set<string>; maxSeq: number } {
  const rows = getDb()
    .prepare(
      `SELECT id, rowid AS sequence, role, status,
         CASE WHEN octet_length(content) <= ${MAX_MESSAGE_BYTES} THEN content ELSE NULL END AS content,
         created_at, updated_at
       FROM conversation_messages
       WHERE conversation_id = ? AND role IN ('user', 'assistant')
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(conversationId) as RawMessageRow[];

  const validMessageIds = new Set<string>();
  let maxSeq = 0;
  for (const row of rows) {
    validMessageIds.add(row.id);
    if (row.sequence > maxSeq) maxSeq = row.sequence;
  }

  const turns: ExtractedTurn[] = [];
  let currentUser: RawMessageRow | null = null;
  let currentAssistants: RawMessageRow[] = [];

  const flushTurn = () => {
    if (!currentUser) return;
    const userText = clipMultiline(
      stripInlineMedia(currentUser.content ?? ""),
      MAX_USER_TEXT_CHARS
    );
    const assistantParts: string[] = [];
    const fileSet = new Set<string>();
    for (const msg of currentAssistants) {
      const parsed = extractAssistantTextAndFiles(msg.content);
      if (parsed.text.trim()) assistantParts.push(parsed.text.trim());
      for (const filePath of parsed.files) {
        if (fileSet.size < MAX_FILES_PER_TOPIC) fileSet.add(filePath);
      }
    }
    const combinedAssistant = clipMultiline(
      assistantParts.join("\n\n"),
      MAX_ASSISTANT_TEXT_CHARS
    );
    const lastMsg = currentAssistants[currentAssistants.length - 1] ?? currentUser;
    const { status, hasActive } = statusFromAssistantMessages(currentAssistants);

    turns.push({
      turnIndex: turns.length + 1,
      userMessageId: currentUser.id,
      ...(currentAssistants.length > 0
        ? { assistantMessageId: currentAssistants[currentAssistants.length - 1].id }
        : {}),
      startMessageId: currentUser.id,
      endMessageId: lastMsg.id,
      startSeq: currentUser.sequence,
      endSeq: lastMsg.sequence,
      userText,
      assistantText: combinedAssistant,
      status,
      hasActiveAssistant: hasActive,
      files: [...fileSet],
      createdAt: currentUser.created_at,
      updatedAt: lastMsg.updated_at
    });
  };

  for (const row of rows) {
    if (row.role === "user") {
      flushTurn();
      currentUser = row;
      currentAssistants = [];
    } else if (row.role === "assistant" && currentUser) {
      currentAssistants.push(row);
    }
  }
  flushTurn();

  return { turns, validMessageIds, maxSeq };
}

function turnToRuleTopic(
  conversationId: string,
  turn: ExtractedTurn,
  sortOrder: number
): ConversationTopic {
  const titleSource = firstMeaningfulLine(turn.userText);
  const title =
    clipLine(titleSource, 56) || `Turn #${turn.turnIndex}`;
  const summary =
    clipLine(turn.assistantText, 140) ||
    (turn.files.length > 0
      ? clipLine(turn.files.slice(0, 3).join(", "), 140)
      : clipLine(turn.userText, 140));
  return {
    id: `rule-${turn.userMessageId}`,
    conversationId,
    sortOrder,
    title,
    summary,
    status: turn.status,
    source: "rule",
    startMessageId: turn.startMessageId,
    endMessageId: turn.endMessageId,
    turnCount: 1,
    keywords: [],
    files: turn.files,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt
  };
}

function parseJsonStringArray(raw: string, limit: number): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim())
      .slice(0, limit);
  } catch {
    return [];
  }
}

function normalizeTopicStatus(value: unknown): ConversationTopicStatus {
  return typeof value === "string" &&
    TOPIC_STATUSES.has(value as ConversationTopicStatus)
    ? (value as ConversationTopicStatus)
    : "open";
}

function normalizeDigestStatus(value: unknown): ConversationDigestStatus {
  if (
    value === "idle" ||
    value === "queued" ||
    value === "running" ||
    value === "ready" ||
    value === "error"
  ) {
    return value;
  }
  return "idle";
}

function normalizeDigestSource(value: unknown): ConversationDigestSource {
  return value === "llm" ? "llm" : "rule";
}

function rowToTopic(row: TopicRow): ConversationTopic {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sortOrder: row.sort_order,
    title: row.title,
    summary: row.summary,
    status: normalizeTopicStatus(row.status),
    source: normalizeDigestSource(row.source),
    startMessageId: row.start_message_id,
    endMessageId: row.end_message_id,
    turnCount: Math.max(1, Number(row.turn_count) || 1),
    keywords: parseJsonStringArray(row.keywords_json, MAX_KEYWORDS_PER_TOPIC),
    files: parseJsonStringArray(row.files_json, MAX_FILES_PER_TOPIC),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---- Configuration ----

export function getConversationDigestConfig(): ConversationDigestConfig {
  const defaults: ConversationDigestConfig = {
    enabled: true,
    providerId: "",
    model: "",
    minUserTurns: DEFAULT_MIN_USER_TURNS
  };
  const raw = getSetting(DIGEST_CONFIG_SETTING_KEY);
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<ConversationDigestConfig>;
    return {
      enabled: parsed.enabled !== false,
      providerId:
        typeof parsed.providerId === "string" ? parsed.providerId.trim() : "",
      model: typeof parsed.model === "string" ? parsed.model.trim() : "",
      minUserTurns:
        typeof parsed.minUserTurns === "number" &&
        Number.isFinite(parsed.minUserTurns) &&
        parsed.minUserTurns >= 1 &&
        parsed.minUserTurns <= 20
          ? Math.floor(parsed.minUserTurns)
          : DEFAULT_MIN_USER_TURNS
    };
  } catch {
    return defaults;
  }
}

export function getConversationDigestConfigState(): ConversationDigestConfigState {
  const config = getConversationDigestConfig();
  const resolved = resolveDigestProvider(config);
  return {
    config,
    availability: resolved
      ? {
          hasAvailableProvider: true,
          resolvedProviderId: resolved.provider.id,
          resolvedProviderName: resolved.provider.name,
          resolvedModel: resolved.model
        }
      : { hasAvailableProvider: false }
  };
}

export function setConversationDigestConfig(
  patch: Partial<ConversationDigestConfig>
): ConversationDigestConfigState {
  const current = getConversationDigestConfig();
  const next: ConversationDigestConfig = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
    providerId:
      patch.providerId !== undefined
        ? String(patch.providerId).trim()
        : current.providerId,
    model:
      patch.model !== undefined ? String(patch.model).trim() : current.model,
    minUserTurns:
      typeof patch.minUserTurns === "number" &&
      Number.isFinite(patch.minUserTurns)
        ? Math.min(20, Math.max(1, Math.floor(patch.minUserTurns)))
        : current.minUserTurns
  };
  setSetting(DIGEST_CONFIG_SETTING_KEY, JSON.stringify(next));
  return getConversationDigestConfigState();
}

// ---- Read & Search APIs ----

export function getConversationDigest(
  conversationId: string
): ConversationDigest | null {
  const conv = requireOwnedConversation(conversationId);
  if (!conv) return null;

  const db = getDb();
  const state = db
    .prepare(
      `SELECT * FROM conversation_digest_state WHERE conversation_id = ?`
    )
    .get(conversationId) as DigestStateRow | undefined;

  const storedRows = db
    .prepare(
      `SELECT * FROM conversation_topics WHERE conversation_id = ? ORDER BY sort_order ASC`
    )
    .all(conversationId) as TopicRow[];
  const storedTopics = storedRows.map(rowToTopic);

  const { turns } = extractConversationTurns(conversationId);
  const effectiveStatus =
    runningConversationId === conversationId
      ? "running"
      : queuedSet.has(conversationId) || pendingTimers.has(conversationId)
        ? "queued"
        : normalizeDigestStatus(state?.status);

  if (state?.source === "llm" && storedTopics.length > 0) {
    const trailingTurns = turns.filter((t) => t.endSeq > state.last_message_seq);
    const trailingTopics = trailingTurns.map((turn, idx) =>
      turnToRuleTopic(conversationId, turn, storedTopics.length + idx)
    );
    const topics = [...storedTopics, ...trailingTopics];
    return {
      conversationId,
      ...(state.overall_summary
        ? { overallSummary: state.overall_summary }
        : {}),
      source: "llm",
      status: effectiveStatus === "idle" ? "ready" : effectiveStatus,
      ...(state.last_message_id
        ? { lastMessageId: state.last_message_id }
        : {}),
      lastMessageSeq: state.last_message_seq,
      topicCount: topics.length,
      topics,
      ...(state.last_error ? { error: state.last_error } : {}),
      updatedAt: state.updated_at
    };
  }

  const ruleTopics = turns.map((turn, idx) =>
    turnToRuleTopic(conversationId, turn, idx)
  );
  const lastTurn = turns[turns.length - 1];
  return {
    conversationId,
    source: "rule",
    status: effectiveStatus,
    ...(lastTurn ? { lastMessageId: lastTurn.endMessageId } : {}),
    lastMessageSeq: state?.last_message_seq ?? 0,
    topicCount: ruleTopics.length,
    topics: ruleTopics,
    ...(state?.last_error ? { error: state.last_error } : {}),
    updatedAt: state?.updated_at ?? conv.updatedAt
  };
}

export function searchConversationTopics(input: {
  query: string;
  limit?: number;
  includeArchived?: boolean;
}): ConversationTopicSearchHit[] {
  const tokens = String(input.query ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return [];

  const limitRaw = Number(input.limit ?? 12);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(40, Math.max(1, Math.floor(limitRaw)))
    : 12;
  const includeArchived = input.includeArchived === true;

  const db = getDb();
  const caller = getCallerUserId();
  const scoped = caller !== null && !isCallerAdmin();

  const whereClauses: string[] = [];
  const params: unknown[] = [];
  if (scoped) {
    whereClauses.push("c.owner_id = ?");
    params.push(caller);
  }
  if (!includeArchived) {
    whereClauses.push("c.archived = 0");
  }
  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const topicRows = db
    .prepare(
      `SELECT t.*, c.title AS conversation_title, c.cwd AS conversation_cwd,
              c.agent_id AS conversation_agent_id, c.agent_name AS conversation_agent_name,
              c.adapter AS conversation_adapter
       FROM conversation_topics t
       JOIN conversations c ON c.id = t.conversation_id
       ${whereSql}
       ORDER BY t.updated_at DESC
       LIMIT 400`
    )
    .all(...params) as Array<
    TopicRow & {
      conversation_title: string;
      conversation_cwd: string | null;
      conversation_agent_id: string;
      conversation_agent_name: string;
      conversation_adapter: string;
    }
  >;

  const hits: ConversationTopicSearchHit[] = [];
  const seenKeys = new Set<string>();

  for (const row of topicRows) {
    const topic = rowToTopic(row);
    const haystack = [
      topic.title,
      topic.summary,
      topic.keywords.join(" "),
      topic.files.join(" "),
      row.conversation_title
    ]
      .join("\n")
      .toLowerCase();
    if (!tokens.every((token) => haystack.includes(token))) continue;

    const dedupeKey = `${topic.conversationId}:${topic.startMessageId}`;
    seenKeys.add(dedupeKey);
    hits.push({
      topicId: topic.id,
      conversationId: topic.conversationId,
      conversationTitle: row.conversation_title,
      ...(row.conversation_cwd
        ? { conversationCwd: row.conversation_cwd }
        : {}),
      agentId: row.conversation_agent_id,
      agentName: row.conversation_agent_name,
      adapter: row.conversation_adapter,
      title: topic.title,
      summary: topic.summary,
      status: topic.status,
      source: topic.source,
      startMessageId: topic.startMessageId,
      endMessageId: topic.endMessageId,
      files: topic.files,
      updatedAt: topic.updatedAt
    });
  }

  // Layer 0 fallback for conversations that do not have stored topic rows yet.
  const fallbackWhere = [
    ...whereClauses,
    "m.role = 'user'",
    "NOT EXISTS (SELECT 1 FROM conversation_topics ct WHERE ct.conversation_id = c.id)"
  ];
  const fallbackRows = db
    .prepare(
      `SELECT m.id AS message_id, m.conversation_id, m.created_at,
              CASE WHEN octet_length(m.content) <= 16384 THEN substr(m.content, 1, 4000) ELSE '' END AS content,
              c.title AS conversation_title, c.cwd AS conversation_cwd,
              c.agent_id AS conversation_agent_id, c.agent_name AS conversation_agent_name,
              c.adapter AS conversation_adapter
       FROM conversation_messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE ${fallbackWhere.join(" AND ")}
       ORDER BY m.created_at DESC, m.rowid DESC
       LIMIT 300`
    )
    .all(...params) as Array<{
    message_id: string;
    conversation_id: string;
    created_at: string;
    content: string;
    conversation_title: string;
    conversation_cwd: string | null;
    conversation_agent_id: string;
    conversation_agent_name: string;
    conversation_adapter: string;
  }>;

  for (const row of fallbackRows) {
    const cleanText = stripInlineMedia(row.content ?? "");
    const haystack = `${cleanText}\n${row.conversation_title}`.toLowerCase();
    if (!tokens.every((token) => haystack.includes(token))) continue;

    const dedupeKey = `${row.conversation_id}:${row.message_id}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    const title = clipLine(firstMeaningfulLine(cleanText), 56) || row.conversation_title;
    const summary = clipLine(cleanText, 140);
    hits.push({
      topicId: `rule-${row.message_id}`,
      conversationId: row.conversation_id,
      conversationTitle: row.conversation_title,
      ...(row.conversation_cwd
        ? { conversationCwd: row.conversation_cwd }
        : {}),
      agentId: row.conversation_agent_id,
      agentName: row.conversation_agent_name,
      adapter: row.conversation_adapter,
      title,
      summary,
      status: "done",
      source: "rule",
      startMessageId: row.message_id,
      endMessageId: row.message_id,
      files: [],
      updatedAt: row.created_at
    });
  }

  hits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return hits.slice(0, limit);
}

// ---- Incremental Persistence & Sanitization ----

function upsertDigestState(input: {
  conversationId: string;
  overallSummary?: string | null;
  source: ConversationDigestSource;
  status: ConversationDigestStatus;
  lastMessageId?: string | null;
  lastMessageSeq: number;
  lastError?: string | null;
}): string {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO conversation_digest_state
         (conversation_id, overall_summary, source, status, last_message_id, last_message_seq, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         overall_summary = COALESCE(excluded.overall_summary, conversation_digest_state.overall_summary),
         source = excluded.source,
         status = excluded.status,
         last_message_id = COALESCE(excluded.last_message_id, conversation_digest_state.last_message_id),
         last_message_seq = MAX(excluded.last_message_seq, conversation_digest_state.last_message_seq),
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`
    )
    .run(
      input.conversationId,
      input.overallSummary ?? null,
      input.source,
      input.status,
      input.lastMessageId ?? null,
      input.lastMessageSeq,
      input.lastError ?? null,
      now
    );
  return now;
}

function sanitizeLlmTopics(input: {
  conversationId: string;
  rawTopics: RawDigestTopicOutput[];
  existingTopics: ConversationTopic[];
  turns: ExtractedTurn[];
  validMessageIds: Set<string>;
}): ConversationTopic[] {
  const now = new Date().toISOString();
  const existingById = new Map(input.existingTopics.map((t) => [t.id, t]));
  const turnByStartId = new Map(
    input.turns.map((t) => [t.startMessageId, t])
  );
  const fallbackTurn = input.turns[input.turns.length - 1];
  const result: ConversationTopic[] = [];

  for (let idx = 0; idx < input.rawTopics.length && result.length < 40; idx += 1) {
    const raw = input.rawTopics[idx];
    const existing =
      typeof raw.id === "string" ? existingById.get(raw.id.trim()) : undefined;
    const rawStart =
      typeof raw.startMessageId === "string" ? raw.startMessageId.trim() : "";
    const rawEnd =
      typeof raw.endMessageId === "string" ? raw.endMessageId.trim() : "";

    const validStart = input.validMessageIds.has(rawStart)
      ? rawStart
      : existing && input.validMessageIds.has(existing.startMessageId)
        ? existing.startMessageId
        : fallbackTurn.startMessageId;
    const validEnd = input.validMessageIds.has(rawEnd)
      ? rawEnd
      : existing && input.validMessageIds.has(existing.endMessageId)
        ? existing.endMessageId
        : fallbackTurn.endMessageId;

    const matchedTurn = turnByStartId.get(validStart) ?? fallbackTurn;
    const title =
      clipLine(String(raw.title ?? ""), 80) ||
      existing?.title ||
      clipLine(firstMeaningfulLine(matchedTurn.userText), 56) ||
      `Topic #${result.length + 1}`;
    const summary =
      clipLine(String(raw.summary ?? ""), 240) ||
      existing?.summary ||
      clipLine(matchedTurn.assistantText, 140);
    const keywords = Array.isArray(raw.keywords)
      ? raw.keywords
          .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
          .map((k) => clipLine(k, 32))
          .filter(Boolean)
          .slice(0, MAX_KEYWORDS_PER_TOPIC)
      : existing?.keywords ?? [];
    const files = Array.isArray(raw.files)
      ? raw.files
          .filter((f): f is string => typeof f === "string" && f.trim().length > 0 && f.length <= 4096)
          .map((f) => f.trim())
          .slice(0, MAX_FILES_PER_TOPIC)
      : existing?.files ?? matchedTurn.files;

    const turnCountRaw = Number(raw.turnCount ?? existing?.turnCount ?? 1);
    const turnCount = Number.isFinite(turnCountRaw)
      ? Math.max(1, Math.min(999, Math.floor(turnCountRaw)))
      : 1;

    result.push({
      id: existing?.id ?? `topic-${nanoid(10)}`,
      conversationId: input.conversationId,
      sortOrder: result.length,
      title,
      summary,
      status: normalizeTopicStatus(raw.status ?? existing?.status ?? matchedTurn.status),
      source: "llm",
      startMessageId: validStart,
      endMessageId: validEnd,
      turnCount,
      keywords,
      files,
      createdAt: existing?.createdAt ?? matchedTurn.createdAt ?? now,
      updatedAt: now
    });
  }

  return result;
}

function saveLlmDigestTransaction(input: {
  conversationId: string;
  overallSummary?: string;
  topics: ConversationTopic[];
  lastMessageId?: string;
  lastMessageSeq: number;
}): string | null {
  const db = getDb();
  const stillExists = db
    .prepare(`SELECT 1 FROM conversations WHERE id = ?`)
    .get(input.conversationId);
  if (!stillExists) return null;

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`DELETE FROM conversation_topics WHERE conversation_id = ?`).run(
      input.conversationId
    );
    const insertTopic = db.prepare(
      `INSERT INTO conversation_topics
         (id, conversation_id, sort_order, title, summary, status, source,
          start_message_id, end_message_id, turn_count, keywords_json, files_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const topic of input.topics) {
      insertTopic.run(
        topic.id,
        input.conversationId,
        topic.sortOrder,
        topic.title,
        topic.summary,
        topic.status,
        "llm",
        topic.startMessageId,
        topic.endMessageId,
        topic.turnCount,
        JSON.stringify(topic.keywords),
        JSON.stringify(topic.files),
        topic.createdAt,
        topic.updatedAt
      );
    }

    db.prepare(
      `INSERT INTO conversation_digest_state
         (conversation_id, overall_summary, source, status, last_message_id, last_message_seq, last_error, updated_at)
       VALUES (?, ?, 'llm', 'ready', ?, ?, NULL, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         overall_summary = excluded.overall_summary,
         source = 'llm',
         status = 'ready',
         last_message_id = excluded.last_message_id,
         last_message_seq = excluded.last_message_seq,
         last_error = NULL,
         updated_at = excluded.updated_at`
    ).run(
      input.conversationId,
      input.overallSummary ? clipLine(input.overallSummary, 160) : null,
      input.lastMessageId ?? null,
      input.lastMessageSeq,
      now
    );
  })();
  return now;
}

// ---- Background Runner & Debounced Queue ----

export async function runConversationDigestNow(
  conversationId: string,
  options?: { forceRebuild?: boolean; signal?: AbortSignal }
): Promise<ConversationDigest | null> {
  const forceRebuild = options?.forceRebuild === true;
  const conv: Conversation | undefined = getConversation(conversationId);
  if (!conv) return null;
  if (conv.kind === "game") return null;
  if (conv.archived && !forceRebuild) return null;

  const config = getConversationDigestConfig();
  if (!config.enabled && !forceRebuild) return null;

  const { turns, validMessageIds, maxSeq } = extractConversationTurns(conversationId);
  const finishedTurns = turns.filter((turn) => !turn.hasActiveAssistant);
  if (finishedTurns.length === 0) return null;

  if (!forceRebuild && turns.some((turn) => turn.hasActiveAssistant)) {
    return null;
  }

  if (!forceRebuild && finishedTurns.length < config.minUserTurns) {
    return null;
  }

  const db = getDb();
  const state = db
    .prepare(`SELECT * FROM conversation_digest_state WHERE conversation_id = ?`)
    .get(conversationId) as DigestStateRow | undefined;

  const latestFinishedSeq = finishedTurns[finishedTurns.length - 1].endSeq;
  if (
    !forceRebuild &&
    state?.source === "llm" &&
    state.last_message_seq >= latestFinishedSeq
  ) {
    return null;
  }

  const resolved = resolveDigestProvider(config);
  if (!resolved) {
    if (forceRebuild) {
      const updatedAt = upsertDigestState({
        conversationId,
        source: normalizeDigestSource(state?.source),
        status: "error",
        lastMessageSeq: state?.last_message_seq ?? 0,
        lastError: "no_provider"
      });
      emitDigestChanged({
        conversationId,
        status: "error",
        source: normalizeDigestSource(state?.source),
        updatedAt
      });
    }
    return null;
  }

  const existingTopics = forceRebuild
    ? []
    : (
        db
          .prepare(
            `SELECT * FROM conversation_topics WHERE conversation_id = ? ORDER BY sort_order ASC LIMIT 30`
          )
          .all(conversationId) as TopicRow[]
      ).map(rowToTopic);

  const deltaTurns = forceRebuild
    ? finishedTurns.slice(-40)
    : finishedTurns
        .filter((turn) => turn.endSeq > (state?.last_message_seq ?? 0))
        .slice(-12);

  if (deltaTurns.length === 0) return null;

  const runningAt = upsertDigestState({
    conversationId,
    source: normalizeDigestSource(state?.source),
    status: "running",
    lastMessageSeq: state?.last_message_seq ?? 0,
    lastError: null
  });
  emitDigestChanged({
    conversationId,
    status: "running",
    source: normalizeDigestSource(state?.source),
    updatedAt: runningAt
  });

  try {
    const llmResult = await callDigestLlm({
      resolved,
      conversationTitle: conv.title,
      existingOverallSummary: forceRebuild
        ? undefined
        : state?.overall_summary ?? undefined,
      existingTopics,
      newTurns: deltaTurns,
      signal: options?.signal,
      fetchImpl: testFetchImpl ?? fetch
    });

    const sanitizedTopics = sanitizeLlmTopics({
      conversationId,
      rawTopics: llmResult.topics,
      existingTopics,
      turns: finishedTurns,
      validMessageIds
    });

    const lastTurn = finishedTurns[finishedTurns.length - 1];
    const savedAt = saveLlmDigestTransaction({
      conversationId,
      overallSummary: llmResult.overallSummary,
      topics: sanitizedTopics,
      lastMessageId: lastTurn.endMessageId,
      lastMessageSeq: Math.max(maxSeq, lastTurn.endSeq)
    });
    if (!savedAt) return null;

    emitDigestChanged({
      conversationId,
      status: "ready",
      source: "llm",
      updatedAt: savedAt
    });
    return getConversationDigest(conversationId);
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      return null;
    }
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      240
    );
    logMain().warn("conversationDigest", "async digest failed", {
      conversationId,
      error: message
    });
    const stillExists = getConversation(conversationId);
    if (!stillExists) return null;
    const errorAt = upsertDigestState({
      conversationId,
      source: normalizeDigestSource(state?.source),
      status: "error",
      lastMessageSeq: state?.last_message_seq ?? 0,
      lastError: message
    });
    emitDigestChanged({
      conversationId,
      status: "error",
      source: normalizeDigestSource(state?.source),
      updatedAt: errorAt
    });
    return null;
  }
}

async function drainDigestQueue(): Promise<void> {
  while (queuedIds.length > 0) {
    const nextId = queuedIds.shift()!;
    queuedSet.delete(nextId);
    const forceRebuild = activeForceRebuild.get(nextId) ?? false;
    activeForceRebuild.delete(nextId);

    runningConversationId = nextId;
    runningAbortController = new AbortController();
    try {
      await runConversationDigestNow(nextId, {
        forceRebuild,
        signal: runningAbortController.signal
      });
    } finally {
      runningConversationId = null;
      runningAbortController = null;
    }
  }
}

function enqueueDigestJob(conversationId: string, forceRebuild: boolean): void {
  if (forceRebuild) {
    activeForceRebuild.set(conversationId, true);
  }
  if (!queuedSet.has(conversationId)) {
    queuedSet.add(conversationId);
    queuedIds.push(conversationId);
  }
  if (!queueDrainPromise) {
    queueDrainPromise = drainDigestQueue().finally(() => {
      queueDrainPromise = null;
    });
  }
}

export function scheduleConversationDigest(
  conversationId: string,
  options?: { immediate?: boolean; forceRebuild?: boolean }
): boolean {
  const forceRebuild = options?.forceRebuild === true;
  const conv = getConversation(conversationId);
  if (!conv || conv.kind === "game") return false;
  if (conv.archived && !forceRebuild) return false;

  const config = getConversationDigestConfig();
  if (!config.enabled && !forceRebuild) return false;

  if (forceRebuild) {
    pendingForceRebuild.set(conversationId, true);
  }
  const existingTimer = pendingTimers.get(conversationId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    pendingTimers.delete(conversationId);
  }

  const delay = options?.immediate
    ? 0
    : debounceMsOverride ?? DEFAULT_DEBOUNCE_MS;

  if (delay <= 0) {
    const force = pendingForceRebuild.get(conversationId) ?? forceRebuild;
    pendingForceRebuild.delete(conversationId);
    enqueueDigestJob(conversationId, force);
    return true;
  }

  const timer = setTimeout(() => {
    pendingTimers.delete(conversationId);
    const force = pendingForceRebuild.get(conversationId) ?? false;
    pendingForceRebuild.delete(conversationId);
    enqueueDigestJob(conversationId, force);
  }, delay);
  timer.unref();
  pendingTimers.set(conversationId, timer);
  return true;
}

export function cancelConversationDigest(conversationId: string): void {
  const timer = pendingTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(conversationId);
  }
  pendingForceRebuild.delete(conversationId);
  activeForceRebuild.delete(conversationId);
  if (queuedSet.has(conversationId)) {
    queuedSet.delete(conversationId);
    const idx = queuedIds.indexOf(conversationId);
    if (idx >= 0) queuedIds.splice(idx, 1);
  }
  if (runningConversationId === conversationId && runningAbortController) {
    runningAbortController.abort();
  }
}

export function shutdownConversationDigest(): void {
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
  pendingForceRebuild.clear();
  queuedIds.length = 0;
  queuedSet.clear();
  activeForceRebuild.clear();
  if (runningAbortController) {
    runningAbortController.abort();
    runningAbortController = null;
  }
  runningConversationId = null;
}
