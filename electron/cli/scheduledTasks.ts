import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { randomUUID } from "node:crypto";

import { getDb } from "./db.js";
import { appendMessage, createConversation, getConversation } from "./conversations.js";
import { listCliMembers } from "./members.js";
import { createCliStepExecutor, WorkflowRuntime } from "./workflowRuntime.js";
import { extractVisibleStepOutput } from "./workflowScheduler.js";
import type { WorkflowAgentRef, WorkflowPlan } from "./workflowTypes.js";
import {
  buildScheduledTaskPrompt,
  isValidLocalDate,
  isValidLocalTime,
  nextScheduledOccurrence,
  systemTimeZone,
  type ScheduledTaskScheduleType
} from "./scheduledTaskUtils.js";

export type ScheduledTaskStatus = "idle" | "running" | "completed" | "failed";
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

interface ScheduledTaskRow {
  id: string;
  title: string;
  prompt: string;
  agent_id: string;
  time_local: string;
  schedule_type: string;
  schedule_date: string | null;
  weekdays: string | null;
  month_day: number | null;
  execution_mode: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: ScheduledTaskStatus | null;
  last_error: string | null;
  last_conversation_id: string | null;
  last_workflow_run_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ScheduledTaskRunRow {
  id: string;
  task_id: string;
  status: Exclude<ScheduledTaskStatus, "idle">;
  started_at: string;
  ended_at: string | null;
  conversation_id: string | null;
  workflow_run_id: string | null;
  error: string | null;
}

const SCHEDULE_TYPES = new Set<ScheduledTaskScheduleType>([
  "once",
  "manual",
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly"
]);
const EXECUTION_MODES = new Set<ScheduledTaskExecutionMode>([
  "new_conversation",
  "continuous"
]);
const runningTaskIds = new Set<string>();
let schedulerTimer: ReturnType<typeof setInterval> | undefined;
let schedulerWebContents: (() => WebContents | undefined) | undefined;
let lastKnownTimeZone: string | undefined;

function parseWeekdays(value: string | null): number[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(
      (day): day is number => Number.isInteger(day) && day >= 0 && day <= 6
    );
  } catch {
    return undefined;
  }
}

function rowToTask(row: ScheduledTaskRow): ScheduledTask {
  const scheduleType = SCHEDULE_TYPES.has(row.schedule_type as ScheduledTaskScheduleType)
    ? (row.schedule_type as ScheduledTaskScheduleType)
    : "daily";
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    agentId: row.agent_id,
    scheduleType,
    timeLocal: row.time_local,
    scheduleDate: row.schedule_date ?? undefined,
    weekdays: parseWeekdays(row.weekdays),
    monthDay: row.month_day ?? undefined,
    executionMode: EXECUTION_MODES.has(row.execution_mode as ScheduledTaskExecutionMode)
      ? (row.execution_mode as ScheduledTaskExecutionMode)
      : "new_conversation",
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastStatus: row.last_status ?? undefined,
    lastError: row.last_error ?? undefined,
    lastConversationId: row.last_conversation_id ?? undefined,
    lastWorkflowRunId: row.last_workflow_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToRun(row: ScheduledTaskRunRow): ScheduledTaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    workflowRunId: row.workflow_run_id ?? undefined,
    error: row.error ?? undefined
  };
}

export function listScheduledTasks(): ScheduledTask[] {
  return (getDb()
    .prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC")
    .all() as ScheduledTaskRow[]).map(rowToTask);
}

export function getScheduledTask(id: string): ScheduledTask | undefined {
  const row = getDb()
    .prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
    .get(id) as ScheduledTaskRow | undefined;
  return row ? rowToTask(row) : undefined;
}

export function listScheduledTaskRuns(taskId: string): ScheduledTaskRun[] {
  return (getDb()
    .prepare(
      `SELECT * FROM scheduled_task_runs
       WHERE task_id = ?
       ORDER BY started_at DESC
       LIMIT 50`
    )
    .all(taskId) as ScheduledTaskRunRow[]).map(rowToRun);
}

function scheduleOf(input: ScheduledTaskInput | ScheduledTask) {
  return {
    scheduleType: input.scheduleType,
    timeLocal: input.timeLocal,
    scheduleDate: input.scheduleDate,
    weekdays: input.weekdays,
    monthDay: input.monthDay
  };
}

function validateInput(input: ScheduledTaskInput): string[] {
  const errors: string[] = [];
  if (!input.title?.trim()) errors.push("task title is required");
  if (!input.prompt?.trim()) errors.push("task instructions are required");
  if (!SCHEDULE_TYPES.has(input.scheduleType)) errors.push("schedule type is invalid");
  if (!EXECUTION_MODES.has(input.executionMode)) errors.push("execution mode is invalid");
  if (
    input.scheduleType !== "manual" &&
    input.scheduleType !== "hourly" &&
    !isValidLocalTime(input.timeLocal)
  ) {
    errors.push("run time must use HH:mm");
  }
  if (
    input.scheduleType === "once" &&
    (!input.scheduleDate || !isValidLocalDate(input.scheduleDate))
  ) {
    errors.push("a valid run date is required");
  }
  if (
    input.scheduleType === "weekly" &&
    !(input.weekdays ?? []).some((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  ) {
    errors.push("select at least one weekday");
  }
  if (
    input.scheduleType === "monthly" &&
    (!Number.isInteger(input.monthDay) || input.monthDay! < 1 || input.monthDay! > 31)
  ) {
    errors.push("month day must be between 1 and 31");
  }
  if (
    input.enabled &&
    input.scheduleType === "once" &&
    isValidLocalTime(input.timeLocal) &&
    Boolean(input.scheduleDate && isValidLocalDate(input.scheduleDate)) &&
    !nextScheduledOccurrence(scheduleOf(input), systemTimeZone())
  ) {
    errors.push("one-time task must be scheduled in the future");
  }
  const member = listCliMembers().find(
    (candidate) => candidate.id === input.agentId && candidate.enabled !== false
  );
  if (!member) errors.push("selected agent is unavailable");
  return errors;
}

function nextRunAt(input: ScheduledTaskInput | ScheduledTask, after = new Date()): string | null {
  if (!input.enabled) return null;
  return nextScheduledOccurrence(scheduleOf(input), systemTimeZone(), after)?.toISOString() ?? null;
}

export function createScheduledTask(
  input: ScheduledTaskInput
): { ok: true; task: ScheduledTask } | { ok: false; errors: string[] } {
  const errors = validateInput(input);
  if (errors.length) return { ok: false, errors };
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks
        (id, title, prompt, agent_id, time_local, schedule_type,
         schedule_date, weekdays, month_day, execution_mode, enabled,
         next_run_at, last_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`
    )
    .run(
      id,
      input.title.trim(),
      input.prompt.trim(),
      input.agentId,
      input.timeLocal,
      input.scheduleType,
      input.scheduleType === "once" ? input.scheduleDate ?? null : null,
      input.scheduleType === "weekly" ? JSON.stringify(input.weekdays ?? []) : null,
      input.scheduleType === "monthly" ? input.monthDay ?? null : null,
      input.executionMode,
      input.enabled ? 1 : 0,
      nextRunAt(input),
      now,
      now
    );
  const task = getScheduledTask(id)!;
  notifyChanged(task);
  return { ok: true, task };
}

export function updateScheduledTask(
  id: string,
  input: ScheduledTaskInput
): { ok: true; task: ScheduledTask } | { ok: false; errors: string[] } {
  if (!getScheduledTask(id)) return { ok: false, errors: ["task not found"] };
  const errors = validateInput(input);
  if (errors.length) return { ok: false, errors };
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET title = ?, prompt = ?, agent_id = ?, time_local = ?,
           schedule_type = ?, schedule_date = ?, weekdays = ?,
           month_day = ?, execution_mode = ?, enabled = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      input.title.trim(),
      input.prompt.trim(),
      input.agentId,
      input.timeLocal,
      input.scheduleType,
      input.scheduleType === "once" ? input.scheduleDate ?? null : null,
      input.scheduleType === "weekly" ? JSON.stringify(input.weekdays ?? []) : null,
      input.scheduleType === "monthly" ? input.monthDay ?? null : null,
      input.executionMode,
      input.enabled ? 1 : 0,
      nextRunAt(input),
      now,
      id
    );
  const task = getScheduledTask(id)!;
  notifyChanged(task);
  return { ok: true, task };
}

function previousRunContext(task: ScheduledTask): string | undefined {
  if (task.executionMode !== "continuous" || !task.lastWorkflowRunId) return undefined;
  const row = getDb()
    .prepare(
      `SELECT result_json
       FROM workflow_steps
       WHERE workflow_run_id = ? AND status = 'done' AND result_json IS NOT NULL
       ORDER BY COALESCE(ended_at, updated_at) DESC
       LIMIT 1`
    )
    .get(task.lastWorkflowRunId) as { result_json: string } | undefined;
  if (!row?.result_json) return undefined;
  try {
    const parsed = JSON.parse(row.result_json) as { items?: unknown[] };
    const output = extractVisibleStepOutput(parsed.items ?? []).trim();
    return output ? output.slice(-12_000) : undefined;
  } catch {
    return undefined;
  }
}

export function deleteScheduledTask(id: string): boolean {
  if (runningTaskIds.has(id)) return false;
  const changed =
    getDb().prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id).changes > 0;
  if (changed) notifyChanged();
  return changed;
}

function updateRunState(
  id: string,
  patch: {
    enabled?: boolean;
    nextRunAt?: string | null;
    lastRunAt?: string;
    lastStatus?: ScheduledTaskStatus;
    lastError?: string | null;
    lastConversationId?: string;
    lastWorkflowRunId?: string;
  }
): ScheduledTask | undefined {
  const fields = ["updated_at = ?"];
  const params: unknown[] = [new Date().toISOString()];
  const add = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.enabled !== undefined) add("enabled", patch.enabled ? 1 : 0);
  if (patch.nextRunAt !== undefined) add("next_run_at", patch.nextRunAt);
  if (patch.lastRunAt !== undefined) add("last_run_at", patch.lastRunAt);
  if (patch.lastStatus !== undefined) add("last_status", patch.lastStatus);
  if (patch.lastError !== undefined) add("last_error", patch.lastError);
  if (patch.lastConversationId !== undefined) {
    add("last_conversation_id", patch.lastConversationId);
  }
  if (patch.lastWorkflowRunId !== undefined) {
    add("last_workflow_run_id", patch.lastWorkflowRunId);
  }
  params.push(id);
  getDb().prepare(`UPDATE scheduled_tasks SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  return getScheduledTask(id);
}

function workflowAgents(): WorkflowAgentRef[] {
  return listCliMembers().map((member) => ({
    id: member.id,
    name: member.name,
    adapter: member.cli.adapter,
    enabled: member.enabled !== false
  }));
}

function createRuntime(webContents: WebContents): WorkflowRuntime {
  return new WorkflowRuntime({
    executor: createCliStepExecutor(webContents),
    webContents,
    resolveAgent(agentId) {
      const member = listCliMembers().find((candidate) => candidate.id === agentId);
      if (!member || member.enabled === false) return undefined;
      return {
        adapter: member.cli.adapter,
        agentName: member.name,
        binary: member.cli.binary,
        extraArgs: member.cli.extraArgs,
        env: member.cli.env
      };
    }
  });
}

export async function runScheduledTask(
  id: string,
  webContents: WebContents | undefined
): Promise<boolean> {
  const task = getScheduledTask(id);
  if (!task || runningTaskIds.has(id)) return false;
  runningTaskIds.add(id);
  const startedAt = new Date();
  const taskRunId = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO scheduled_task_runs (id, task_id, status, started_at)
       VALUES (?, ?, 'running', ?)`
    )
    .run(taskRunId, task.id, startedAt.toISOString());
  const next = task.enabled ? nextRunAt(task, startedAt) : null;
  const running = updateRunState(id, {
    enabled: task.scheduleType === "once" && !next ? false : undefined,
    lastRunAt: startedAt.toISOString(),
    lastStatus: "running",
    lastError: null,
    nextRunAt: next
  });
  if (running) notifyChanged(running);

  try {
    if (!webContents || webContents.isDestroyed()) {
      throw new Error("FreeBuddy window is not available");
    }
    const member = listCliMembers().find(
      (candidate) => candidate.id === task.agentId && candidate.enabled !== false
    );
    if (!member) throw new Error("selected agent is unavailable");

    const existingConversation =
      task.executionMode === "continuous" && task.lastConversationId
        ? getConversation(task.lastConversationId)
        : undefined;
    const conversationId =
      existingConversation?.agentId === member.id
        ? existingConversation.id
        : randomUUID();
    if (!existingConversation || existingConversation.agentId !== member.id) {
      createConversation({
        id: conversationId,
        title: `${task.title} · ${new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short"
        }).format(startedAt)}`,
        titleSource: "user",
        agentId: member.id,
        agentName: member.name,
        adapter: member.cli.adapter,
        approvalMode: "auto"
      });
    }
    appendMessage({
      id: randomUUID(),
      conversationId,
      role: "user",
      status: "done",
      content: task.prompt,
      agentId: member.id,
      agentName: member.name,
      adapter: member.cli.adapter
    });

    const plan: WorkflowPlan = {
      name: task.title,
      goal: task.prompt,
      template: "custom",
      phases: [
        {
          id: "task",
          title: "Scheduled task",
          parallelism: 1,
          steps: [
            {
              id: "execute",
              title: "Scheduled task",
              agentId: task.agentId,
              mode: "research",
              prompt: buildScheduledTaskPrompt({
                title: task.title,
                prompt: task.prompt,
                startedAt: startedAt.toISOString(),
                previousContext: previousRunContext(task)
              })
            }
          ]
        }
      ]
    };
    const runtime = createRuntime(webContents);
    const created = runtime.createPendingRun({
      conversationId,
      plan,
      agents: workflowAgents()
    });
    if (!created.ok) throw new Error(created.errors.join("; "));
    updateRunState(id, {
      lastConversationId: conversationId,
      lastWorkflowRunId: created.run.id
    });
    getDb()
      .prepare(
        `UPDATE scheduled_task_runs
         SET conversation_id = ?, workflow_run_id = ?
         WHERE id = ?`
      )
      .run(conversationId, created.run.id, taskRunId);
    await runtime.start(created.run.id);
    const run = runtime.getRun(created.run.id);
    if (!run || run.status !== "completed") {
      throw new Error(run?.summary || `task workflow ended with ${run?.status ?? "unknown status"}`);
    }
    const completed = updateRunState(id, {
      lastStatus: "completed",
      lastError: null,
      lastConversationId: conversationId,
      lastWorkflowRunId: created.run.id
    });
    getDb()
      .prepare(
        `UPDATE scheduled_task_runs
         SET status = 'completed', ended_at = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), taskRunId);
    if (completed) notifyChanged(completed);
    return true;
  } catch (error) {
    const failed = updateRunState(id, {
      lastStatus: "failed",
      lastError: (error as Error).message
    });
    getDb()
      .prepare(
        `UPDATE scheduled_task_runs
         SET status = 'failed', ended_at = ?, error = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), (error as Error).message, taskRunId);
    if (failed) notifyChanged(failed);
    return false;
  } finally {
    runningTaskIds.delete(id);
  }
}

function notifyChanged(task?: ScheduledTask): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("scheduledTasks://changed", task);
  }
}

async function runDueTasks(): Promise<void> {
  const webContents = schedulerWebContents?.();
  if (!webContents || webContents.isDestroyed() || webContents.isLoadingMainFrame()) return;
  if (systemTimeZone() !== lastKnownTimeZone) refreshSchedulesForSystemTimeZone();
  const now = new Date().toISOString();
  const due = listScheduledTasks().filter(
    (task) => task.enabled && task.nextRunAt && task.nextRunAt <= now
  );
  await Promise.all(due.map((task) => runScheduledTask(task.id, webContents)));
}

function refreshSchedulesForSystemTimeZone(): void {
  const now = new Date();
  const nowIso = now.toISOString();
  const zone = systemTimeZone();
  lastKnownTimeZone = zone;
  const update = getDb().prepare(
    `UPDATE scheduled_tasks
     SET enabled = ?, next_run_at = ?, updated_at = ?
     WHERE id = ?`
  );
  for (const task of listScheduledTasks()) {
    if (!task.enabled) continue;
    const missedRun = task.nextRunAt && task.nextRunAt <= nowIso;
    const next = missedRun ? task.nextRunAt! : nextRunAt(task, now);
    const enabled = task.scheduleType === "once" && !next ? 0 : 1;
    update.run(enabled, next, nowIso, task.id);
  }
}

export function initializeScheduledTaskScheduler(
  getWebContents: () => WebContents | undefined
): void {
  schedulerWebContents = getWebContents;
  getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET last_status = 'failed',
           last_error = 'FreeBuddy closed before the task completed',
           updated_at = ?
       WHERE last_status = 'running'`
    )
    .run(new Date().toISOString());
  refreshSchedulesForSystemTimeZone();
  if (schedulerTimer) return;
  void runDueTasks();
  schedulerTimer = setInterval(() => void runDueTasks(), 30_000);
}

export function registerScheduledTaskIpc(): void {
  ipcMain.handle("scheduledTasks:list", () => listScheduledTasks());
  ipcMain.handle("scheduledTasks:listRuns", (_event, taskId: string) =>
    listScheduledTaskRuns(taskId)
  );
  ipcMain.handle("scheduledTasks:listAgents", () =>
    listCliMembers()
      .filter((member) => member.enabled !== false)
      .map((member) => ({ id: member.id, name: member.name, adapter: member.cli.adapter }))
  );
  ipcMain.handle("scheduledTasks:create", (_event, input: ScheduledTaskInput) =>
    createScheduledTask(input)
  );
  ipcMain.handle(
    "scheduledTasks:update",
    (_event, args: { id: string; input: ScheduledTaskInput }) =>
      updateScheduledTask(args.id, args.input)
  );
  ipcMain.handle("scheduledTasks:delete", (_event, id: string) => deleteScheduledTask(id));
  ipcMain.handle("scheduledTasks:run", (event, id: string) => {
    if (!getScheduledTask(id) || runningTaskIds.has(id)) return false;
    void runScheduledTask(id, event.sender);
    return true;
  });
}
