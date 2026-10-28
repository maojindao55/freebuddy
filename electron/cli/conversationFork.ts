import { nanoid } from "nanoid";
import { getDb } from "./db.js";
import {
  createConversation,
  listMessages,
  requireOwnedConversation,
  type Conversation
} from "./conversations.js";
import { copyFileEditBlobsForFork } from "./fileEditBlobs.js";

export interface ForkConversationInput {
  sourceConversationId: string;
  /** Fork point: messages up to and including this one are copied. */
  throughMessageId: string;
  targetConversationId?: string;
  /** Title for the fork; defaults to the source title. */
  title?: string;
}

export interface ForkConversationResult {
  conversation: Conversation;
  copiedMessages: number;
}

/**
 * Session markers point at the source conversation's native agent session,
 * whose state keeps growing past the fork point. Dropping them keeps the fork
 * on the fresh-session path instead of resuming (and contaminating) the source
 * session, even after an app restart. Blob keys are re-keyed to the fork, so
 * serialized blobKey references must be rewritten in lockstep.
 */
function forkAssistantContent(
  content: string,
  blobKeyMap: Map<string, string>
): string {
  let items: unknown;
  try {
    items = JSON.parse(content);
  } catch {
    return content;
  }
  if (!Array.isArray(items)) return content;
  const kept: unknown[] = [];
  for (const item of items) {
    if (item && typeof item === "object" && (item as { kind?: unknown }).kind === "session") {
      continue;
    }
    kept.push(rewriteBlobKeys(item, blobKeyMap));
  }
  return JSON.stringify(kept);
}

function rewriteBlobKeys(value: unknown, blobKeyMap: Map<string, string>): unknown {
  if (!blobKeyMap.size) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteBlobKeys(entry, blobKeyMap));
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      next[key] =
        key === "blobKey" && typeof entry === "string" && blobKeyMap.has(entry)
          ? blobKeyMap.get(entry)
          : rewriteBlobKeys(entry, blobKeyMap);
    }
    return next;
  }
  return value;
}

/**
 * Create a new conversation containing the source conversation's messages up
 * to and including the fork point. The source is never modified; copied rows
 * get fresh ids while keeping their original timestamps so ordering survives.
 */
export function forkConversation(input: ForkConversationInput): ForkConversationResult {
  if (
    typeof input.sourceConversationId !== "string" ||
    !input.sourceConversationId.trim()
  ) {
    throw new Error("A source conversation id is required.");
  }
  if (typeof input.throughMessageId !== "string" || !input.throughMessageId.trim()) {
    throw new Error("A fork message id is required.");
  }
  const source = requireOwnedConversation(input.sourceConversationId);
  if (!source) throw new Error("Source conversation not found");
  if (source.kind && source.kind !== "default") {
    throw new Error("Only default conversations can be forked.");
  }
  // listMessages (not listMessagesForIpc): the fork needs the full untruncated
  // history regardless of the IPC paging budget.
  const sourceMessages = listMessages(source.id);
  const throughIndex = sourceMessages.findIndex(
    (message) => message.id === input.throughMessageId
  );
  if (throughIndex < 0) {
    throw new Error("Fork message not found in the source conversation.");
  }
  const sourceSlice = sourceMessages.slice(0, throughIndex + 1);
  const targetConversationId = input.targetConversationId?.trim() || nanoid();
  const db = getDb();

  const conversation = db.transaction(() => {
    const fork = createConversation({
      id: targetConversationId,
      title: input.title?.trim() || source.title,
      agentId: source.agentId,
      agentName: source.agentName,
      adapter: source.adapter,
      kind: "default",
      // Merge on top of the source metadata: dropping it would lose the
      // conversation's mcpServerIds and Git worktree (taskWorkspace) config.
      metadata: {
        ...(source.metadata ?? {}),
        forkedFrom: source.id,
        forkedAtMessageId: input.throughMessageId
      },
      cwd: source.cwd,
      projectId: source.projectId,
      approvalMode: source.approvalMode,
      configOptionOverrides: source.configOptionOverrides,
      titleSource: "user"
    });
    // createConversation resolves snapshots from skill ids; carry over the
    // source's pinned snapshot verbatim instead.
    db.prepare("UPDATE conversations SET skill_snapshot = ? WHERE id = ?").run(
      JSON.stringify(source.skillSnapshot ?? []),
      targetConversationId
    );

    const taskIds = [
      ...new Set(
        sourceSlice
          .map((message) => message.taskId)
          .filter((taskId): taskId is string => Boolean(taskId))
      )
    ];
    const blobKeyMap = copyFileEditBlobsForFork(
      source.id,
      targetConversationId,
      taskIds
    );

    const insertMessage = db.prepare(
      `INSERT INTO conversation_messages
         (id, conversation_id, role, status, content, attachments, skill_snapshot, task_id,
          agent_id, agent_name, adapter, role_label,
          workflow_run_id, workflow_step_row_id, author_username,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const message of sourceSlice) {
      insertMessage.run(
        nanoid(),
        targetConversationId,
        message.role,
        message.status,
        message.role === "assistant"
          ? forkAssistantContent(message.content, blobKeyMap)
          : message.content,
        message.attachments?.length
          ? JSON.stringify(message.attachments)
          : null,
        message.skillSnapshot?.length
          ? JSON.stringify(message.skillSnapshot)
          : null,
        message.taskId ?? null,
        message.agentId ?? null,
        message.agentName ?? null,
        message.adapter ?? null,
        message.roleLabel ?? null,
        message.workflowRunId ?? null,
        message.workflowStepRowId ?? null,
        message.authorUsername ?? null,
        message.createdAt,
        message.updatedAt
      );
    }

    db.prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?").run(
      sourceSlice[sourceSlice.length - 1]?.createdAt ?? null,
      targetConversationId
    );
    return fork;
  })();

  return { conversation, copiedMessages: sourceSlice.length };
}
