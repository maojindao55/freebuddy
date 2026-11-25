import { BrowserWindow, type WebContents } from "electron";
import { registerHandler } from "../invokeRegistry.js";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";

import { getDb } from "./db.js";
import { safeSendToWebContents } from "./ipcSend.js";
import {
  appendMessage,
  bindScheduledTasksChangedNotifier,
  createConversation,
  getConversation,
  requireOwnedConversation,
  type ChatAttachment
} from "./conversations.js";
import {
  cleanupManagedAttachmentsIfUnreferenced,
  isManagedAttachmentPath
} from "./attachments.js";
import { listCliMembers } from "./members.js";
import { getCallerUserId, isCallerAdmin, runAsCaller } from "./callerContext.js";
import { extractVisibleStepOutput } from "./workflowScheduler.js";
import type { WorkflowAgentRef, WorkflowPlan } from "./workflowTypes.js";
import type { WorkflowRuntime } from "./workflowRuntime.js";
import type { SkillSnapshot } from "./skillTypes.js";
import { isolateRemoteCwdForCaller } from "./remoteWorkspaceAccess.js";
import {
  buildScheduledTaskPrompt,
  isValidLocalDate,
  isValidLocalTime,
  localDateAndTimeFromMs,
  nextScheduledOccurrence,
  systemTimeZone,
  type ScheduledTaskScheduleType
} from "./scheduledTaskUtils.js";

export type ScheduledTaskStatus =
  | "idle"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "missed";
export type ScheduledTaskExecutionMode = "new_conversation" | "continuous";
export type ScheduledTaskTargetKind = "new_conversation" | "conversation_message";
export type ScheduledTaskTriggerKind = "schedule" | "delay" | "quota_reset";

export interface ScheduledTaskConversationReference {
  id: string;
  title: string;
  agentName: string;
}

export interface ScheduledTaskPayload {
  messageSkills?: SkillSnapshot[];
  conversationReferences?: ScheduledTaskConversationReference[];
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
  ownerId?: string | null;
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
  cwd: string | null;
  config_option_overrides: string | null;
  execution_mode: string;
  target_kind: string | null;
  target_conversation_id: string | null;
  trigger_kind: string | null;
  fire_at_ms: number | null;
  cleanup_after_run: number | null;
  attachments: string | null;
  payload_json: string | null;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: ScheduledTaskStatus | null;
  last_error: string | null;
  last_conversation_id: string | null;
  last_workflow_run_id: string | null;
  owner_id: string | null;
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
const TARGET_KINDS = new Set<ScheduledTaskTargetKind>([
  "new_conversation",
  "conversation_message"
]);
const TRIGGER_KINDS = new Set<ScheduledTaskTriggerKind>([
  "schedule",
  "delay",
  "quota_reset"
]);
const DISPATCH_LEASE_MS = 45_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const runningTaskIds = new Set<string>();
const dispatchClaims = new Map<string, { token: string; expires: number }>();
let schedulerTimer: ReturnType<typeof setInterval> | undefined;
let precisionTimer: ReturnType<typeof setTimeout> | undefined;
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

function normalizeConfigOptionOverrides(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] =>
      Boolean(entry[0].trim()) && typeof entry[1] === "string" && Boolean(entry[1].trim())
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseConfigOptionOverrides(value: string | null): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    return normalizeConfigOptionOverrides(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function serializedConfigOptionOverrides(value: unknown): string | null {
  const normalized = normalizeConfigOptionOverrides(value);
  return normalized ? JSON.stringify(normalized) : null;
}

function sameConfigOptionOverrides(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined
): boolean {
  const entries = (value: Record<string, string> | undefined) =>
    Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

function parseAttachments(value: string | null): ChatAttachment[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const items = parsed.filter(
      (entry): entry is ChatAttachment =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof (entry as ChatAttachment).id === "string" &&
        typeof (entry as ChatAttachment).path === "string"
    );
    return items.length > 0 ? items : undefined;
  } catch {
    return undefined;
  }
}

function serializedAttachments(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items = value.filter(
    (entry): entry is ChatAttachment =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as ChatAttachment).id === "string" &&
      typeof (entry as ChatAttachment).path === "string"
  );
  return items.length > 0 ? JSON.stringify(items) : null;
}

function extractManagedAttachmentPaths(attachments: ChatAttachment[] | undefined): string[] {
  if (!attachments?.length) return [];
  const paths: string[] = [];
  for (const attachment of attachments) {
    if (
      typeof attachment.path === "string" &&
      (attachment.managed || isManagedAttachmentPath(attachment.path))
    ) {
      paths.push(attachment.path);
    }
  }
  return paths;
}

function parsePayload(value: string | null): ScheduledTaskPayload | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const raw = parsed as ScheduledTaskPayload;
    const payload: ScheduledTaskPayload = {};
    if (Array.isArray(raw.messageSkills) && raw.messageSkills.length > 0) {
      payload.messageSkills = raw.messageSkills;
    }
    if (Array.isArray(raw.conversationReferences) && raw.conversationReferences.length > 0) {
      payload.conversationReferences = raw.conversationReferences;
    }
    if (raw.approvalMode === "auto" || raw.approvalMode === "ask") {
      payload.approvalMode = raw.approvalMode;
    }
    return Object.keys(payload).length > 0 ? payload : undefined;
  } catch {
    return undefined;
  }
}

function serializedPayload(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as ScheduledTaskPayload;
  const payload: ScheduledTaskPayload = {};
  if (Array.isArray(raw.messageSkills) && raw.messageSkills.length > 0) {
    payload.messageSkills = raw.messageSkills;
  }
  if (Array.isArray(raw.conversationReferences) && raw.conversationReferences.length > 0) {
    payload.conversationReferences = raw.conversationReferences;
  }
  if (raw.approvalMode === "auto" || raw.approvalMode === "ask") {
    payload.approvalMode = raw.approvalMode;
  }
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : null;
}

function normalizeFireAtMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function rowToTask(row: ScheduledTaskRow): ScheduledTask {
  const scheduleType = SCHEDULE_TYPES.has(row.schedule_type as ScheduledTaskScheduleType)
    ? (row.schedule_type as ScheduledTaskScheduleType)
    : "daily";
  const targetKind = TARGET_KINDS.has(row.target_kind as ScheduledTaskTargetKind)
    ? (row.target_kind as ScheduledTaskTargetKind)
    : "new_conversation";
  const triggerKind = TRIGGER_KINDS.has(row.trigger_kind as ScheduledTaskTriggerKind)
    ? (row.trigger_kind as ScheduledTaskTriggerKind)
    : "schedule";
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
    cwd: row.cwd ?? undefined,
    configOptionOverrides: parseConfigOptionOverrides(row.config_option_overrides),
    executionMode: EXECUTION_MODES.has(row.execution_mode as ScheduledTaskExecutionMode)
      ? (row.execution_mode as ScheduledTaskExecutionMode)
      : "new_conversation",
    targetKind,
    targetConversationId: row.target_conversation_id ?? undefined,
    triggerKind,
    fireAtMs: row.fire_at_ms ?? undefined,
    cleanupAfterRun: Boolean(row.cleanup_after_run),
    attachments: parseAttachments(row.attachments),
    payload: parsePayload(row.payload_json),
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastStatus: row.last_status ?? undefined,
    lastError: row.last_error ?? undefined,
    lastConversationId: row.last_conversation_id ?? undefined,
    lastWorkflowRunId: row.last_workflow_run_id ?? undefined,
    ownerId: row.owner_id ?? null,
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
  const caller = getCallerUserId();
  if (caller === null || isCallerAdmin()) {
    return (getDb()
      .prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC")
      .all() as ScheduledTaskRow[]).map(rowToTask);
  }
  return (getDb()
    .prepare(
      "SELECT * FROM scheduled_tasks WHERE owner_id = ? ORDER BY created_at DESC"
    )
    .all(caller) as ScheduledTaskRow[]).map(rowToTask);
}

export function requireOwnedScheduledTask(id: string): ScheduledTask | undefined {
  const task = getScheduledTask(id);
  if (!task) return undefined;
  if (isCallerAdmin() || getCallerUserId() === null) return task;
  return task.ownerId === getCallerUserId() ? task : undefined;
}

export function backfillScheduledTaskOwners(ownerId: string): number {
  const info = getDb()
    .prepare("UPDATE scheduled_tasks SET owner_id = ? WHERE owner_id IS NULL")
    .run(ownerId);
  return info.changes;
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

function normalizeInputSchedule(input: ScheduledTaskInput): ScheduledTaskInput {
  const fireAtMs = normalizeFireAtMs(input.fireAtMs);
  if (fireAtMs === undefined) return input;
  const derived = localDateAndTimeFromMs(fireAtMs, systemTimeZone());
  if (!derived) return input;
  return {
    ...input,
    scheduleType: input.scheduleType || "once",
    scheduleDate: input.scheduleDate || derived.scheduleDate,
    timeLocal: isValidLocalTime(input.timeLocal) ? input.timeLocal : derived.timeLocal,
    fireAtMs
  };
}

function validateInput(rawInput: ScheduledTaskInput): string[] {
  const input = normalizeInputSchedule(rawInput);
  const errors: string[] = [];
  const targetKind: ScheduledTaskTargetKind = input.targetKind ?? "new_conversation";
  const triggerKind: ScheduledTaskTriggerKind = input.triggerKind ?? "schedule";
  const hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0;

  if (!TARGET_KINDS.has(targetKind)) {
    errors.push("scheduledTasks.errors.invalidExecutionMode");
  }
  if (!TRIGGER_KINDS.has(triggerKind)) {
    errors.push("scheduledTasks.errors.invalidScheduleType");
  }
  if (!input.title?.trim()) errors.push("scheduledTasks.errors.titleRequired");
  if (!input.prompt?.trim() && !hasAttachments) {
    errors.push("scheduledTasks.errors.instructionsRequired");
  }
  if (!SCHEDULE_TYPES.has(input.scheduleType)) {
    errors.push("scheduledTasks.errors.invalidScheduleType");
  }
  if (!EXECUTION_MODES.has(input.executionMode)) {
    errors.push("scheduledTasks.errors.invalidExecutionMode");
  }
  if (input.cwd?.trim() && !path.isAbsolute(input.cwd.trim())) {
    errors.push("scheduledTasks.errors.absoluteWorkingDirectory");
  }

  const fireAtMs = normalizeFireAtMs(input.fireAtMs);
  if (fireAtMs !== undefined) {
    if (input.enabled && input.scheduleType === "once" && fireAtMs <= Date.now()) {
      errors.push("scheduledTasks.errors.oneTimeMustBeFuture");
    }
  } else {
    if (
      input.scheduleType !== "manual" &&
      input.scheduleType !== "hourly" &&
      !isValidLocalTime(input.timeLocal)
    ) {
      errors.push("scheduledTasks.errors.invalidRunTime");
    }
    if (
      input.scheduleType === "once" &&
      (!input.scheduleDate || !isValidLocalDate(input.scheduleDate))
    ) {
      errors.push("scheduledTasks.errors.validRunDateRequired");
    }
    if (
      input.enabled &&
      input.scheduleType === "once" &&
      isValidLocalTime(input.timeLocal) &&
      Boolean(input.scheduleDate && isValidLocalDate(input.scheduleDate)) &&
      !nextScheduledOccurrence(scheduleOf(input), systemTimeZone())
    ) {
      errors.push("scheduledTasks.errors.oneTimeMustBeFuture");
    }
  }

  if (
    input.scheduleType === "weekly" &&
    !(input.weekdays ?? []).some((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  ) {
    errors.push("scheduledTasks.errors.weekdayRequired");
  }
  if (
    input.scheduleType === "monthly" &&
    (!Number.isInteger(input.monthDay) || input.monthDay! < 1 || input.monthDay! > 31)
  ) {
    errors.push("scheduledTasks.errors.invalidMonthDay");
  }

  if (targetKind === "conversation_message") {
    const convId = input.targetConversationId?.trim();
    const conv = convId ? requireOwnedConversation(convId) : undefined;
    if (!conv || conv.archived) {
      errors.push("scheduledTasks.errors.conversationUnavailable");
    }
  } else {
    const member = listCliMembers().find(
      (candidate) => candidate.id === input.agentId && candidate.enabled !== false
    );
    if (!member) errors.push("scheduledTasks.errors.agentUnavailable");
  }
  return errors;
}

function nextRunAt(input: ScheduledTaskInput | ScheduledTask, after = new Date()): string | null {
  if (!input.enabled) return null;
  const fireAtMs = normalizeFireAtMs(input.fireAtMs);
  if (input.scheduleType === "once" && fireAtMs !== undefined) {
    return fireAtMs > after.getTime() ? new Date(fireAtMs).toISOString() : null;
  }
  return nextScheduledOccurrence(scheduleOf(input), systemTimeZone(), after)?.toISOString() ?? null;
}

export function createScheduledTask(
  rawInput: ScheduledTaskInput
): { ok: true; task: ScheduledTask } | { ok: false; errors: string[] } {
  const input = normalizeInputSchedule(rawInput);
  const errors = validateInput(input);
  if (errors.length) return { ok: false, errors };
  const id = randomUUID();
  const now = new Date().toISOString();
  const targetKind: ScheduledTaskTargetKind = input.targetKind ?? "new_conversation";
  const triggerKind: ScheduledTaskTriggerKind = input.triggerKind ?? "schedule";
  const fireAtMs =
    input.scheduleType === "once" ? normalizeFireAtMs(input.fireAtMs) ?? null : null;
  const cleanupAfterRun =
    input.cleanupAfterRun !== undefined
      ? input.cleanupAfterRun
      : targetKind === "conversation_message" && input.scheduleType === "once";
  const targetConversationId =
    targetKind === "conversation_message"
      ? input.targetConversationId?.trim() || null
      : null;
  const targetConv = targetConversationId
    ? requireOwnedConversation(targetConversationId)
    : undefined;
  const resolvedAgentId = input.agentId?.trim() || targetConv?.agentId || "";
  const resolvedCwd = input.cwd?.trim() || targetConv?.cwd || null;
  const replacedManagedPaths: string[] = [];

  getDb().transaction(() => {
    if (
      targetKind === "conversation_message" &&
      targetConversationId &&
      input.scheduleType === "once" &&
      cleanupAfterRun
    ) {
      const existingRows = getDb()
        .prepare(
          `SELECT id, attachments FROM scheduled_tasks
           WHERE target_kind = 'conversation_message'
             AND target_conversation_id = ?
             AND schedule_type = 'once'
             AND cleanup_after_run = 1`
        )
        .all(targetConversationId) as Array<{ id: string; attachments: string | null }>;
      for (const existing of existingRows) {
        dispatchClaims.delete(existing.id);
        replacedManagedPaths.push(
          ...extractManagedAttachmentPaths(parseAttachments(existing.attachments))
        );
      }
      if (existingRows.length > 0) {
        getDb()
          .prepare(
            `DELETE FROM scheduled_tasks
             WHERE target_kind = 'conversation_message'
               AND target_conversation_id = ?
               AND schedule_type = 'once'
               AND cleanup_after_run = 1`
          )
          .run(targetConversationId);
      }
    }

    getDb()
      .prepare(
        `INSERT INTO scheduled_tasks
          (id, title, prompt, agent_id, time_local, schedule_type,
            schedule_date, weekdays, month_day, cwd, execution_mode,
            config_option_overrides, target_kind, target_conversation_id,
            trigger_kind, fire_at_ms, cleanup_after_run, attachments, payload_json,
            enabled, next_run_at, last_status, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)`
      )
      .run(
        id,
        input.title.trim(),
        input.prompt.trim(),
        resolvedAgentId,
        input.timeLocal,
        input.scheduleType,
        input.scheduleType === "once" ? input.scheduleDate ?? null : null,
        input.scheduleType === "weekly" ? JSON.stringify(input.weekdays ?? []) : null,
        input.scheduleType === "monthly" ? input.monthDay ?? null : null,
        resolvedCwd,
        input.executionMode,
        serializedConfigOptionOverrides(input.configOptionOverrides),
        targetKind,
        targetConversationId,
        triggerKind,
        fireAtMs,
        cleanupAfterRun ? 1 : 0,
        serializedAttachments(input.attachments),
        serializedPayload(input.payload),
        input.enabled ? 1 : 0,
        nextRunAt(input),
        getCallerUserId(),
        now,
        now
      );
  })();

  if (replacedManagedPaths.length > 0) {
    cleanupManagedAttachmentsIfUnreferenced(replacedManagedPaths);
  }
  const task = getScheduledTask(id)!;
  reschedulePrecisionTimer();
  notifyChanged(task);
  return { ok: true, task };
}

export function updateScheduledTask(
  id: string,
  rawInput: ScheduledTaskInput
): { ok: true; task: ScheduledTask } | { ok: false; errors: string[] } {
  const existing = getScheduledTask(id);
  if (!existing) {
    return { ok: false, errors: ["scheduledTasks.errors.taskNotFound"] };
  }
  const mergedInput = normalizeInputSchedule({
    ...rawInput,
    targetKind: rawInput.targetKind ?? existing.targetKind,
    targetConversationId:
      rawInput.targetConversationId !== undefined
        ? rawInput.targetConversationId
        : existing.targetConversationId,
    triggerKind: rawInput.triggerKind ?? existing.triggerKind,
    cleanupAfterRun:
      rawInput.cleanupAfterRun !== undefined
        ? rawInput.cleanupAfterRun
        : existing.cleanupAfterRun,
    attachments:
      rawInput.attachments !== undefined ? rawInput.attachments : existing.attachments,
    payload: rawInput.payload !== undefined ? rawInput.payload : existing.payload
  });
  const errors = validateInput(mergedInput);
  if (errors.length) return { ok: false, errors };
  const oldManagedPaths = extractManagedAttachmentPaths(existing.attachments);
  const now = new Date().toISOString();
  const targetKind: ScheduledTaskTargetKind = mergedInput.targetKind ?? "new_conversation";
  const triggerKind: ScheduledTaskTriggerKind = mergedInput.triggerKind ?? "schedule";
  const fireAtMs =
    mergedInput.scheduleType === "once"
      ? normalizeFireAtMs(mergedInput.fireAtMs) ?? null
      : null;
  const targetConversationId =
    targetKind === "conversation_message"
      ? mergedInput.targetConversationId?.trim() || null
      : null;
  getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET title = ?, prompt = ?, agent_id = ?, time_local = ?,
           schedule_type = ?, schedule_date = ?, weekdays = ?,
           month_day = ?, cwd = ?, execution_mode = ?, config_option_overrides = ?,
           target_kind = ?, target_conversation_id = ?, trigger_kind = ?,
           fire_at_ms = ?, cleanup_after_run = ?, attachments = ?, payload_json = ?,
           enabled = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      mergedInput.title.trim(),
      mergedInput.prompt.trim(),
      mergedInput.agentId,
      mergedInput.timeLocal,
      mergedInput.scheduleType,
      mergedInput.scheduleType === "once" ? mergedInput.scheduleDate ?? null : null,
      mergedInput.scheduleType === "weekly" ? JSON.stringify(mergedInput.weekdays ?? []) : null,
      mergedInput.scheduleType === "monthly" ? mergedInput.monthDay ?? null : null,
      mergedInput.cwd?.trim() || null,
      mergedInput.executionMode,
      serializedConfigOptionOverrides(mergedInput.configOptionOverrides),
      targetKind,
      targetConversationId,
      triggerKind,
      fireAtMs,
      mergedInput.cleanupAfterRun ? 1 : 0,
      serializedAttachments(mergedInput.attachments),
      serializedPayload(mergedInput.payload),
      mergedInput.enabled ? 1 : 0,
      nextRunAt(mergedInput),
      now,
      id
    );
  if (oldManagedPaths.length > 0) {
    cleanupManagedAttachmentsIfUnreferenced(oldManagedPaths);
  }
  const task = getScheduledTask(id)!;
  reschedulePrecisionTimer();
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

export function deleteScheduledTask(
  id: string,
  options?: { preserveAttachments?: boolean }
): boolean {
  pruneExpiredDispatchClaims();
  if (runningTaskIds.has(id) || dispatchClaims.has(id)) return false;
  const existing = getScheduledTask(id);
  const oldManagedPaths = extractManagedAttachmentPaths(existing?.attachments);
  dispatchClaims.delete(id);
  const changed =
    getDb().prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id).changes > 0;
  if (changed) {
    if (!options?.preserveAttachments && oldManagedPaths.length > 0) {
      cleanupManagedAttachmentsIfUnreferenced(oldManagedPaths);
    }
    reschedulePrecisionTimer();
    notifyChanged();
  }
  return changed;
}

function updateRunState(
  id: string,
  patch: {
    enabled?: boolean;
    fireAtMs?: number | null;
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
  if (patch.fireAtMs !== undefined) add("fire_at_ms", patch.fireAtMs);
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

function pruneExpiredDispatchClaims(now = Date.now()): void {
  for (const [id, claim] of dispatchClaims.entries()) {
    if (claim.expires > now) continue;
    dispatchClaims.delete(id);
    const task = getScheduledTask(id);
    if (task && task.targetKind === "conversation_message" && task.lastStatus === "running") {
      const recovered = updateRunState(id, {
        lastStatus: "waiting",
        lastError: null
      });
      if (recovered) notifyChanged(recovered);
    }
  }
}

export function resetScheduledTaskDispatchClaimsForTest(): void {
  dispatchClaims.clear();
}

export function claimScheduledTaskDispatch(
  id: string,
  options?: { force?: boolean }
): ScheduledTaskDispatchClaimResult {
  const now = Date.now();
  pruneExpiredDispatchClaims(now);
  const task = requireOwnedScheduledTask(id);
  if (!task) return { ok: false, reason: "not_found" };
  if (task.targetKind !== "conversation_message") {
    return { ok: false, reason: "not_conversation_message" };
  }
  if (runningTaskIds.has(id) || dispatchClaims.has(id)) {
    return { ok: false, reason: "busy" };
  }
  if (!options?.force) {
    if (!task.enabled) return { ok: false, reason: "disabled" };
    const dueAt =
      task.fireAtMs ?? (task.nextRunAt ? Date.parse(task.nextRunAt) : Number.NaN);
    if (!Number.isFinite(dueAt) || dueAt > now) {
      return { ok: false, reason: "not_due" };
    }
  }
  const claimToken = randomUUID();
  dispatchClaims.set(id, { token: claimToken, expires: now + DISPATCH_LEASE_MS });
  const running = updateRunState(id, {
    lastStatus: "running",
    lastError: null
  })!;
  notifyChanged(running);
  return { ok: true, task: running, claimToken };
}

export function completeScheduledTaskDispatch(args: {
  id: string;
  claimToken: string;
  outcome: ScheduledTaskDispatchOutcome;
  error?: string;
  preserveAttachments?: boolean;
}): boolean {
  const owned = requireOwnedScheduledTask(args.id);
  if (!owned) return false;
  const claim = dispatchClaims.get(args.id);
  if (!claim || claim.token !== args.claimToken) return false;
  dispatchClaims.delete(args.id);

  if (args.outcome === "conversation_missing") {
    const managedPaths = extractManagedAttachmentPaths(owned.attachments);
    getDb().prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(args.id);
    if (managedPaths.length > 0) {
      cleanupManagedAttachmentsIfUnreferenced(managedPaths);
    }
    reschedulePrecisionTimer();
    notifyChanged();
    return true;
  }

  if (args.outcome === "waiting") {
    const waiting = updateRunState(args.id, {
      lastStatus: "waiting",
      lastError: null
    });
    if (waiting) notifyChanged(waiting);
    return true;
  }

  if (args.outcome === "failed") {
    const failed = updateRunState(args.id, {
      lastStatus: "failed",
      lastError: args.error || "Failed to send scheduled message"
    });
    if (failed) notifyChanged(failed);
    return true;
  }

  // outcome === "sent"
  const now = new Date();
  if (owned.cleanupAfterRun && owned.scheduleType === "once") {
    const managedPaths = extractManagedAttachmentPaths(owned.attachments);
    getDb().prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(args.id);
    if (!args.preserveAttachments && managedPaths.length > 0) {
      cleanupManagedAttachmentsIfUnreferenced(managedPaths);
    }
    reschedulePrecisionTimer();
    notifyChanged();
    return true;
  }

  const taskRunId = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO scheduled_task_runs (id, task_id, status, started_at, ended_at, conversation_id)
       VALUES (?, ?, 'completed', ?, ?, ?)`
    )
    .run(
      taskRunId,
      owned.id,
      now.toISOString(),
      now.toISOString(),
      owned.targetConversationId ?? null
    );
  const next = owned.enabled ? nextRunAt(owned, now) : null;
  const completed = updateRunState(args.id, {
    enabled: owned.scheduleType === "once" && !next ? false : undefined,
    lastRunAt: now.toISOString(),
    lastStatus: "completed",
    lastError: null,
    lastConversationId: owned.targetConversationId,
    nextRunAt: next
  });
  reschedulePrecisionTimer();
  if (completed) notifyChanged(completed);
  return true;
}

export function markScheduledTaskWaiting(id: string): boolean {
  const now = Date.now();
  pruneExpiredDispatchClaims(now);
  const task = requireOwnedScheduledTask(id);
  if (!task || task.targetKind !== "conversation_message") return false;
  if (dispatchClaims.has(id) || task.lastStatus === "running" || task.lastStatus === "waiting") {
    return false;
  }
  const waiting = updateRunState(id, {
    lastStatus: "waiting",
    lastError: null
  });
  if (waiting) notifyChanged(waiting);
  return Boolean(waiting);
}

function workflowAgents(): WorkflowAgentRef[] {
  return listCliMembers().map((member) => ({
    id: member.id,
    name: member.name,
    adapter: member.cli.adapter,
    enabled: member.enabled !== false
  }));
}

async function createRuntime(webContents: WebContents): Promise<WorkflowRuntime> {
  // Dynamic import breaks the static cycle:
  // workflowRuntime -> runtime -> acpRuntime -> butlerToolService -> scheduledTasks
  const { createCliStepExecutor, WorkflowRuntime, createElectronWorkflowPorts } = await import(
    "./workflowRuntime.js"
  );
  return new WorkflowRuntime(
    createElectronWorkflowPorts({
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
    })
  );
}

export async function runScheduledTask(
  id: string,
  webContents: WebContents | undefined
): Promise<boolean> {
  const task = getScheduledTask(id);
  if (!task || runningTaskIds.has(id)) return false;
  if (task.targetKind === "conversation_message") {
    pruneExpiredDispatchClaims();
    if (dispatchClaims.has(id)) return false;
    const targetConv = task.targetConversationId
      ? getConversation(task.targetConversationId)
      : undefined;
    if (!targetConv || targetConv.archived) {
      const paused = updateRunState(id, {
        enabled: false,
        lastStatus: "missed",
        lastError: "scheduledTasks.errors.conversationUnavailable"
      });
      reschedulePrecisionTimer();
      if (paused) notifyChanged(paused);
      return false;
    }
    const now = Date.now();
    const updated = updateRunState(id, {
      enabled: true,
      fireAtMs: now,
      nextRunAt: new Date(now).toISOString(),
      lastStatus: "idle",
      lastError: null
    });
    reschedulePrecisionTimer();
    if (updated) notifyChanged(updated);
    return Boolean(updated);
  }
  // The scheduler has no caller context of its own, so conversations and
  // messages created by the run would otherwise end up without an owner.
  return task.ownerId
    ? runAsCaller(task.ownerId, () => executeScheduledTask(task, webContents))
    : executeScheduledTask(task, webContents);
}

async function executeScheduledTask(
  task: ScheduledTask,
  webContents: WebContents | undefined
): Promise<boolean> {
  const id = task.id;
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
    if (task.cwd) {
      try {
        if (!statSync(task.cwd).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new Error(`working directory is unavailable: ${task.cwd}`);
      }
    }

    const existingConversation =
      task.executionMode === "continuous" && task.lastConversationId
        ? getConversation(task.lastConversationId)
        : undefined;
    const canContinueConversation = Boolean(
      existingConversation &&
        existingConversation.agentId === member.id &&
        existingConversation.cwd === task.cwd &&
        sameConfigOptionOverrides(
          existingConversation.configOptionOverrides,
          task.configOptionOverrides
        )
    );
    const conversationId = canContinueConversation
      ? existingConversation!.id
      : randomUUID();
    if (!canContinueConversation) {
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
        cwd: task.cwd,
        approvalMode: "auto",
        configOptionOverrides: task.configOptionOverrides
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
      cwd: task.cwd,
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
              configOptionOverrides: task.configOptionOverrides,
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
    const runtime = await createRuntime(webContents);
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
    reschedulePrecisionTimer();
  }
}

function notifyChanged(task?: ScheduledTask): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    safeSendToWebContents(win.webContents, "scheduledTasks://changed", task);
  }
}

function reschedulePrecisionTimer(): void {
  if (precisionTimer) {
    clearTimeout(precisionTimer);
    precisionTimer = undefined;
  }
  if (!schedulerTimer) return;
  try {
    const nowIso = new Date().toISOString();
    const row = getDb()
      .prepare(
        `SELECT MIN(next_run_at) AS next_at
         FROM scheduled_tasks
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at > ?
           AND COALESCE(last_status, 'idle') NOT IN ('running', 'missed', 'failed')`
      )
      .get(nowIso) as { next_at: string | null } | undefined;
    if (!row?.next_at) return;
    const targetMs = Date.parse(row.next_at);
    if (!Number.isFinite(targetMs)) return;
    const delay = Math.max(50, Math.min(targetMs - Date.now() + 25, MAX_TIMEOUT_MS));
    precisionTimer = setTimeout(() => {
      precisionTimer = undefined;
      void runDueTasks();
    }, delay);
    precisionTimer.unref?.();
  } catch {
    // Ignore DB errors when shutting down or uninitialized.
  }
}

async function runDueTasks(): Promise<void> {
  pruneExpiredDispatchClaims();
  const webContents = schedulerWebContents?.();
  if (!webContents || webContents.isDestroyed() || webContents.isLoadingMainFrame()) {
    reschedulePrecisionTimer();
    return;
  }
  if (systemTimeZone() !== lastKnownTimeZone) refreshSchedulesForSystemTimeZone();
  const now = new Date().toISOString();
  const due = listScheduledTasks().filter(
    (task) => task.enabled && task.nextRunAt && task.nextRunAt <= now
  );
  const standardDue = due.filter((task) => task.targetKind !== "conversation_message");
  const messageDue = due.filter(
    (task) =>
      task.targetKind === "conversation_message" &&
      !dispatchClaims.has(task.id) &&
      (task.lastStatus ?? "idle") === "idle"
  );
  for (const task of messageDue) {
    notifyChanged(task);
  }
  await Promise.all(standardDue.map((task) => runScheduledTask(task.id, webContents)));
  reschedulePrecisionTimer();
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
    if (task.scheduleType === "once" && task.fireAtMs !== undefined) {
      const next = new Date(task.fireAtMs).toISOString();
      if (task.nextRunAt !== next) {
        update.run(1, next, nowIso, task.id);
      }
      continue;
    }
    const missedRun = task.nextRunAt && task.nextRunAt <= nowIso;
    const next = missedRun ? task.nextRunAt! : nextRunAt(task, now);
    const enabled = task.scheduleType === "once" && !next ? 0 : 1;
    update.run(enabled, next, nowIso, task.id);
  }
}

export function recoverScheduledTasksOnStartup(nowMs = Date.now()): void {
  const nowIso = new Date(nowMs).toISOString();
  dispatchClaims.clear();
  getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET last_status = 'failed',
           last_error = 'FreeBuddy closed before the task completed',
           updated_at = ?
       WHERE last_status = 'running'`
    )
    .run(nowIso);

  // Drop orphaned conversation_message tasks whose target conversation was removed.
  const orphanRows = getDb()
    .prepare(
      `SELECT id, attachments FROM scheduled_tasks
       WHERE target_kind = 'conversation_message'
         AND (
           target_conversation_id IS NULL
           OR target_conversation_id NOT IN (SELECT id FROM conversations)
         )`
    )
    .all() as Array<{ id: string; attachments: string | null }>;
  if (orphanRows.length > 0) {
    const orphanManagedPaths: string[] = [];
    for (const row of orphanRows) {
      orphanManagedPaths.push(
        ...extractManagedAttachmentPaths(parseAttachments(row.attachments))
      );
    }
    getDb()
      .prepare(
        `DELETE FROM scheduled_tasks
         WHERE target_kind = 'conversation_message'
           AND (
             target_conversation_id IS NULL
             OR target_conversation_id NOT IN (SELECT id FROM conversations)
           )`
      )
      .run();
    if (orphanManagedPaths.length > 0) {
      cleanupManagedAttachmentsIfUnreferenced(orphanManagedPaths);
    }
  }

  // Mark overdue one-time conversation messages as missed on restart instead of
  // firing stale messages blindly when the app reopens.
  getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET last_status = 'missed',
           enabled = 0,
           last_error = NULL,
           updated_at = ?
       WHERE target_kind = 'conversation_message'
         AND schedule_type = 'once'
         AND enabled = 1
         AND COALESCE(last_status, 'idle') IN ('idle', 'waiting')
         AND (
           (fire_at_ms IS NOT NULL AND fire_at_ms <= ?)
           OR (fire_at_ms IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ?)
         )`
    )
    .run(nowIso, nowMs, nowIso);

  refreshSchedulesForSystemTimeZone();
}

export function initializeScheduledTaskScheduler(
  getWebContents: () => WebContents | undefined
): void {
  schedulerWebContents = getWebContents;
  bindScheduledTasksChangedNotifier(() => {
    reschedulePrecisionTimer();
    notifyChanged();
  });
  recoverScheduledTasksOnStartup();
  if (schedulerTimer) {
    reschedulePrecisionTimer();
    return;
  }
  schedulerTimer = setInterval(() => void runDueTasks(), 30_000);
  void runDueTasks();
}

export function registerScheduledTaskIpc(): void {
  registerHandler("scheduledTasks:list", () => listScheduledTasks());
  registerHandler("scheduledTasks:listRuns", (_event, taskId: string) =>
    requireOwnedScheduledTask(taskId) ? listScheduledTaskRuns(taskId) : []
  );
  registerHandler("scheduledTasks:listAgents", () =>
    listCliMembers()
      .filter((member) => member.enabled !== false)
      .map((member) => ({ id: member.id, name: member.name, adapter: member.cli.adapter }))
  );
  registerHandler(
    "scheduledTasks:create",
    async (_event, input: ScheduledTaskInput) =>
      createScheduledTask({
        ...input,
        cwd: await isolateRemoteCwdForCaller(input.cwd)
      })
  );
  registerHandler(
    "scheduledTasks:update",
    async (_event, args: { id: string; input: ScheduledTaskInput }) =>
      requireOwnedScheduledTask(args.id)
        ? updateScheduledTask(args.id, {
            ...args.input,
            cwd: await isolateRemoteCwdForCaller(args.input.cwd)
          })
        : { ok: false as const, errors: ["scheduledTasks.errors.taskNotFound"] }
  );
  registerHandler(
    "scheduledTasks:delete",
    (_event, id: string, options?: { preserveAttachments?: boolean }) =>
      requireOwnedScheduledTask(id) ? deleteScheduledTask(id, options) : false
  );
  registerHandler("scheduledTasks:run", (event, id: string) => {
    const owned = requireOwnedScheduledTask(id);
    if (!owned || runningTaskIds.has(id)) return false;
    if (owned.targetKind === "conversation_message") {
      return runScheduledTask(id, event.sender);
    }
    void runScheduledTask(id, event.sender);
    return true;
  });
  registerHandler(
    "scheduledTasks:claimDispatch",
    (_event, id: string, options?: { force?: boolean }) =>
      claimScheduledTaskDispatch(id, options)
  );
  registerHandler(
    "scheduledTasks:completeDispatch",
    (
      _event,
      args: {
        id: string;
        claimToken: string;
        outcome: ScheduledTaskDispatchOutcome;
        error?: string;
        preserveAttachments?: boolean;
      }
    ) => completeScheduledTaskDispatch(args)
  );
  registerHandler("scheduledTasks:markWaiting", (_event, id: string) =>
    markScheduledTaskWaiting(id)
  );
}
