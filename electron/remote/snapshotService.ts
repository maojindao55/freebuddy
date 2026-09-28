import { listCliMembers } from "../cli/members.js";
import { listConversations, getConversation, listMessages } from "../cli/conversations.js";
import { listProjects } from "../cli/projects.js";
import { listTasks, readTaskLog } from "../cli/tasks.js";
import { listActiveWorkflowRuns } from "../cli/workflows.js";
import { listDelegationTeams, getDelegationTeam } from "../cli/delegationTeams.js";
import { MAX_CHUNK_BYTES, type HostStatus, type RemoteMethodResultMap } from "@freebuddy/protocol/remote";
import { validateHostStatus, type HostStatusInput } from "./hostStatusPublisher.js";

const PAGE_MAX = 100;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Projection is deliberately a small lexical policy rather than a collection
// of punctuation-specific boundaries.  First consume ordinary http(s) URLs so
// their path components are left intact.  The remaining alternatives cover
// only local absolute roots, Windows drive and UNC paths, and file URLs
// (including the percent-encoded spelling seen in copied logs). A recognized local reference
// ends at a syntax delimiter or newline; that is conservative for ambiguous
// prose while keeping the replacement scope bounded by one text line.
const LOCAL_REFERENCE = /(https?:\/\/[^\s"'“”‘’<>\[\]{}]+)|(file(?:%3a|:)(?:(?:%2f|\/){2,})[^\r\n"'“”‘’<>\[\]{},;，；!?！？：。]*)|(\/(?:Applications|Library|Users|Volumes|bin|dev|etc|home|mnt|opt|private|proc|root|run|sbin|srv|sys|tmp|usr|var)(?:[^\r\n"'“”‘’<>\[\]{},;，；!?！？：。]*?\.[\p{L}\p{N}]{1,16}(?=\s|$)|[^\r\n"'“”‘’<>\[\]{},;，；!?！？：。]*))|([A-Za-z]:[\\/](?:[^\r\n"'“”‘’<>\[\]{},;，；!?！？：。]*?\.[\p{L}\p{N}]{1,16}(?=\s|$)|[^\r\n"'“”‘’<>\[\]{},;，；!?！？：。]*))|((?:\\\\|(?<!:)\/\/)[^\\/\r\n"'“”‘’<>\[\]{},;，；!?！？：。]+[\\/][^\r\n"'“”‘’<>\[\]{},;，；!?！？：。]*)/giu;

function isAttachedToRelativeText(source: string, offset: number): boolean {
  // A slash immediately following a word, digit, dot, underscore, or dash is
  // a relative fragment such as "tmp/private-token.txt", not an absolute
  // local reference. This lexical rule also avoids growing a list of locale-
  // specific punctuation characters.
  const previous = Array.from(source.slice(0, offset)).at(-1);
  return !!previous && /[\p{L}\p{N}_.-]/u.test(previous);
}

const safeText = (value: string, max = 8_192) => value
  .replace(LOCAL_REFERENCE, (
    reference,
    webUrl: string | undefined,
    _fileUrl: string | undefined,
    unixPath: string | undefined,
    _windowsPath: string | undefined,
    _uncPath: string | undefined,
    offset: number,
    source: string
  ) => webUrl || (unixPath && isAttachedToRelativeText(source, offset)) ? reference : "[local-path]")
  .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
  .slice(0, max);
const MAX_PERSISTED_STREAM_BYTES = 256 * 1024;

type ProjectedMessageContent = { content: string; truncated: boolean };

function limitChunkText(value: string): ProjectedMessageContent {
  if (Buffer.byteLength(value) <= MAX_CHUNK_BYTES) return { content: value, truncated: false };

  let bytes = 0;
  let content = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > MAX_CHUNK_BYTES) break;
    content += character;
    bytes += characterBytes;
  }
  return { content, truncated: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Assistant rows persist renderer stream items, while MessageSummary.content is
 * a bounded plain-text protocol field. Never fall back to echoing structured
 * storage when parsing fails: those rows can contain control metadata or raw
 * tool data that is not safe for the remote projection.
 */
export function projectMessageContent(role: "user" | "assistant" | "system", storedContent: string): ProjectedMessageContent {
  if (role !== "assistant") return limitChunkText(safeText(storedContent, MAX_CHUNK_BYTES));

  if (storedContent.length > MAX_PERSISTED_STREAM_BYTES || Buffer.byteLength(storedContent) > MAX_PERSISTED_STREAM_BYTES) {
    return { content: "", truncated: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(storedContent);
  } catch {
    // Older assistant rows were plain text. A JSON-looking malformed value is
    // treated as an unsafe stream payload rather than reflected verbatim.
    return /^[\[{]/.test(storedContent.trim())
      ? { content: "", truncated: true }
      : limitChunkText(safeText(storedContent, MAX_CHUNK_BYTES));
  }
  if (!Array.isArray(parsed)) return { content: "", truncated: true };

  const parts: string[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (item.kind === "text" && item.role === "assistant" && typeof item.content === "string") {
      const text = safeText(item.content, MAX_CHUNK_BYTES);
      if (text.trim()) parts.push(text);
      continue;
    }
    // Renderer-visible error messages are intentionally projected without raw
    // diagnostic details. Thinking, tool I/O, sessions, configuration, usage,
    // and unknown items remain host-local by default.
    if (item.kind === "error" && typeof item.message === "string") {
      const message = safeText(item.message, 512).trim();
      if (message) parts.push(`Error: ${message}`);
    }
  }
  return limitChunkText(parts.join("\n\n"));
}
function page<T>(items: T[], cursor?: string, limit?: number) { const start = cursor ? Number.parseInt(cursor, 10) : 0; const size = Math.max(1, Math.min(PAGE_MAX, limit ?? 50)); const list = items.slice(Number.isSafeInteger(start) && start >= 0 ? start : 0, (Number.isSafeInteger(start) && start >= 0 ? start : 0) + size); const next = start + size < items.length ? String(start + size) : null; return { items: list, nextCursor: next }; }

/** Host-local state deliberately excludes Relay time. Snapshot output owns it. */
export type HostStatusSource = Omit<HostStatus, "serverTime"> & { serverTime?: unknown };

export class SnapshotService {
  constructor(
    private readonly status: () => HostStatusSource,
    private readonly baseSeq: () => number,
    private readonly now: () => number = Date.now
  ) {}
  snapshot(conversationLimit = 50): RemoteMethodResultMap["sync.snapshot"] {
    return { baseSeq: this.baseSeq(), host: this.currentHostStatus(), projects: this.projects(), agents: this.agents(), conversations: this.conversations().slice(0, Math.min(PAGE_MAX, conversationLimit)), activeRuns: [], pendingDecisions: [], activeWorkflows: [], activeDelegations: [], activeTasks: this.tasks().filter(x => x.status === "running"), activeTerminals: [] };
  }
  /**
   * `serverTime` is a host-generated protocol field, never a value copied
   * from a state callback. This keeps RPC snapshots and resume fallback
   * snapshots schema-complete even if an older caller omits, nulls, or
   * corrupts its cached time.
   */
  private currentHostStatus(): HostStatus {
    const raw = this.status();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("host status source is invalid");
    const { serverTime: _ignoredSourceTime, ...localStatus } = raw;
    return validateHostStatus(localStatus as HostStatusInput, new Date(this.now()).toISOString());
  }
  projects() { return listProjects().map(p => ({ projectId: p.id, name: safeText(p.name, 120), updatedAt: p.updatedAt })); }
  project(id: string) { return this.projects().find(project => project.projectId === id); }
  agents() { return listCliMembers().map(a => ({ agentId: a.id, name: safeText(a.name, 120), kind: "cli", available: a.enabled === true })); }
  conversations() { return listConversations({ limit: PAGE_MAX }).map(c => ({ conversationId: c.id, ...(c.projectId ? { projectId: c.projectId } : {}), title: safeText(c.title, 240), archived: c.archived, updatedAt: c.updatedAt, ...(c.lastMessageAt ? { lastMessageAt: c.lastMessageAt } : {}) })); }
  conversation(id: string) { const c = getConversation(id); return c ? { conversationId: c.id, ...(c.projectId ? { projectId: c.projectId } : {}), title: safeText(c.title, 240), archived: c.archived, updatedAt: c.updatedAt, ...(c.lastMessageAt ? { lastMessageAt: c.lastMessageAt } : {}) } : undefined; }
  messages(conversationId: string) {
    return listMessages(conversationId).map(m => {
      const projected = projectMessageContent(m.role, m.content);
      return {
        messageId: m.id,
        conversationId: m.conversationId,
        role: m.role,
        content: projected.content,
        ...(projected.truncated ? { truncated: true } : {}),
        createdAt: m.createdAt
      };
    });
  }
  tasks() { return listTasks({ limit: PAGE_MAX }).map(t => ({ taskId: t.id, title: safeText(t.promptSummary || t.prompt, 240), status: normalizeTaskStatus(t.status), updatedAt: t.updatedAt })); }
  task(id: string) { return this.tasks().find(task => task.taskId === id); }
  async taskLog(taskId: string) { const log = await readTaskLog(taskId, { limit: PAGE_MAX, maxBytes: 32_768 }); return log.entries.map((entry, index) => ({ seq: index, text: safeText(entry.content, 4096), createdAt: entry.ts || new Date(0).toISOString() })); }
  workflows() { return listActiveWorkflowRuns().map((w: any) => ({ workflowId: w.id, name: safeText(w.name || w.workflowId || w.id, 120), status: normalizeFlowStatus(w.status), updatedAt: w.updatedAt || w.startedAt || new Date(0).toISOString() })); }
  delegations() { return listDelegationTeams().map(t => ({ delegationId: t.id, name: safeText(t.name, 120), status: t.enabled ? "idle" as const : "stopped" as const, updatedAt: new Date(0).toISOString() })); }
  delegation(id: string) { const t = getDelegationTeam(id); return t ? { delegationId: t.id, name: safeText(t.name, 120), status: t.enabled ? "idle" as const : "stopped" as const, updatedAt: new Date(0).toISOString() } : undefined; }
  paged<T>(items: T[], cursor?: string, limit?: number) { return page(items, cursor, limit); }
  validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
}
function normalizeTaskStatus(value: string): "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled" { return (["pending", "running", "blocked", "completed", "failed", "cancelled"] as const).includes(value as any) ? value as any : "failed"; }
function normalizeFlowStatus(value: unknown): "idle" | "running" | "paused" | "blocked" | "completed" | "failed" | "stopped" { return (["idle", "running", "paused", "blocked", "completed", "failed", "stopped"] as const).includes(value as any) ? value as any : "failed"; }
