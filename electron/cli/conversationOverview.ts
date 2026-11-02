import type {
  ConversationActivity,
  ConversationOverview,
  ConversationOverviewStatus,
  ToolCallStatus,
  ToolKind
} from "@freebuddy/protocol";
import { getDb } from "./db.js";
import { getCallerUserId, isCallerAdmin } from "./callerContext.js";
import { pendingSessionInputCount, pendingSessionInputCounts } from "./runtimeShared.js";

export const CONVERSATION_OVERVIEW_BATCH_SIZE = 100;
const MESSAGE_LIMIT = 12;
const CONTENT_BYTES = 128 * 1024;
const ACTIVITY_LIMIT = 6;
const PARSE_CACHE_LIMIT = 128;
const TOOL_KINDS = new Set<ToolKind>([
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "mode", "other"
]);
const TOOL_STATUSES = new Set<ToolCallStatus>(["pending", "running", "completed", "failed"]);

interface ConversationRow {
  id: string;
  owner_id: string | null;
  updated_at: string;
}
interface MessageRow {
  id: string;
  sequence: number;
  created_at: string;
  updated_at: string;
  status: string;
  task_id: string | null;
  workflow_run_id?: string | null;
  content?: string | null;
}
interface TaskRow {
  id: string;
  status: string;
  session_id: string | null;
  error_message: string | null;
  updated_at: string;
}
interface RunRow {
  id: string;
  status: string;
  kind: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}
interface ParsedMessage {
  activities: ConversationActivity[];
  summary?: string;
  model?: string;
  error?: string;
}
const parseCache = new Map<string, { content: string; status: string; parsed: ParsedMessage }>();

function shortText(value: unknown, limit = 180): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, limit) : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function sourcePath(value: unknown): string | undefined {
  // Keep exact navigation evidence; a shortened path could target a different file.
  return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : undefined;
}
function fallbackToolStatus(messageStatus: string): ToolCallStatus {
  return messageStatus === "starting" ? "pending" :
    messageStatus === "running" ? "running" :
    ["failed", "killed", "cancelled"].includes(messageStatus) ? "failed" :
    ["done", "completed"].includes(messageStatus) ? "completed" : "pending";
}
function toolStatus(value: unknown, fallback: ToolCallStatus): ToolCallStatus {
  return TOOL_STATUSES.has(value as ToolCallStatus) ? value as ToolCallStatus : fallback;
}

/** Only structured, navigable evidence is projected. No stdout or reasoning. */
function parseMessage(message: MessageRow): ParsedMessage {
  const content = message.content;
  if (!content) return { activities: [] };
  // Keep one projection per message even when a live stream updates frequently.
  const cacheKey = message.id;
  const cached = parseCache.get(cacheKey);
  if (cached?.content === content && cached.status === message.status) {
    parseCache.delete(cacheKey);
    parseCache.set(cacheKey, cached);
    return cached.parsed;
  }
  let items: unknown;
  try { items = JSON.parse(content); } catch { return { activities: [] }; }
  if (!Array.isArray(items)) return { activities: [] };
  const activities = new Map<string, ConversationActivity>();
  let summary: string | undefined;
  let model: string | undefined;
  let error: string | undefined;
  const fallback = fallbackToolStatus(message.status);
  for (let index = 0; index < items.length; index += 1) {
    const item = object(items[index]);
    if (!item) continue;
    if (item.kind === "text" && item.role === "assistant") {
      if (typeof item.content === "string" && item.content) {
        // The database read already bounds the entire JSON body to 128KB.
        // Preserve chunk separators until the preview is bounded below.
        summary = item.append ? `${summary ?? ""}${item.content}` : item.content;
      }
      continue;
    }
    if (item.kind === "config-options" && Array.isArray(item.options)) {
      for (const rawOption of item.options) {
        const option = object(rawOption);
        if (option && (option.id === "model" || option.category === "model")) {
          model = shortText(option.currentLabel) ?? shortText(option.currentValue) ?? model;
        }
      }
      continue;
    }
    if (item.kind === "tool-result") {
      const key = typeof item.id === "string" ? `tool:${item.id}` : undefined;
      const previous = key ? activities.get(key) : undefined;
      if (previous) previous.status = item.isError ? "failed" : "completed";
      continue;
    }
    let activity: ConversationActivity | undefined;
    let key: string;
    if (item.kind === "tool-call") {
      const toolKind = TOOL_KINDS.has(item.toolKind as ToolKind) ? item.toolKind as ToolKind : undefined;
      if (toolKind === "think") continue;
      const toolCallId = typeof item.id === "string" && item.id && item.id.length <= 512 ? item.id : undefined;
      key = toolCallId ? `tool:${toolCallId}` : `tool-index:${index}`;
      const previous = activities.get(key);
      const input = object(item.input);
      const location = Array.isArray(item.locations) ? object(item.locations[0]) : undefined;
      const outputs = Array.isArray(item.toolOutputs) ? item.toolOutputs.map(object) : [];
      const edit = outputs.find((entry) => entry?.kind === "file-edit");
      const filePath = sourcePath(location?.path) ?? sourcePath(input?.path) ??
        sourcePath(input?.file_path) ?? sourcePath(input?.filePath) ??
        sourcePath(edit?.path) ?? previous?.filePath;
      const command = shortText(input?.command) ?? shortText(input?.cmd);
      const target = command ?? shortText(filePath) ?? shortText(input?.pattern) ??
        shortText(input?.query) ?? shortText(input?.url) ?? previous?.target ?? shortText(item.tool);
      if (!target) continue;
      activity = {
        id: `${message.id}:${key}`, messageId: message.id,
        ...(toolCallId ? { toolCallId } : {}), kind: "tool-call",
        ...((toolKind ?? previous?.toolKind) ? { toolKind: toolKind ?? previous?.toolKind } : {}),
        status: item.isError ? "failed" : toolStatus(item.status, previous?.status ?? fallback),
        target, ...(filePath ? { filePath } : {})
      };
    } else if (item.kind === "file-edit") {
      const filePath = sourcePath(item.path);
      if (!filePath) continue;
      key = `file:${filePath}`;
      activity = {
        id: `${message.id}:${key}`, messageId: message.id, kind: "file-edit",
        toolKind: item.action === "delete" ? "delete" : "edit",
        status: toolStatus(item.status, fallback), target: shortText(filePath)!, filePath
      };
    } else if (item.kind === "command") {
      const target = shortText(item.command);
      if (!target) continue;
      key = `command:${index}`;
      activity = {
        id: `${message.id}:${key}`, messageId: message.id,
        kind: "command", toolKind: "execute", status: fallback, target
      };
    } else if (item.kind === "error") {
      const target = shortText(item.message, 300);
      if (!target) continue;
      key = `error:${index}`;
      error = target;
      activity = { id: `${message.id}:${key}`, messageId: message.id, kind: "error", status: "failed", target };
    } else continue;
    activities.set(key, activity);
  }
  if (summary) {
    // Code needs its opening marker; ordinary prose keeps its latest progress.
    const containsCode = /`{3,}|~{3,}/.test(summary) || /(?:^|\n)\s*(?:mermaid\s+)?(?:sequenceDiagram|flowchart\s+(?:TD|TB|BT|RL|LR)|graph\s+(?:TD|TB|BT|RL|LR)|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|mindmap|timeline)\s*(?=\n|$)/.test(summary);
    summary = (containsCode ? summary.trim().slice(0, 420) : summary.trim().slice(-420)) || undefined;
  }
  const parsed = { activities: [...activities.values()].slice(-ACTIVITY_LIMIT), summary, model, error };
  parseCache.set(cacheKey, { content, status: message.status, parsed });
  while (parseCache.size > PARSE_CACHE_LIMIT) parseCache.delete(parseCache.keys().next().value!);
  return parsed;
}

function statusFromTask(status: string): ConversationOverviewStatus {
  switch (status) {
    case "starting": return "starting";
    case "running": return "running";
    case "queued": case "waiting": case "pending": return "waiting";
    case "paused": return "paused";
    case "done": case "completed": return "completed";
    case "failed": case "timeout": return "failed";
    case "killed": case "cancelled": case "stopped": return "stopped";
    default: return "unknown";
  }
}
function statusFromRun(run: RunRow): ConversationOverviewStatus {
  if (run.status === "pending_approval") return "needs-input";
  if (run.status === "blocked") return run.kind === "delegation" ? "needs-input" : "waiting";
  if (run.status === "partial") return "failed";
  return statusFromTask(run.status);
}
function afterOrEqual(message: MessageRow, user: MessageRow | undefined): boolean {
  return !user || message.created_at > user.created_at ||
    (message.created_at === user.created_at && message.sequence > user.sequence);
}

/**
 * IDs are scoped in SQL before any task or message reads. Every card uses indexed
 * metadata probes and at most 12 short assistant bodies from the latest turn.
 */
export function listConversationOverviews(conversationIds: string[]): ConversationOverview[] {
  if (!Array.isArray(conversationIds)) return [];
  const ids = [...new Set(conversationIds.slice(0, CONVERSATION_OVERVIEW_BATCH_SIZE)
    .filter((id) => typeof id === "string" && id.length > 0 && id.length <= 200))];
  if (!ids.length) return [];
  const db = getDb();
  const caller = getCallerUserId();
  const scoped = caller !== null && !isCallerAdmin();
  const rows = db.prepare(`SELECT id, owner_id, updated_at FROM conversations
    WHERE archived = 0 AND id IN (${ids.map(() => "?").join(",")})${scoped ? " AND owner_id = ?" : ""}`)
    .all(...ids, ...(scoped ? [caller] : [])) as ConversationRow[];
  const visible = new Map(rows.map((row) => [row.id, row]));
  const newestMessage = db.prepare(`SELECT id, rowid AS sequence, created_at, updated_at, status, task_id, workflow_run_id
    FROM conversation_messages WHERE conversation_id = ? AND role = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  const newestTaskMessage = db.prepare(`SELECT id, rowid AS sequence, created_at, updated_at, status, task_id, workflow_run_id
    FROM conversation_messages WHERE conversation_id = ? AND role = 'assistant' AND task_id IS NOT NULL
    ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  const taskQuery = db.prepare(`SELECT id, status, session_id,
    substr(error_message, 1, 300) AS error_message, updated_at FROM cli_tasks WHERE id = ? AND owner_id IS ?`);
  const runQuery = db.prepare(`SELECT id, status, kind, substr(summary, 1, 420) AS summary, created_at, updated_at
    FROM workflow_runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  const pendingCounts = pendingSessionInputCounts();
  const pendingSessions = [...pendingCounts.keys()].slice(0, 512);
  const pendingRunTasks = pendingSessions.length ? db.prepare(`SELECT m.task_id, m.workflow_run_id, t.session_id
    FROM cli_tasks t JOIN conversation_messages m ON m.task_id = t.id
    WHERE t.id IN (${pendingSessions.map(() => "?").join(",")})
      AND m.conversation_id = ? AND t.owner_id IS ? AND t.status IN ('starting', 'running')
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 32`) : undefined;
  // SQLite can reject oversized bodies from record metadata, without loading
  // hundreds of MB merely to substr() them. JSON is never sent to the renderer.
  const messagesQuery = db.prepare(`SELECT id, rowid AS sequence, created_at, updated_at, status, task_id,
    CASE WHEN octet_length(content) <= ${CONTENT_BYTES} THEN content ELSE NULL END AS content
    FROM conversation_messages WHERE conversation_id = ? AND role = 'assistant'
      AND (created_at > ? OR (created_at = ? AND rowid > ?))
    ORDER BY created_at DESC, rowid DESC LIMIT ${MESSAGE_LIMIT}`);
  const result: ConversationOverview[] = [];
  for (const id of ids) {
    const conversation = visible.get(id);
    if (!conversation) continue;
    const user = newestMessage.get(id, "user") as MessageRow | undefined;
    const latestAssistant = newestMessage.get(id, "assistant") as MessageRow | undefined;
    const taskMessage = newestTaskMessage.get(id) as MessageRow | undefined;
    const currentAssistant = latestAssistant && afterOrEqual(latestAssistant, user) ? latestAssistant : undefined;
    const startingNewAttempt = currentAssistant && !currentAssistant.task_id &&
      ["starting", "running", "failed", "killed"].includes(currentAssistant.status) &&
      (!taskMessage || currentAssistant.sequence > taskMessage.sequence);
    const currentTaskMessage = taskMessage && afterOrEqual(taskMessage, user) && !startingNewAttempt ? taskMessage : undefined;
    // A corrupt/foreign task association cannot expose another owner's task.
    const task = currentTaskMessage?.task_id
      ? taskQuery.get(currentTaskMessage.task_id, conversation.owner_id) as TaskRow | undefined : undefined;
    const latestRun = runQuery.get(id) as RunRow | undefined;
    const runStatus = latestRun ? statusFromRun(latestRun) : undefined;
    const activeRun = runStatus && ["running", "starting", "waiting", "needs-input", "paused"].includes(runStatus);
    // Older delegation messages predate the explicit workflow_run_id binding;
    // their task IDs use the runtime's stable del-<runId>-<nodeId>-<turn> form.
    const taskBelongsToLatestRun = latestRun && currentTaskMessage &&
      (currentTaskMessage.workflow_run_id === latestRun.id ||
       (latestRun.kind === "delegation" && currentTaskMessage.task_id?.startsWith(`del-${latestRun.id}-`)));
    const newerIndependentAttempt = latestRun && currentTaskMessage &&
      !taskBelongsToLatestRun &&
      currentTaskMessage.created_at > latestRun.updated_at;
    const run = latestRun && !newerIndependentAttempt && !startingNewAttempt &&
      (activeRun || !user || latestRun.updated_at >= user.created_at) ? latestRun : undefined;
    const assistantStatus = currentAssistant &&
      (["starting", "running", "failed", "killed"].includes(currentAssistant.status) || currentAssistant.task_id)
      ? statusFromTask(currentAssistant.status) : "idle";
    let status: ConversationOverviewStatus = run ? statusFromRun(run) : task ? statusFromTask(task.status) :
      assistantStatus;
    // Startup recovery marks interrupted assistant rows failed. A task row left
    // running by the force-quit must not revive that abandoned attempt.
    if (!run && task?.status === "running" && currentTaskMessage &&
      ["failed", "killed"].includes(currentTaskMessage.status) &&
      currentTaskMessage.updated_at >= task.updated_at) {
      status = statusFromTask(currentTaskMessage.status);
    }
    let attentionCount = status === "needs-input" ? 1 : 0;
    if (["running", "starting", "waiting"].includes(status)) {
      if (run && pendingRunTasks) {
        const pendingTasks = pendingRunTasks.all(...pendingSessions, id, conversation.owner_id) as
          Array<{ task_id: string; workflow_run_id: string | null; session_id: string | null }>;
        const seen = new Set<string>();
        for (const candidate of pendingTasks) {
          const belongs = candidate.workflow_run_id === run.id ||
            (run.kind === "delegation" && candidate.task_id.startsWith(`del-${run.id}-`));
          if (!belongs || seen.has(candidate.task_id)) continue;
          seen.add(candidate.task_id);
          attentionCount += pendingCounts.get(candidate.session_id ?? candidate.task_id) ?? 0;
        }
      } else if (task) attentionCount += pendingSessionInputCount(task.session_id ?? task.id);
      if (attentionCount) status = "needs-input";
    }
    const messages = messagesQuery.all(id, user?.created_at ?? "", user?.created_at ?? "", user?.sequence ?? 0) as MessageRow[];
    let activities: ConversationActivity[] = [];
    let summary: string | undefined;
    let model: string | undefined;
    let error: string | undefined;
    for (const message of messages.reverse()) {
      const parsed = parseMessage(message);
      activities = [...activities, ...parsed.activities].slice(-ACTIVITY_LIMIT);
      summary = parsed.summary ?? summary;
      model = parsed.model ?? model;
      error = parsed.error ?? error;
    }
    // Historical tool errors in a successful/new turn are not the card error.
    error = status === "failed" ? shortText(task?.error_message, 300) ?? error : undefined;
    summary = summary ?? shortText(run?.summary, 420);
    const updatedAt = [conversation.updated_at, user?.updated_at, currentAssistant?.updated_at, task?.updated_at, run?.updated_at]
      .filter((value): value is string => Boolean(value)).sort().at(-1)!;
    result.push({
      conversationId: id, status, updatedAt, activities,
      ...(model ? { model } : {}), ...(summary ? { summary } : {}),
      ...(run ? { runId: run.id } : {}), ...(task ? { taskId: task.id } : {}),
      ...(attentionCount ? { attentionCount } : {}), ...(error ? { error } : {})
    });
  }
  return result;
}
