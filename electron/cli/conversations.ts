import { getDb } from "./db.js";

export interface ChatAttachment {
  id: string;
  kind: "image" | "document" | "code";
  name: string;
  path: string;
  mimeType?: string;
  size?: number;
  extension?: string;
}

export interface Conversation {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  adapter: string;
  cwd?: string;
  approvalMode?: "auto" | "ask";
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
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
  createdAt: string;
  updatedAt: string;
}

function rowToConversation(r: any): Conversation {
  return {
    id: r.id,
    title: r.title,
    agentId: r.agent_id,
    agentName: r.agent_name,
    adapter: r.adapter,
    cwd: r.cwd ?? undefined,
    approvalMode:
      r.approval_mode === "ask" || r.approval_mode === "auto"
        ? r.approval_mode
        : undefined,
    archived: r.archived === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at ?? undefined
  };
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
  approvalMode?: "auto" | "ask";
}

export function createConversation(input: CreateConversationInput): Conversation {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO conversations
         (id, title, agent_id, agent_name, adapter, cwd, approval_mode, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      input.id,
      input.title,
      input.agentId,
      input.agentName,
      input.adapter,
      input.cwd ?? null,
      input.approvalMode ?? null,
      now,
      now
    );
  return getConversation(input.id) as Conversation;
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

export function getConversation(id: string): Conversation | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM conversations WHERE id = ?`)
    .get(id) as any;
  return row ? rowToConversation(row) : undefined;
}

export interface ListConversationsArgs {
  archived?: boolean;
  agentId?: string;
  limit?: number;
}

export function listConversations(args: ListConversationsArgs = {}): Conversation[] {
  const where: string[] = [];
  const params: any[] = [];
  where.push("archived = ?");
  params.push(args.archived ? 1 : 0);
  if (args.agentId) {
    where.push("agent_id = ?");
    params.push(args.agentId);
  }
  const sql = `
    SELECT * FROM conversations
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(last_message_at, updated_at) DESC
    LIMIT ?`;
  params.push(args.limit ?? 200);
  return (getDb().prepare(sql).all(...params) as any[]).map(rowToConversation);
}

export function renameConversation(id: string, title: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title, now, id);
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
  getDb().prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
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
}

export function appendMessage(input: AppendMessageInput): ConversationMessage {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO conversation_messages
         (id, conversation_id, role, status, content, attachments, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.conversationId,
      input.role,
      input.status,
      input.content,
      input.attachments?.length ? JSON.stringify(input.attachments) : null,
      input.taskId ?? null,
      now,
      now
    );
  touchConversation(input.conversationId, now);
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
}

export function getMessage(id: string): ConversationMessage | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM conversation_messages WHERE id = ?`)
    .get(id) as any;
  return row ? rowToMessage(row) : undefined;
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
