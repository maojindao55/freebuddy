export type ConversationTopicStatus = "open" | "done" | "blocked" | "abandoned";

export type ConversationDigestStatus =
  | "idle"
  | "queued"
  | "running"
  | "ready"
  | "error";

export type ConversationDigestSource = "rule" | "llm";

export interface ConversationTopic {
  id: string;
  conversationId: string;
  sortOrder: number;
  title: string;
  summary: string;
  status: ConversationTopicStatus;
  source: ConversationDigestSource;
  startMessageId: string;
  endMessageId: string;
  turnCount: number;
  keywords: string[];
  files: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDigest {
  conversationId: string;
  overallSummary?: string;
  source: ConversationDigestSource;
  status: ConversationDigestStatus;
  lastMessageId?: string;
  lastMessageSeq: number;
  topicCount: number;
  topics: ConversationTopic[];
  error?: string;
  updatedAt: string;
}

export interface ConversationTopicSearchHit {
  topicId: string;
  conversationId: string;
  conversationTitle: string;
  conversationCwd?: string;
  agentId: string;
  agentName: string;
  adapter: string;
  title: string;
  summary: string;
  status: ConversationTopicStatus;
  source: ConversationDigestSource;
  startMessageId: string;
  endMessageId: string;
  files: string[];
  updatedAt: string;
}

export interface ConversationDigestConfig {
  enabled: boolean;
  providerId: string;
  model: string;
  minUserTurns: number;
}

export interface ConversationDigestAvailability {
  hasAvailableProvider: boolean;
  resolvedProviderId?: string;
  resolvedProviderName?: string;
  resolvedModel?: string;
}

export interface ConversationDigestConfigState {
  config: ConversationDigestConfig;
  availability: ConversationDigestAvailability;
}

export interface ConversationDigestChangedEvent {
  conversationId: string;
  status: ConversationDigestStatus;
  source: ConversationDigestSource;
  updatedAt: string;
}
