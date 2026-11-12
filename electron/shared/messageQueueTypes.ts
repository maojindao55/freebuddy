/** Serializable outbox payload; never contains executables, environment or credentials. */
export interface QueuedMessageInput {
  id: string;
  prompt: string;
  attachments: Array<{
    id: string;
    kind: "image" | "document" | "code";
    name: string;
    path: string;
    mimeType?: string;
    size?: number;
    extension?: string;
    managed?: boolean;
  }>;
  messageSkills?: Array<{
    id: string; name: string; description: string; version: string;
    source: "builtin" | "imported" | "market"; rootPath: string; contentHash: string;
  }>;
  conversationReferences?: Array<{ id: string; title: string; agentName: string }>;
  approvalMode?: "auto" | "ask";
  configOptionOverrides?: Record<string, string>;
  hiddenContext?: string;
}

export interface QueuedMessage extends QueuedMessageInput {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: string;
  sending: boolean;
}

/** The host also checks historical workflow/delegation runs when setting this flag. */
export function supportsMessageQueue(conversation?: {
  kind?: string;
  archived?: boolean;
  messageQueueSupported?: boolean;
} | null): boolean {
  return Boolean(conversation && !conversation.archived &&
    (!conversation.kind || conversation.kind === "default") && conversation.messageQueueSupported !== false);
}

export interface MessageQueueSnapshot {
  conversationId: string;
  supported: boolean;
  entries: QueuedMessage[];
  paused: boolean;
  reason?: string;
  error?: string;
  editingId?: string;
  busy: boolean;
}

export type MessageQueueCommand = { conversationId: string } & (
  | { action: "enqueue"; entry: QueuedMessageInput }
  | { action: "remove"; id: string }
  | { action: "pause"; error?: string }
  | { action: "resume" }
  | { action: "edit" | "cancelEdit"; id: string; token: string }
  | { action: "save"; id: string; token: string; prompt: string }
);

export interface ConversationSendClaim {
  conversationId: string;
  sessionId: string;
  queueId?: string;
}
