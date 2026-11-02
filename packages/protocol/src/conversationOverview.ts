import type { ToolCallStatus, ToolKind } from "./cli.js";

export type ConversationOverviewStatus =
  | "starting"
  | "running"
  | "waiting"
  | "needs-input"
  | "paused"
  | "completed"
  | "failed"
  | "stopped"
  | "idle"
  | "unknown";

/** A short, structured activity with a real source message for navigation. */
export interface ConversationActivity {
  id: string;
  messageId: string;
  toolCallId?: string;
  kind: "tool-call" | "file-edit" | "command" | "error";
  toolKind?: ToolKind;
  status: ToolCallStatus;
  /** Raw path, command or tool name. Display labels belong to the renderer. */
  target: string;
  filePath?: string;
}

export interface ConversationOverview {
  conversationId: string;
  status: ConversationOverviewStatus;
  updatedAt: string;
  model?: string;
  summary?: string;
  activities: ConversationActivity[];
  runId?: string;
  taskId?: string;
  attentionCount?: number;
  error?: string;
}
