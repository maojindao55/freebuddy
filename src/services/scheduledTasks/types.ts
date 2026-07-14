export type ScheduledTaskStatus = "idle" | "running" | "completed" | "failed";
export type ScheduledTaskScheduleType =
  | "manual"
  | "hourly"
  | "once"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly";
export type ScheduledTaskExecutionMode = "new_conversation" | "continuous";

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
  executionMode: ScheduledTaskExecutionMode;
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
  executionMode: ScheduledTaskExecutionMode;
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
