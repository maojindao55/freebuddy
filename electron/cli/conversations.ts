import { getDb } from "./db.js";
import {
  discardManagedAttachmentIfUnreferenced,
  isManagedAttachmentPath
} from "./attachments.js";
import { resolveSkillSnapshots } from "./skills.js";
import type { SkillSnapshot } from "./skillTypes.js";
import { getCallerUserId, isCallerAdmin } from "./callerContext.js";
import { getUserById } from "./users.js";
import { findProjectByCwd } from "./projects.js";
import {
  listRemoteWorkspaces,
  sourcePathForManagedWorkspace,
  type RemoteWorkspace
} from "./remoteWorkspaces.js";

let notifyMessagesChangedHandler: ((conversationId: string) => void) | null = null;

export function bindConversationNotifier(
  fn: ((conversationId: string) => void) | null
): void {
  notifyMessagesChangedHandler = fn;
}

export interface ChatAttachment {
  id: string;
  kind: "image" | "document" | "code";
  name: string;
  path: string;
  mimeType?: string;
  size?: number;
  extension?: string;
  managed?: boolean;
}

export type ConversationTitleSource = "default" | "prompt" | "agent" | "user";

export interface Conversation {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  adapter: string;
  cwd?: string;
  /** Assigned source path shown to remote users; cwd remains the execution path. */
  sourceCwd?: string;
  projectId?: string;
  approvalMode?: "auto" | "ask";
  configOptionOverrides?: Record<string, string>;
  skillSnapshot: SkillSnapshot[];
  titleSource?: ConversationTitleSource;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  sourceConversationId?: string;
  sourceAgentId?: string;
  sourceAgentName?: string;
  sourceAdapter?: string;
  sourceBriefId?: string;
  ownerId?: string | null;
  ownerUsername?: string | null;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  /** running | done | failed | killed | sent */
  status: string;
  /** For user messages: raw text. For assistant: serialized CliStreamItem[]. */
  content: string;
  attachments?: ChatAttachment[];
  taskId?: string;
  agentId?: string;
  agentName?: string;
  adapter?: string;
  roleLabel?: string;
  workflowRunId?: string;
  workflowStepRowId?: string;
  authorUsername?: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseConfigOptionOverrides(
  raw: unknown
): Record<string, string> | undefined {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length === 0 ||
    !entries.every(
      ([, v]) => typeof v === "string"
    )
  ) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

const TITLE_SOURCES: ConversationTitleSource[] = [
  "default",
  "prompt",
  "agent",
  "user"
];

function parseTitleSource(raw: unknown): ConversationTitleSource | undefined {
  return TITLE_SOURCES.includes(raw as ConversationTitleSource)
    ? (raw as ConversationTitleSource)
    : undefined;
}

function rowToConversation(
  r: any,
  workspaceCache = new Map<string, RemoteWorkspace[]>()
): Conversation {
  const ownerId = r.owner_id ?? null;
  const cwd = r.cwd ?? undefined;
  let sourceCwd: string | undefined;
  if (ownerId && cwd) {
    let workspaces = workspaceCache.get(ownerId);
    if (!workspaces) {
      workspaces = listRemoteWorkspaces(ownerId);
      workspaceCache.set(ownerId, workspaces);
    }
    sourceCwd = sourcePathForManagedWorkspace(cwd, workspaces);
  }
  return {
    id: r.id,
    title: r.title,
    agentId: r.agent_id,
    agentName: r.agent_name,
    adapter: r.adapter,
    cwd,
    sourceCwd,
    projectId: r.project_id ?? undefined,
    approvalMode:
      r.approval_mode === "ask" || r.approval_mode === "auto"
        ? r.approval_mode
        : undefined,
    configOptionOverrides: parseConfigOptionOverrides(
      r.config_option_overrides
    ),
    skillSnapshot: parseSkillSnapshot(r.skill_snapshot),
    titleSource: parseTitleSource(r.title_source),
    archived: r.archived === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at ?? undefined,
    sourceConversationId: r.source_conversation_id ?? undefined,
    sourceAgentId: r.source_agent_id ?? undefined,
    sourceAgentName: r.source_agent_name ?? undefined,
    sourceAdapter: r.source_adapter ?? undefined,
    sourceBriefId: r.source_brief_id ?? undefined,
    ownerId,
    ownerUsername: r.owner_username ?? null
  };
}

function parseSkillSnapshot(raw: unknown): SkillSnapshot[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SkillSnapshot =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        typeof entry.name === "string" &&
        typeof entry.rootPath === "string" &&
        typeof entry.contentHash === "string"
    );
  } catch {
    return [];
  }
}

function rowToMessage(r: any): ConversationMessage {
  let attachments: ChatAttachment[] | undefined;
  if (r.attachments) {
    try {
      const parsed = JSON.parse(r.attachments);
      if (Array.isArray(parsed)) attachments = parsed;
    } catch {
      attachments = undefined;
    }
  }

  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    status: r.status,
    content: r.content,
    attachments,
    taskId: r.task_id ?? undefined,
    agentId: r.agent_id ?? undefined,
    agentName: r.agent_name ?? undefined,
    adapter: r.adapter ?? undefined,
    roleLabel: r.role_label ?? undefined,
    workflowRunId: r.workflow_run_id ?? undefined,
    workflowStepRowId: r.workflow_step_row_id ?? undefined,
    authorUsername: r.author_username ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export interface CreateConversationInput {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  adapter: string;
  cwd?: string;
  projectId?: string;
  approvalMode?: "auto" | "ask";
  configOptionOverrides?: Record<string, string>;
  skillIds?: string[];
  titleSource?: ConversationTitleSource;
  sourceConversationId?: string;
  sourceAgentId?: string;
  sourceAgentName?: string;
  sourceAdapter?: string;
  sourceBriefId?: string;
  ownerId?: string | null;
}

export function createConversation(input: CreateConversationInput): Conversation {
  const now = new Date().toISOString();
  const ownerId = input.ownerId ?? getCallerUserId() ?? null;
  let projectId = input.projectId;
  if (!projectId && input.cwd) {
    const matched = findProjectByCwd(input.cwd);
    if (matched) projectId = matched.id;
  }
  getDb()
    .prepare(
      `INSERT INTO conversations
         (id, title, agent_id, agent_name, adapter, cwd, project_id, approval_mode,
          config_option_overrides, skill_snapshot, title_source, archived,
          source_conversation_id, source_agent_id, source_agent_name,
          source_adapter, source_brief_id, owner_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.title,
      input.agentId,
      input.agentName,
      input.adapter,
      input.cwd ?? null,
      projectId ?? null,
      input.approvalMode ?? null,
      input.configOptionOverrides &&
        Object.keys(input.configOptionOverrides).length > 0
        ? JSON.stringify(input.configOptionOverrides)
        : null,
      JSON.stringify(resolveSkillSnapshots(input.skillIds ?? [])),
      input.titleSource ?? "default",
      input.sourceConversationId ?? null,
      input.sourceAgentId ?? null,
      input.sourceAgentName ?? null,
      input.sourceAdapter ?? null,
      input.sourceBriefId ?? null,
      ownerId,
      now,
      now
    );
  return getConversation(input.id) as Conversation;
}

export function backfillMissingOwners(ownerId: string): number {
  const info = getDb()
    .prepare("UPDATE conversations SET owner_id = ? WHERE owner_id IS NULL")
    .run(ownerId);
  return info.changes;
}

export function setConversationSkills(
  id: string,
  skillIds: string[]
): Conversation | undefined {
  getDb()
    .prepare("UPDATE conversations SET skill_snapshot = ?, updated_at = ? WHERE id = ?")
    .run(
      JSON.stringify(resolveSkillSnapshots(skillIds)),
      new Date().toISOString(),
      id
    );
  return getConversation(id);
}

export function setConversationApprovalMode(
  id: string,
  approvalMode: "auto" | "ask" | null
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE conversations SET approval_mode = ?, updated_at = ? WHERE id = ?`
    )
    .run(approvalMode, now, id);
}

export function setConversationProjectId(
  id: string,
  projectId: string | null
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE conversations SET project_id = ?, updated_at = ? WHERE id = ?`
    )
    .run(projectId, now, id);
}

export function setConversationConfigOptionOverrides(
  id: string,
  overrides: Record<string, string> | null
): void {
  const now = new Date().toISOString();
  const value =
    overrides && Object.keys(overrides).length > 0
      ? JSON.stringify(overrides)
      : null;
  getDb()
    .prepare(
      `UPDATE conversations SET config_option_overrides = ?, updated_at = ? WHERE id = ?`
    )
    .run(value, now, id);
}

export function getConversation(id: string): Conversation | undefined {
  const row = getDb()
    .prepare(
      `SELECT c.*, u.username AS owner_username
       FROM conversations c
       LEFT JOIN remote_users u ON u.id = c.owner_id
       WHERE c.id = ?`
    )
    .get(id) as any;
  return row ? rowToConversation(row) : undefined;
}

export interface ListConversationsArgs {
  archived?: boolean;
  agentId?: string;
  limit?: number;
  ownerId?: string | null;
}

export function listConversations(args: ListConversationsArgs = {}): Conversation[] {
  const where: string[] = [];
  const params: any[] = [];
  where.push("c.archived = ?");
  params.push(args.archived ? 1 : 0);
  if (args.agentId) {
    where.push("c.agent_id = ?");
    params.push(args.agentId);
  }
  const owner = args.ownerId !== undefined ? args.ownerId : getCallerUserId();
  if (owner !== null && owner !== undefined && !isCallerAdmin()) {
    where.push("c.owner_id = ?");
    params.push(owner);
  }
  const sql = `
    SELECT c.*, u.username AS owner_username
    FROM conversations c
    LEFT JOIN remote_users u ON u.id = c.owner_id
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC
    LIMIT ?`;
  params.push(args.limit ?? 200);
  const workspaceCache = new Map<string, RemoteWorkspace[]>();
  return (getDb().prepare(sql).all(...params) as any[]).map((row) =>
    rowToConversation(row, workspaceCache)
  );
}

export function requireOwnedConversation(id: string): Conversation | undefined {
  const conv = getConversation(id);
  if (!conv) return undefined;
  if (isCallerAdmin()) return conv;
  const caller = getCallerUserId();
  if (caller === null) return conv;
  return conv.ownerId === caller ? conv : undefined;
}

// Message-level gate for handlers that only receive a message id. Kept as a
// single joined query because it sits on the streaming update path.
export function callerCanAccessMessage(messageId: string): boolean {
  if (isCallerAdmin()) return true;
  const caller = getCallerUserId();
  if (caller === null) return true;
  const row = getDb()
    .prepare(
      `SELECT c.owner_id AS owner_id
       FROM conversation_messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = ?`
    )
    .get(messageId) as { owner_id: string | null } | undefined;
  return row ? row.owner_id === caller : false;
}

export function renameConversation(
  id: string,
  title: string,
  titleSource?: ConversationTitleSource | null
): void {
  const now = new Date().toISOString();
  if (titleSource) {
    getDb()
      .prepare(
        `UPDATE conversations SET title = ?, title_source = ?, updated_at = ? WHERE id = ?`
      )
      .run(title, titleSource, now, id);
  } else {
    getDb()
      .prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, now, id);
  }
}

export function updateConversationAgentName(
  agentId: string,
  agentName: string
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE conversations SET agent_name = ?, updated_at = ? WHERE agent_id = ?`
    )
    .run(agentName, now, agentId);
}

export function archiveConversation(id: string, archived: boolean): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?`
    )
    .run(archived ? 1 : 0, now, id);
}

export function deleteConversation(id: string): void {
  const managedPaths: string[] = [];
  const rows = getDb()
    .prepare(
      `SELECT attachments FROM conversation_messages WHERE conversation_id = ? AND attachments IS NOT NULL`
    )
    .all(id) as Array<{ attachments: string | null }>;

  for (const row of rows) {
    if (!row.attachments) continue;
    try {
      const attachments = JSON.parse(row.attachments) as ChatAttachment[];
      for (const attachment of attachments) {
        if (isManagedAttachmentPath(attachment.path)) {
          managedPaths.push(attachment.path);
        }
      }
    } catch {
      // ignore malformed attachment JSON
    }
  }

  getDb().prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  for (const filePath of managedPaths) {
    discardManagedAttachmentIfUnreferenced(filePath);
  }
}

function touchConversation(id: string, lastMessageAt?: string) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE conversations SET updated_at = ?, last_message_at = COALESCE(?, last_message_at) WHERE id = ?`
    )
    .run(now, lastMessageAt ?? now, id);
}

export interface AppendMessageInput {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  status: string;
  content: string;
  attachments?: ChatAttachment[];
  taskId?: string;
  agentId?: string;
  agentName?: string;
  adapter?: string;
  roleLabel?: string;
  workflowRunId?: string;
  workflowStepRowId?: string;
  authorUsername?: string | null;
}

export function appendMessage(input: AppendMessageInput): ConversationMessage {
  const now = new Date().toISOString();
  const caller = getCallerUserId();
  const authorUsername =
    input.authorUsername !== undefined
      ? input.authorUsername
      : caller
        ? getUserById(caller)?.username ?? null
        : null;
  getDb()
    .prepare(
      `INSERT INTO conversation_messages
         (id, conversation_id, role, status, content, attachments, task_id,
          agent_id, agent_name, adapter, role_label,
          workflow_run_id, workflow_step_row_id, author_username,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.conversationId,
      input.role,
      input.status,
      input.content,
      input.attachments?.length ? JSON.stringify(input.attachments) : null,
      input.taskId ?? null,
      input.agentId ?? null,
      input.agentName ?? null,
      input.adapter ?? null,
      input.roleLabel ?? null,
      input.workflowRunId ?? null,
      input.workflowStepRowId ?? null,
      authorUsername,
      now,
      now
    );
  touchConversation(input.conversationId, now);
  notifyMessagesChangedHandler?.(input.conversationId);
  return getMessage(input.id) as ConversationMessage;
}

export interface UpdateMessageInput {
  id: string;
  status?: string;
  content?: string;
  taskId?: string;
}

export function updateMessage(input: UpdateMessageInput): void {
  const now = new Date().toISOString();
  const fields: string[] = ["updated_at = ?"];
  const params: any[] = [now];
  if (input.status !== undefined) {
    fields.push("status = ?");
    params.push(input.status);
  }
  if (input.content !== undefined) {
    fields.push("content = ?");
    params.push(input.content);
  }
  if (input.taskId !== undefined) {
    fields.push("task_id = ?");
    params.push(input.taskId);
  }
  params.push(input.id);
  getDb()
    .prepare(`UPDATE conversation_messages SET ${fields.join(", ")} WHERE id = ?`)
    .run(...params);
  if (input.status !== undefined) {
    const msg = getMessage(input.id);
    if (msg) notifyMessagesChangedHandler?.(msg.conversationId);
  }
}

// A force-quit while an agent is streaming leaves the assistant message row at
// 'running'/'starting' with no live process to finish it. On restart the UI
// would otherwise show a permanent "thinking" state that can't be stopped, so
// reconcile those orphaned rows to a terminal status.
export function recoverInterruptedMessages(): number {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE conversation_messages
       SET status = 'failed', updated_at = ?
       WHERE status IN ('running', 'starting')`
    )
    .run(now);
  return result.changes;
}

export function getMessage(id: string): ConversationMessage | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM conversation_messages WHERE id = ?`)
    .get(id) as any;
  return row ? rowToMessage(row) : undefined;
}

export function listMessage(id: string): ConversationMessage | undefined {
  return getMessage(id);
}

export function listMessages(conversationId: string): ConversationMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM conversation_messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`
    )
    .all(conversationId) as any[];
  return rows.map(rowToMessage);
}
