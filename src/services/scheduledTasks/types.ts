import type { ChatAttachment } from "@/services/cli/types";
import type { SkillSnapshot } from "@/services/skills/types";
import type { ConversationReferenceDraft } from "@/utils/conversationReferences";

export type ScheduledTaskStatus =
  | "idle"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "missed";
export type ScheduledTaskScheduleType =
  | "manual"
  | "hourly"
  | "once"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly";
export type ScheduledTaskExecutionMode = "new_conversation" | "continuous";
export type ScheduledTaskTargetKind = "new_conversation" | "conversation_message";
export type ScheduledTaskTriggerKind = "schedule" | "delay" | "quota_reset";

export interface ScheduledTaskPayload {
  messageSkills?: SkillSnapshot[];
  conversationReferences?: ConversationReferenceDraft[];
  approvalMode?: "auto" | "ask";
}

export type ScheduledTaskDispatchOutcome =
  | "sent"
  | "waiting"
  | "failed"
  | "conversation_missing";

export type ScheduledTaskDispatchClaimResult =
  | { ok: true; task: ScheduledTask; claimToken: string }
  | {
      ok: false;
      reason: "not_found" | "not_conversation_message" | "busy" | "not_due" | "disabled";
    };

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  agentId: string;
  scheduleType: ScheduledTaskScheduleType;
  timeLocal: string;
  scheduleDate?: string;
  weekdays?: number[];
  monthDay?: number;
  cwd?: string;
  configOptionOverrides?: Record<string, string>;
  executionMode: ScheduledTaskExecutionMode;
  targetKind: ScheduledTaskTargetKind;
  targetConversationId?: string;
  triggerKind: ScheduledTaskTriggerKind;
  fireAtMs?: number;
  cleanupAfterRun: boolean;
  attachments?: ChatAttachment[];
  payload?: ScheduledTaskPayload;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: ScheduledTaskStatus;
  lastError?: string;
  lastConversationId?: string;
  lastWorkflowRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskInput {
  title: string;
  prompt: string;
  agentId: string;
  scheduleType: ScheduledTaskScheduleType;
  timeLocal: string;
  scheduleDate?: string;
  weekdays?: number[];
  monthDay?: number;
  cwd?: string;
  configOptionOverrides?: Record<string, string>;
  executionMode: ScheduledTaskExecutionMode;
  targetKind?: ScheduledTaskTargetKind;
  targetConversationId?: string;
  triggerKind?: ScheduledTaskTriggerKind;
  fireAtMs?: number;
  cleanupAfterRun?: boolean;
  attachments?: ChatAttachment[];
  payload?: ScheduledTaskPayload;
  enabled: boolean;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  status: Exclude<ScheduledTaskStatus, "idle">;
  startedAt: string;
  endedAt?: string;
  conversationId?: string;
  workflowRunId?: string;
  error?: string;
}

export interface ScheduledTaskAgent {
  id: string;
  name: string;
  adapter: string;
}

export type ScheduledTaskMutationResult =
  | { ok: true; task: ScheduledTask }
  | { ok: false; errors: string[] };
