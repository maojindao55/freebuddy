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
