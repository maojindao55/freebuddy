import { listCliMembers } from "../cli/members.js";
import { listConversations, getConversation, listMessages } from "../cli/conversations.js";
import { listProjects } from "../cli/projects.js";
import { listTasks, readTaskLog } from "../cli/tasks.js";
import { listActiveWorkflowRuns } from "../cli/workflows.js";
import { listDelegationTeams, getDelegationTeam } from "../cli/delegationTeams.js";
import type { HostStatus, RemoteMethodResultMap } from "@freebuddy/protocol/remote";
import { validateHostStatus, type HostStatusInput } from "./hostStatusPublisher.js";

const PAGE_MAX = 100;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const safeText = (value: string, max = 8_192) => value.replace(/(?:\/Users\/|[A-Za-z]:\\)[^\s"']+/g, "[local-path]").replace(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, max);
function page<T>(items: T[], cursor?: string, limit?: number) { const start = cursor ? Number.parseInt(cursor, 10) : 0; const size = Math.max(1, Math.min(PAGE_MAX, limit ?? 50)); const list = items.slice(Number.isSafeInteger(start) && start >= 0 ? start : 0, (Number.isSafeInteger(start) && start >= 0 ? start : 0) + size); const next = start + size < items.length ? String(start + size) : null; return { items: list, nextCursor: next }; }

/** Host-local state deliberately excludes Relay time. Snapshot output owns it. */
export type HostStatusSource = Omit<HostStatus, "serverTime"> & { serverTime?: unknown };

export class SnapshotService {
  constructor(
    private readonly status: () => HostStatusSource,
    private readonly baseSeq: () => number,
    private readonly now: () => number = Date.now
  ) {}
  snapshot(conversationLimit = 50): RemoteMethodResultMap["sync.snapshot"] {
    return { baseSeq: this.baseSeq(), host: this.currentHostStatus(), projects: this.projects(), agents: this.agents(), conversations: this.conversations().slice(0, Math.min(PAGE_MAX, conversationLimit)), activeRuns: [], pendingDecisions: [], activeWorkflows: [], activeDelegations: [], activeTasks: this.tasks().filter(x => x.status === "running"), activeTerminals: [] };
  }
  /**
   * `serverTime` is a host-generated protocol field, never a value copied
   * from a state callback. This keeps RPC snapshots and resume fallback
   * snapshots schema-complete even if an older caller omits, nulls, or
   * corrupts its cached time.
   */
  private currentHostStatus(): HostStatus {
    const raw = this.status();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("host status source is invalid");
    const { serverTime: _ignoredSourceTime, ...localStatus } = raw;
    return validateHostStatus(localStatus as HostStatusInput, new Date(this.now()).toISOString());
  }
  projects() { return listProjects().map(p => ({ projectId: p.id, name: safeText(p.name, 120), updatedAt: p.updatedAt })); }
  project(id: string) { return this.projects().find(project => project.projectId === id); }
  agents() { return listCliMembers().map(a => ({ agentId: a.id, name: safeText(a.name, 120), kind: "cli", available: a.enabled === true })); }
  conversations() { return listConversations({ limit: PAGE_MAX }).map(c => ({ conversationId: c.id, ...(c.projectId ? { projectId: c.projectId } : {}), title: safeText(c.title, 240), archived: c.archived, updatedAt: c.updatedAt, ...(c.lastMessageAt ? { lastMessageAt: c.lastMessageAt } : {}) })); }
  conversation(id: string) { const c = getConversation(id); return c ? { conversationId: c.id, ...(c.projectId ? { projectId: c.projectId } : {}), title: safeText(c.title, 240), archived: c.archived, updatedAt: c.updatedAt, ...(c.lastMessageAt ? { lastMessageAt: c.lastMessageAt } : {}) } : undefined; }
  messages(conversationId: string) { return listMessages(conversationId).map(m => ({ messageId: m.id, conversationId: m.conversationId, role: m.role, content: safeText(m.content), ...(m.content.length > 8192 ? { truncated: true } : {}), createdAt: m.createdAt })); }
  tasks() { return listTasks({ limit: PAGE_MAX }).map(t => ({ taskId: t.id, title: safeText(t.promptSummary || t.prompt, 240), status: normalizeTaskStatus(t.status), updatedAt: t.updatedAt })); }
  task(id: string) { return this.tasks().find(task => task.taskId === id); }
  async taskLog(taskId: string) { const log = await readTaskLog(taskId, { limit: PAGE_MAX, maxBytes: 32_768 }); return log.entries.map((entry, index) => ({ seq: index, text: safeText(entry.content, 4096), createdAt: entry.ts || new Date(0).toISOString() })); }
  workflows() { return listActiveWorkflowRuns().map((w: any) => ({ workflowId: w.id, name: safeText(w.name || w.workflowId || w.id, 120), status: normalizeFlowStatus(w.status), updatedAt: w.updatedAt || w.startedAt || new Date(0).toISOString() })); }
  delegations() { return listDelegationTeams().map(t => ({ delegationId: t.id, name: safeText(t.name, 120), status: t.enabled ? "idle" as const : "stopped" as const, updatedAt: new Date(0).toISOString() })); }
  delegation(id: string) { const t = getDelegationTeam(id); return t ? { delegationId: t.id, name: safeText(t.name, 120), status: t.enabled ? "idle" as const : "stopped" as const, updatedAt: new Date(0).toISOString() } : undefined; }
  paged<T>(items: T[], cursor?: string, limit?: number) { return page(items, cursor, limit); }
  validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
}
function normalizeTaskStatus(value: string): "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled" { return (["pending", "running", "blocked", "completed", "failed", "cancelled"] as const).includes(value as any) ? value as any : "failed"; }
function normalizeFlowStatus(value: unknown): "idle" | "running" | "paused" | "blocked" | "completed" | "failed" | "stopped" { return (["idle", "running", "paused", "blocked", "completed", "failed", "stopped"] as const).includes(value as any) ? value as any : "failed"; }
