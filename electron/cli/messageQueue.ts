import crypto from "node:crypto";
import { z } from "zod";
import { getDb } from "./db.js";
import { requireOwnedConversation, updateMessage } from "./conversations.js";
import { cleanupManagedAttachmentsIfUnreferenced } from "./attachments.js";
import { clearSessionOwner, getSessionOwner } from "./sessionOwners.js";
import type { CliEvent } from "./runtimeShared.js";
import { supportsMessageQueue } from "../shared/messageQueueTypes.js";
import type {
  ConversationSendClaim, MessageQueueCommand, MessageQueueSnapshot,
  QueuedMessage, QueuedMessageInput
} from "../shared/messageQueueTypes.js";

const LEASE_MS = 45_000;
const claims = new Map<string, ConversationSendClaim & { windowId: number; expires: number; running: boolean; done?: boolean; cancelled: boolean; failed: boolean }>();
const editors = new Map<string, { id: string; token: string; windowId: number; expires: number }>();
const attachmentSchema = z.object({
  id: z.string().min(1), kind: z.enum(["image", "document", "code"]),
  name: z.string().max(1024), path: z.string().min(1).max(16_384),
  mimeType: z.string().optional(), size: z.number().nonnegative().optional(),
  extension: z.string().optional(), managed: z.boolean().optional()
});
const entrySchema = z.object({
  id: z.string().min(1).max(128), prompt: z.string().max(1_000_000),
  attachments: z.array(attachmentSchema).max(10),
  messageSkills: z.array(z.object({
    id: z.string(), name: z.string(), description: z.string(), version: z.string(),
    source: z.enum(["builtin", "imported", "market"]), rootPath: z.string(), contentHash: z.string()
  })).max(50).optional(),
  conversationReferences: z.array(z.object({ id: z.string(), title: z.string(), agentName: z.string() })).max(20).optional(),
  approvalMode: z.enum(["auto", "ask"]).optional(),
  configOptionOverrides: z.record(z.string(), z.string()).optional(),
  hiddenContext: z.string().max(1_000_000).optional()
});

function owned(id: string) {
  if (typeof id !== "string" || !id) throw new Error("conversation_not_found");
  const conversation = requireOwnedConversation(id);
  if (!conversation) throw new Error("conversation_not_found");
  return conversation;
}

function queueSupported(id: string) {
  if (!supportsMessageQueue(owned(id))) {
    throw new Error("message_queue_unsupported");
  }
}

function setPaused(id: string, paused: boolean, reason?: string, error?: string) {
  getDb().prepare(`INSERT INTO conversation_queue_state(conversation_id, paused, reason, error) VALUES (?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET paused = excluded.paused, reason = excluded.reason, error = excluded.error`)
    .run(id, paused ? 1 : 0, reason ?? null, error ?? null);
}

/** Also used by stop/archive paths; scoped access is checked by the caller. */
export function pauseMessageQueue(id: string, reason = "stopped"): void {
  if (!getDb().prepare("SELECT 1 FROM conversation_message_queue WHERE conversation_id = ? LIMIT 1").get(id)) return;
  setPaused(id, true, reason);
}

function expireLeases(id: string) {
  const claim = claims.get(id);
  if (claim && !claim.running && claim.expires < Date.now()) {
    claims.delete(id);
    clearSessionOwner(claim.sessionId);
    getDb().prepare("UPDATE conversation_message_queue SET claim_token = NULL WHERE conversation_id = ? AND claim_token = ?").run(id, claim.sessionId);
    pauseMessageQueue(id, "interrupted");
    if (claim.done) {
      // A closed renderer cannot acknowledge/persist its reply. Recover the
      // dangling placeholder just as startup recovery does, instead of leaving
      // the conversation spinning forever. Pending prompts remain paused.
      const messages = getDb().prepare("SELECT id FROM conversation_messages WHERE conversation_id = ? AND task_id = ? AND status IN ('starting', 'running')").all(id, claim.sessionId) as Array<{ id: string }>;
      for (const message of messages) updateMessage({ id: message.id, status: "failed" });
    }
  }
  const editor = editors.get(id);
  if (editor && editor.expires < Date.now()) editors.delete(id);
}

function databaseBusy(id: string): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM conversation_messages m JOIN cli_tasks t ON t.id = m.task_id
    WHERE m.conversation_id = ? AND t.status IN ('starting', 'running') LIMIT 1`).get(id));
}

export function getMessageQueue(id: string): MessageQueueSnapshot {
  const conversation = owned(id);
  const supported = supportsMessageQueue(conversation);
  expireLeases(id);
  let row = getDb().prepare("SELECT paused, reason, error FROM conversation_queue_state WHERE conversation_id = ?").get(id) as { paused: number; reason: string | null; error: string | null } | undefined;
  const rows = getDb().prepare("SELECT * FROM conversation_message_queue WHERE conversation_id = ? ORDER BY sequence").all(id) as Array<{
    payload: string; user_message_id: string; assistant_message_id: string; created_at: string; claim_token: string | null
  }>;
  const entries: QueuedMessage[] = rows.map(item => ({
    ...JSON.parse(item.payload) as QueuedMessageInput, conversationId: id,
    userMessageId: item.user_message_id, assistantMessageId: item.assistant_message_id,
    createdAt: item.created_at, sending: Boolean(item.claim_token)
  }));
  if (!supported && entries.length) {
    const reason = conversation.archived ? "archived" : "unsupported";
    if (!row?.paused || row.reason !== reason || row.error) setPaused(id, true, reason);
    row = { paused: 1, reason, error: null };
  }
  return { conversationId: id, supported, entries, paused: Boolean(row?.paused) && entries.length > 0,
    reason: row?.reason ?? undefined, error: row?.error ?? undefined, editingId: editors.get(id)?.id,
    busy: claims.has(id) || databaseBusy(id) };
}

export function listMessageQueues(): MessageQueueSnapshot[] {
  const rows = getDb().prepare("SELECT DISTINCT conversation_id FROM conversation_message_queue").all() as Array<{ conversation_id: string }>;
  return rows.filter(row => requireOwnedConversation(row.conversation_id)).map(row => getMessageQueue(row.conversation_id));
}

export function changeMessageQueue(command: MessageQueueCommand, windowId: number): MessageQueueSnapshot {
  const id = command.conversationId;
  owned(id);
  if (command.action === "enqueue" || command.action === "resume") queueSupported(id);
  expireLeases(id);
  const state = getMessageQueue(id);
  if (command.action === "enqueue") {
    const entry = entrySchema.parse(command.entry);
    if (!entry.prompt.trim() && !entry.attachments.length) throw new Error("message_queue_empty");
    // Stable client id makes an IPC retry safe after a lost response.
    const hash = crypto.createHash("sha256").update(JSON.stringify(entry)).digest("hex");
    const existing = getDb().prepare("SELECT conversation_id, payload_hash FROM conversation_queue_receipts WHERE id = ?").get(entry.id) as { conversation_id: string; payload_hash: string } | undefined;
    if (existing) {
      if (existing.conversation_id !== id || existing.payload_hash !== hash) throw new Error("message_queue_id_conflict");
      return state;
    }
    if (state.entries.length >= 50) throw new Error("message_queue_full");
    for (const reference of entry.conversationReferences ?? []) {
      if (reference.id === id || !requireOwnedConversation(reference.id)) throw new Error("message_queue_reference_unavailable");
    }
    getDb().transaction(() => {
      getDb().prepare("INSERT OR IGNORE INTO conversation_queue_state(conversation_id) VALUES (?)").run(id);
      getDb().prepare("INSERT INTO conversation_queue_receipts(id, conversation_id, payload_hash) VALUES (?, ?, ?)").run(entry.id, id, hash);
      getDb().prepare(`INSERT INTO conversation_message_queue(id, conversation_id, payload, attachments,
        user_message_id, assistant_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(entry.id, id, JSON.stringify(entry), JSON.stringify(entry.attachments), crypto.randomUUID(), crypto.randomUUID(), new Date().toISOString());
    })();
  } else if (command.action === "pause" || command.action === "resume") {
    if (command.action === "resume" && editors.has(id)) throw new Error("message_queue_editing");
    const claim = claims.get(id);
    if (command.action === "resume" && claim && (claim.cancelled || claim.failed || claim.done)) throw new Error("message_queue_waiting_for_finish");
    const error = command.action === "pause" && command.error ? z.string().max(4096).parse(command.error) : undefined;
    setPaused(id, command.action === "pause", command.action === "pause" ? error ? "failed" : "manual" : undefined, error);
  } else {
    const entry = state.entries.find(item => item.id === command.id);
    if (!entry) throw new Error("message_queue_entry_missing");
    if (entry.sending) throw new Error("message_queue_sending");
    const editor = editors.get(id);
    if (command.action === "edit") {
      if (editor && (editor.token !== command.token || editor.windowId !== windowId)) throw new Error("message_queue_editing");
      editors.set(id, { id: entry.id, token: command.token, windowId, expires: Date.now() + LEASE_MS });
    } else if (command.action === "save" || command.action === "cancelEdit") {
      if (!editor || editor.id !== entry.id || editor.token !== command.token || editor.windowId !== windowId) throw new Error("message_queue_edit_expired");
      if (command.action === "save") {
        const prompt = z.string().max(1_000_000).parse(command.prompt).trim();
        if (!prompt && !entry.attachments.length) throw new Error("message_queue_empty");
        const { conversationId: _conversationId, userMessageId: _userId, assistantMessageId: _assistantId, createdAt: _createdAt, sending: _sending, ...payload } = entry;
        getDb().prepare("UPDATE conversation_message_queue SET payload = ? WHERE conversation_id = ? AND id = ?")
          .run(JSON.stringify({ ...payload, prompt }), id, entry.id);
      }
      editors.delete(id);
    } else if (command.action === "remove") {
      if (editor) throw new Error("message_queue_editing");
      getDb().prepare("DELETE FROM conversation_message_queue WHERE conversation_id = ? AND id = ?").run(id, entry.id);
      cleanupManagedAttachmentsIfUnreferenced(entry.attachments.map(file => file.path));
      if (state.entries.length === 1) setPaused(id, false);
    }
  }
  return getMessageQueue(id);
}

/** Shared by manual, scheduled and queued sends, before any message persistence. */
export function claimConversationSend(input: ConversationSendClaim, windowId: number): boolean {
  const conversation = owned(input.conversationId);
  if (conversation.archived) return false;
  if (!input.sessionId || typeof input.sessionId !== "string" || input.sessionId.length > 128) throw new Error("message_queue_invalid_session");
  expireLeases(input.conversationId);
  const current = claims.get(input.conversationId);
  if (current) {
    if (current.sessionId !== input.sessionId || current.windowId !== windowId || current.cancelled) return false;
    current.expires = Date.now() + LEASE_MS;
    return true;
  }
  // Session ids are global, including sessions that do not belong to this
  // conversation. Never let a fresh claim overwrite their ownership binding.
  if (getSessionOwner(input.sessionId) || [...claims.values()].some(claim => claim.sessionId === input.sessionId) ||
      getDb().prepare("SELECT 1 FROM cli_tasks WHERE id = ?").get(input.sessionId)) return false;
  const queue = getMessageQueue(input.conversationId);
  if (queue.busy || queue.editingId) return false;
  if (input.queueId) {
    queueSupported(input.conversationId);
    if (queue.paused || queue.entries[0]?.id !== input.queueId) return false;
  } else if (queue.entries.length) return false;
  claims.set(input.conversationId, { ...input, windowId, expires: Date.now() + LEASE_MS, running: false, cancelled: false, failed: false });
  if (input.queueId) getDb().prepare("UPDATE conversation_message_queue SET claim_token = ? WHERE conversation_id = ? AND id = ?").run(input.sessionId, input.conversationId, input.queueId);
  return true;
}

export function releaseConversationSend(input: ConversationSendClaim, windowId: number): void {
  const claim = claims.get(input.conversationId);
  if (!claim || claim.sessionId !== input.sessionId || claim.windowId !== windowId || claim.running || claim.done) return;
  claims.delete(input.conversationId);
  clearSessionOwner(input.sessionId);
  getDb().prepare("UPDATE conversation_message_queue SET claim_token = NULL WHERE conversation_id = ? AND claim_token = ?").run(input.conversationId, input.sessionId);
}

/** Called immediately before launching, after async workspace preparation. */
export function acceptConversationSend(input: ConversationSendClaim, windowId: number): void {
  const claim = claims.get(input.conversationId);
  if (!claim || claim.sessionId !== input.sessionId || claim.windowId !== windowId || claim.cancelled || claim.running) throw new Error("conversation_send_not_claimed");
  if (claim.queueId) {
    queueSupported(input.conversationId);
    const queue = getMessageQueue(input.conversationId);
    if (queue.paused || queue.editingId) throw new Error("message_queue_paused");
    const entry = queue.entries.find(item => item.id === claim.queueId);
    if (!entry || !getDb().prepare(`SELECT 1 FROM conversation_messages WHERE id = ? AND conversation_id = ? AND role = 'user'`).get(entry.userMessageId, input.conversationId) ||
        !getDb().prepare(`SELECT 1 FROM conversation_messages WHERE id = ? AND conversation_id = ? AND role = 'assistant' AND task_id = ?`).get(entry.assistantMessageId, input.conversationId, input.sessionId)) {
      throw new Error("message_queue_messages_not_persisted");
    }
    getDb().prepare("DELETE FROM conversation_message_queue WHERE conversation_id = ? AND id = ? AND claim_token = ?").run(input.conversationId, claim.queueId, input.sessionId);
  }
  claim.running = true;
}

export function conversationSendEvent(id: string, sessionId: string, event: CliEvent): void {
  const claim = claims.get(id);
  if (!claim || claim.sessionId !== sessionId) return;
  if (event.type === "error" || (event.type === "items" && event.items.some(item => item.kind === "error" && item.terminal))) {
    claim.failed = true;
    pauseMessageQueue(id, "failed");
  }
  if (event.type === "done") {
    if (event.exitCode !== 0 || claim.failed || claim.cancelled) pauseMessageQueue(id, claim.cancelled ? "stopped" : "failed");
    // The next turn must also see the persisted answer, including errors parsed
    // from raw stdout by the renderer. Hold until cli:updateMessage commits it.
    claim.done = true;
    claim.running = false;
    claim.expires = Date.now() + LEASE_MS;
  }
}

export function acknowledgeConversationSend(messageId: string): void {
  const message = getDb().prepare("SELECT conversation_id, task_id, status FROM conversation_messages WHERE id = ? AND role = 'assistant'").get(messageId) as { conversation_id: string; task_id: string; status: string } | undefined;
  if (!message || !["done", "failed", "killed"].includes(message.status)) return;
  const claim = claims.get(message.conversation_id);
  if (!claim?.done || claim.sessionId !== message.task_id) return;
  if (message.status !== "done") pauseMessageQueue(message.conversation_id, message.status === "killed" ? "stopped" : "failed");
  claims.delete(message.conversation_id);
}

export function cancelConversationSend(sessionId: string): void {
  for (const [id, claim] of claims) if (claim.sessionId === sessionId) {
    claim.cancelled = true;
    pauseMessageQueue(id, "stopped");
  }
}

export function resetMessageQueueLeasesForTests(): void { claims.clear(); editors.clear(); }
