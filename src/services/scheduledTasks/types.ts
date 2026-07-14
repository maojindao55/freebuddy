export type ScheduledTaskStatus = "idle" | "running" | "completed" | "failed";
export type ScheduledTaskScheduleType = "once" | "daily" | "weekly" | "monthly";

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
  enabled: boolean;
}

export interface ScheduledTaskAgent {
  id: string;
  name: string;
  adapter: string;
}

export type ScheduledTaskMutationResult =
  | { ok: true; task: ScheduledTask }
  | { ok: false; errors: string[] };
