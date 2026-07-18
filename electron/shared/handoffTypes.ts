// electron/shared/handoffTypes.ts
// Parallel type definitions for the electron/ side. These mirror the
// handoff-related interfaces in src/services/cli/types.ts. The two copies
// must be kept in sync manually (same convention as Conversation, which
// is defined in both electron/cli/conversations.ts and src/services/cli/types.ts).

export interface HandoffBriefFileChange {
  path: string;
  action: "edit" | "create" | "delete" | "read" | string;
  toolName?: string;
}

export interface HandoffBriefMessageRef {
  messageId: string;
  role: "user" | "assistant";
  createdAt: string;
  excerpt: string;
}

export interface HandoffBriefSource {
  conversationId: string;
  agentId: string;
  agentName: string;
  adapter: string;
  title: string;
  cwd?: string;
  messageCount: number;
}

export interface HandoffBrief {
  version: 1;
  generatedAt: string;
  source: HandoffBriefSource;
  originalGoal: string;
  recentUserMessages: string[];
  lastAssistantSummary: string;
  fileChanges: HandoffBriefFileChange[];
  transcriptExcerpts: HandoffBriefMessageRef[];
}

export interface HandoffTranscriptAttachment {
  name: string;
  kind: "image" | "document" | "code";
  mimeType?: string;
  size?: number;
}

export interface HandoffTranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  status: string;
  content: unknown;
  attachments?: HandoffTranscriptAttachment[];
  taskId?: string;
  agentId?: string;
  agentName?: string;
  adapter?: string;
  roleLabel?: string;
  createdAt: string;
  truncated?: boolean;
}

export interface HandoffTranscriptRef {
  format: "jsonl";
  path: string;
  messageCount: number;
  byteSize: number;
  truncated: boolean;
}

export interface HandoffBriefRow {
  id: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceAgentId: string;
  sourceAgentName: string;
  sourceAdapter: string;
  brief: HandoffBrief | null;
  sourceMessageCount: number;
  sourceLastMessageId?: string;
  transcript?: HandoffTranscriptRef;
  createdAt: string;
}

// Subset of stream item shapes that the extractor inspects. Structurally
// compatible with src/services/cli/streamParser.ts CliStreamItem so
// JSON.parse of stored assistant content fits.
export interface ParsedAssistantStreamItem {
  kind: string;
  content?: string;
  path?: string;
  action?: string;
  tool?: string;
  toolKind?: string;
  locations?: { path: string; line?: number }[];
}

export interface PreviewHandoffBriefInput {
  sourceConversationId: string;
}

export interface PreviewHandoffBriefResult {
  brief: HandoffBrief | null;
  warning?: "brief_extraction_failed";
}

export interface TransferConversationInput {
  sourceConversationId: string;
  targetConversationId: string;
  targetAgentId: string;
  targetAgentName: string;
  targetAdapter: string;
}

export interface TransferConversationResult {
  // Note: 'conversation' uses the electron-side Conversation type, which is
  // defined in electron/cli/conversations.ts. To avoid a circular import
  // (conversations.ts → handoffBriefs.ts → handoffTypes.ts → conversations.ts),
  // we type it as the structural equivalent here. Conversation has additional
  // fields beyond these (skillSnapshot, archived, etc.) but they are not
  // required for the renderer to consume the transfer result.
  conversation: {
    id: string;
    title: string;
    agentId: string;
    agentName: string;
    adapter: string;
    cwd?: string;
  };
  briefId: string | null;
  seedPrompt: string;
  warning?: "brief_extraction_failed";
}
