import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { BrowserWindow, type WebContents } from "electron";

import { waitForActiveBridgePort } from "./agentBridge.js";
import type { AcpStdioMcpServer } from "./shared/browserToolProtocol.js";
import { runAsCaller } from "./cli/callerContext.js";
import {
  listScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  runScheduledTask,
  requireOwnedScheduledTask,
  listScheduledTaskRuns,
  type ScheduledTaskInput
} from "./cli/scheduledTasks.js";
import { listCliMembers } from "./cli/members.js";
import { listSkills, setSkillEnabled, setSkillTrusted, importSkills } from "./cli/skills.js";
import {
  listWorkflowTeams,
  getWorkflowTeam,
  insertWorkflowTeam,
  updateWorkflowTeam,
  deleteWorkflowTeam,
  type UpsertWorkflowTeamInput
} from "./cli/workflowTeams.js";
import { builtinWorkflowTeams } from "./cli/workflowTeamBuiltins.js";
import {
  getDelegationTeam,
  insertDelegationTeam,
  listDelegationTeams,
  type UpsertDelegationTeamInput
} from "./cli/delegationTeams.js";
import { normalizeButlerDelegationTeamInput } from "./cli/butlerDelegationTeams.js";
import {
  listConversations,
  archiveConversation,
  deleteConversation,
  getConversation,
  listMessages,
  requireOwnedConversation,
  notifyConversationsChanged,
  type ConversationMessage
} from "./cli/conversations.js";
import { getDb } from "./cli/db.js";
import { cliCheck, listRuntimes } from "./cli/check.js";
import { setSetting } from "./cli/settings.js";
import { safeSendToWebContents } from "./cli/ipcSend.js";
import { prepareAgentSelfCheckLogs } from "./debugLogExport.js";
import { logMain } from "./debugLog.js";
import { getMainWindowPresence } from "./uiPresence.js";

const BUTLER_TOOL_PATH = "/freebuddy/butler-tool";
const MAX_REQUEST_BYTES = 64 * 1024;

interface ButlerToolBinding {
  token: string;
  taskSessionId: string;
  agentId: string;
  userId: string | null;
  webContents: WebContents | undefined;
}

const bindingsByToken = new Map<string, ButlerToolBinding>();
const tokensByTaskSession = new Map<string, string>();

// Pet/chat companions bind butler tools to their own webContents. UI shell
// mutations (theme, settings) must still reach the main FreeBuddy window.
let butlerAppWindowGetter: (() => BrowserWindow | null) | null = null;

export function setButlerAppWindowGetter(
  getter: () => BrowserWindow | null
): void {
  butlerAppWindowGetter = getter;
}

function resolveButlerAppWebContents(
  fallback?: WebContents
): WebContents | undefined {
  const win = butlerAppWindowGetter?.() ?? null;
  if (win && !win.isDestroyed()) {
    return win.webContents;
  }
  if (fallback && !fallback.isDestroyed()) {
    return fallback;
  }
  return undefined;
}

function focusButlerAppWindow(): boolean {
  const win = butlerAppWindowGetter?.() ?? null;
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

type ButlerToolAction =
  | "status_get"
  | "scheduled_task_list"
  | "scheduled_task_create"
  | "scheduled_task_update"
  | "scheduled_task_delete"
  | "scheduled_task_run"
  | "scheduled_task_list_runs"
  | "skill_set_enabled"
  | "skill_trust"
  | "skill_import"
  | "conversation_list"
  | "conversation_archive"
  | "conversation_delete"
  | "conversation_self_check"
  | "conversation_messages"
  | "agent_check"
  | "settings_open"
  | "set_appearance"
  | "conversation_open"
  | "view_open"
  | "delegation_team_list"
  | "delegation_team_get"
  | "delegation_team_create"
  | "team_list"
  | "team_get"
  | "team_create"
  | "team_template_list"
  | "team_create_from_template"
  | "team_role_set_agent"
  | "team_role_set_skills"
  | "team_update_policy"
  | "team_node_list"
  | "team_node_add"
  | "team_node_update"
  | "team_node_delete"
  | "team_edge_add"
  | "team_edge_delete"
  | "team_set_enabled"
  | "team_update"
  | "team_delete";

function isButlerToolAction(value: unknown): value is ButlerToolAction {
  return (
    value === "status_get" ||
    value === "scheduled_task_list" ||
    value === "scheduled_task_create" ||
    value === "scheduled_task_update" ||
    value === "scheduled_task_delete" ||
    value === "scheduled_task_run" ||
    value === "scheduled_task_list_runs" ||
    value === "skill_set_enabled" ||
    value === "skill_trust" ||
    value === "skill_import" ||
    value === "conversation_list" ||
    value === "conversation_archive" ||
    value === "conversation_delete" ||
    value === "conversation_self_check" ||
    value === "conversation_messages" ||
    value === "agent_check" ||
    value === "settings_open" ||
    value === "set_appearance" ||
    value === "conversation_open" ||
    value === "view_open" ||
    value === "delegation_team_list" ||
    value === "delegation_team_get" ||
    value === "delegation_team_create" ||
    value === "team_list" ||
    value === "team_get" ||
    value === "team_create" ||
    value === "team_template_list" ||
    value === "team_create_from_template" ||
    value === "team_role_set_agent" ||
    value === "team_role_set_skills" ||
    value === "team_update_policy" ||
    value === "team_node_list" ||
    value === "team_node_add" ||
    value === "team_node_update" ||
    value === "team_node_delete" ||
    value === "team_edge_add" ||
    value === "team_edge_delete" ||
    value === "team_set_enabled" ||
    value === "team_update" ||
    value === "team_delete"
  );
}

function createCapabilityToken(): string {
  return randomBytes(32).toString("base64url");
}

function butlerMcpServerPath(): string {
  return fileURLToPath(new URL("./mcp/butlerMcpServer.js", import.meta.url));
}

function withCaller<T>(binding: ButlerToolBinding, fn: () => T): T {
  return binding.userId ? runAsCaller(binding.userId, fn) : fn();
}

const MAX_MESSAGE_TEXT_CHARS = 4000;

function extractMessageText(message: ConversationMessage): string {
  if (message.role !== "assistant") {
    return String(message.content ?? "");
  }
  try {
    const parsed = JSON.parse(message.content) as unknown;
    if (!Array.isArray(parsed)) {
      return String(message.content ?? "");
    }
    return parsed
      .flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const kind = String(row.kind ?? "");
        if (kind === "text" || kind === "raw" || kind === "thinking") {
          return [String(row.content ?? row.text ?? "")];
        }
        if (kind === "error") {
          return [String(row.message ?? row.content ?? "")];
        }
        return [];
      })
      .filter((piece) => piece.trim().length > 0)
      .join("\n\n");
  } catch {
    return String(message.content ?? "");
  }
}

function publicConversationMessage(message: ConversationMessage) {
  const fullText = extractMessageText(message).replace(
    /data:[^;,\s]+;base64,[a-z0-9+/=]+/gi,
    "[inline media removed]"
  );
  const truncated = fullText.length > MAX_MESSAGE_TEXT_CHARS;
  return {
    id: message.id,
    role: message.role,
    status: message.status,
    createdAt: message.createdAt,
    agentName: message.agentName,
    text: truncated
      ? `${fullText.slice(0, MAX_MESSAGE_TEXT_CHARS)}\n[truncated]`
      : fullText,
    truncated,
    attachmentCount: message.attachments?.length ?? 0
  };
}

function publicTask(task: ReturnType<typeof listScheduledTasks>[number]) {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    agentId: task.agentId,
    scheduleType: task.scheduleType,
    timeLocal: task.timeLocal,
    scheduleDate: task.scheduleDate,
    weekdays: task.weekdays,
    monthDay: task.monthDay,
    cwd: task.cwd,
    executionMode: task.executionMode,
    enabled: task.enabled,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    lastStatus: task.lastStatus,
    lastError: task.lastError
  };
}

function publicTeam(team: ReturnType<typeof listWorkflowTeams>[number]) {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    icon: team.icon,
    enabled: team.enabled,
    source: team.source,
    roles: team.roles.map((role) => ({
      id: role.id,
      label: role.label,
      kind: role.kind,
      agentId: role.agentId,
      required: role.required,
      canWrite: role.canWrite,
      skillIds: role.skillIds ?? []
    })),
    policy: team.policy
  };
}

function publicDelegationTeam(
  team: ReturnType<typeof listDelegationTeams>[number]
) {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    sharedInstructions: team.sharedInstructions,
    icon: team.icon,
    enabled: team.enabled,
    source: team.source,
    kind: team.kind,
    entryRoleId: team.entryRoleId,
    roster: team.roster.map((role) => ({
      id: role.id,
      label: role.label,
      agentId: role.agentId,
      model: role.model,
      modelOptionId: role.modelOptionId,
      capability: role.capability,
      instructions: role.instructions,
      canWrite: role.canWrite,
      skillIds: role.skillIds ?? []
    })),
    policy: team.policy
  };
}

export async function registerButlerToolSession(input: {
  taskSessionId: string;
  agentId: string;
  userId: string | null;
  webContents: WebContents | undefined;
}): Promise<AcpStdioMcpServer> {
  unregisterButlerToolSession(input.taskSessionId);

  const port = await waitForActiveBridgePort();
  const token = createCapabilityToken();
  const binding: ButlerToolBinding = { ...input, token };
  bindingsByToken.set(token, binding);
  tokensByTaskSession.set(input.taskSessionId, token);

  return {
    name: "freebuddy-butler",
    command: process.execPath,
    args: [butlerMcpServerPath()],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      {
        name: "FREEBUDDY_BUTLER_ENDPOINT",
        value: `http://127.0.0.1:${port}${BUTLER_TOOL_PATH}`
      },
      { name: "FREEBUDDY_BUTLER_TOKEN", value: token },
      {
        name: "FB_APP_VERSION",
        value: process.env.FB_APP_VERSION || "0.1.0"
      }
    ]
  };
}

export function unregisterButlerToolSession(taskSessionId: string): void {
  const token = tokensByTaskSession.get(taskSessionId);
  if (!token) return;
  tokensByTaskSession.delete(taskSessionId);
  bindingsByToken.delete(token);
}

async function dispatchButlerAction(
  binding: ButlerToolBinding,
  action: ButlerToolAction,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (action.startsWith("team_") || action.startsWith("delegation_team_")) {
    logMain().info(
      action.startsWith("delegation_team_") ? "delegationTeams" : "workflowTeams",
      "caller",
      {
        caller: "butler",
        op: action,
        teamId: params.id ?? params.teamId,
        pid: process.pid
      }
    );
  }
  switch (action) {
    case "status_get": {
      const members = withCaller(binding, () => listCliMembers());
      const skills = withCaller(binding, () => listSkills());
      const runtimes = listRuntimes();
      const taskCount = withCaller(binding, () => listScheduledTasks()).length;
      const workflowTeamCount = listWorkflowTeams().length;
      const delegationTeamCount = listDelegationTeams().length;
      return {
        agents: members.map((member) => ({
          id: member.id,
          name: member.name,
          adapter: member.cli.adapter,
          enabled: member.enabled
        })),
        skills: skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          source: skill.source,
          enabled: skill.enabled,
          trusted: skill.trusted
        })),
        runtimes: runtimes.map((rt) => ({
          adapter: rt.adapter,
          installed: rt.installed,
          version: rt.version,
          lastError: rt.lastError,
          lastCheckAt: rt.lastCheckAt
        })),
        scheduledTaskCount: taskCount,
        teamCount: workflowTeamCount + delegationTeamCount,
        workflowTeamCount,
        delegationTeamCount,
        mainWindow: getMainWindowPresence()
      };
    }
    case "scheduled_task_list": {
      const tasks = withCaller(binding, () => listScheduledTasks());
      return { tasks: tasks.map(publicTask) };
    }
    case "scheduled_task_create": {
      const input = params.input as ScheduledTaskInput | undefined;
      const result = withCaller(binding, () => createScheduledTask(input!));
      if (!result.ok) {
        return { ok: false, error: result.errors.join("; ") };
      }
      return { task: publicTask(result.task) };
    }
    case "scheduled_task_delete": {
      const id = String(params.id ?? "");
      const owned = withCaller(binding, () => requireOwnedScheduledTask(id));
      if (!owned) {
        return { ok: false, error: "Task not found or not owned by the caller." };
      }
      const ok = withCaller(binding, () => deleteScheduledTask(id));
      return { ok, id };
    }
    case "scheduled_task_update": {
      const id = String(params.id ?? "");
      const owned = withCaller(binding, () => requireOwnedScheduledTask(id));
      if (!owned) {
        return { ok: false, error: "Task not found or not owned by the caller." };
      }
      const input = params.input as ScheduledTaskInput | undefined;
      const result = withCaller(binding, () => updateScheduledTask(id, input!));
      if (!result.ok) {
        return { ok: false, error: result.errors.join("; ") };
      }
      return { task: publicTask(result.task) };
    }
    case "scheduled_task_run": {
      const id = String(params.id ?? "");
      const owned = withCaller(binding, () => requireOwnedScheduledTask(id));
      if (!owned) {
        return { ok: false, error: "Task not found or not owned by the caller." };
      }
      const ok = await runScheduledTask(id, binding.webContents);
      return { ok, id };
    }
    case "scheduled_task_list_runs": {
      const id = String(params.id ?? "");
      const owned = withCaller(binding, () => requireOwnedScheduledTask(id));
      if (!owned) {
        return { ok: false, error: "Task not found or not owned by the caller." };
      }
      const runs = withCaller(binding, () => listScheduledTaskRuns(id));
      return { runs };
    }
    case "skill_set_enabled": {
      const id = String(params.id ?? "");
      const enabled = Boolean(params.enabled);
      const skill = withCaller(binding, () => setSkillEnabled(id, enabled));
      if (!skill) {
        return { ok: false, error: "Skill not found." };
      }
      return {
        skill: {
          id: skill.id,
          name: skill.name,
          enabled: skill.enabled,
          trusted: skill.trusted
        }
      };
    }
    case "skill_trust": {
      const id = String(params.id ?? "");
      const trusted = Boolean(params.trusted);
      const skill = withCaller(binding, () => setSkillTrusted(id, trusted));
      if (!skill) {
        return { ok: false, error: "Skill not found." };
      }
      return {
        skill: {
          id: skill.id,
          name: skill.name,
          enabled: skill.enabled,
          trusted: skill.trusted
        }
      };
    }
    case "skill_import": {
      const sourcePath = String(params.sourcePath ?? "").trim();
      if (!sourcePath) {
        return { ok: false, error: "sourcePath is required." };
      }
      const result = withCaller(binding, () => importSkills(sourcePath));
      return { imported: result.imported, errors: result.errors };
    }
    case "conversation_list": {
      const archived =
        params.archived === true ? true : params.archived === false ? false : undefined;
      const conversations = withCaller(binding, () =>
        listConversations(archived === undefined ? {} : { archived })
      );
      const lastStatusById = new Map<string, { status: string; role: string }>();
      if (conversations.length > 0) {
        const ids = conversations.map((c) => c.id);
        const placeholders = ids.map(() => "?").join(",");
        const rows = getDb()
          .prepare(
            `SELECT conversation_id, status, role FROM (
               SELECT conversation_id, status, role,
                 ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC) AS rn
               FROM conversation_messages
               WHERE conversation_id IN (${placeholders})
             ) WHERE rn = 1`
          )
          .all(...ids) as Array<{
          conversation_id: string;
          status: string;
          role: string;
        }>;
        for (const row of rows) {
          lastStatusById.set(row.conversation_id, {
            status: row.status,
            role: row.role
          });
        }
      }
      return {
        conversations: conversations.map((c) => {
          const last = lastStatusById.get(c.id);
          return {
            id: c.id,
            title: c.title,
            agentId: c.agentId,
            agentName: c.agentName,
            adapter: c.adapter,
            archived: c.archived,
            updatedAt: c.updatedAt,
            lastMessageStatus: last?.status,
            lastMessageRole: last?.role
          };
        })
      };
    }
    case "conversation_archive": {
      const id = String(params.id ?? "");
      const archived = Boolean(params.archived);
      withCaller(binding, () => archiveConversation(id, archived));
      notifyConversationsChanged();
      return { ok: true, id, archived };
    }
    case "conversation_delete": {
      const id = String(params.id ?? "");
      withCaller(binding, () => deleteConversation(id));
      notifyConversationsChanged();
      return { ok: true, id };
    }
    case "conversation_self_check": {
      const conversationId = String(params.conversationId ?? "").trim();
      if (!conversationId) {
        return { ok: false, error: "conversationId is required." };
      }
      const conv = withCaller(binding, () => getConversation(conversationId));
      if (!conv) {
        return { ok: false, error: "Conversation not found." };
      }
      const result = await prepareAgentSelfCheckLogs(conversationId);
      return {
        logDirectory: result.path,
        conversation: {
          id: conv.id,
          title: conv.title,
          agentName: conv.agentName,
          adapter: conv.adapter
        },
        hint: "Read README.txt, environment.json, dsh-acp-runtime.json, logs/, and sessions/ under logDirectory, then produce a structured self-check report."
      };
    }
    case "conversation_messages": {
      const conversationId = String(params.conversationId ?? params.id ?? "").trim();
      if (!conversationId) {
        return { ok: false, error: "conversationId is required." };
      }
      const conv = withCaller(binding, () => requireOwnedConversation(conversationId));
      if (!conv) {
        return { ok: false, error: "Conversation not found." };
      }
      const all = withCaller(binding, () => listMessages(conversationId));
      const roleFilter = String(params.role ?? "").trim();
      const filtered =
        roleFilter === "user" || roleFilter === "assistant" || roleFilter === "system"
          ? all.filter((message) => message.role === roleFilter)
          : all;
      const limitRaw = Number(params.limit ?? 20);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(40, Math.max(1, Math.floor(limitRaw)))
        : 20;
      const useTail = params.tail !== false && params.offset === undefined;
      const offsetRaw = Number(params.offset ?? 0);
      const offset = Number.isFinite(offsetRaw)
        ? Math.max(0, Math.floor(offsetRaw))
        : 0;
      const start = useTail
        ? Math.max(0, filtered.length - limit)
        : Math.min(offset, filtered.length);
      const page = filtered.slice(start, start + limit);
      return {
        ok: true,
        conversation: {
          id: conv.id,
          title: conv.title,
          agentId: conv.agentId,
          agentName: conv.agentName
        },
        total: filtered.length,
        offset: start,
        limit,
        tail: useTail,
        hasMore: start + page.length < filtered.length || start > 0,
        messages: page.map(publicConversationMessage)
      };
    }
    case "agent_check": {
      const adapter = String(params.adapter ?? "").trim();
      if (!adapter) {
        return { ok: false, error: "adapter is required." };
      }
      const result = await cliCheck(adapter);
      return { adapter, installed: result.installed };
    }
    case "settings_open": {
      const tab = String(params.tab ?? "cli");
      const target = resolveButlerAppWebContents(binding.webContents);
      if (!target) {
        return { ok: false, error: "No active window to open settings." };
      }
      focusButlerAppWindow();
      safeSendToWebContents(target, "freebuddy://open-settings", { tab });
      return { ok: true, tab };
    }
    case "set_appearance": {
      const theme = String(params.theme ?? "").trim();
      if (theme !== "system" && theme !== "light" && theme !== "dark") {
        return { ok: false, error: "theme must be one of: system, light, dark." };
      }
      setSetting("theme", theme);
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        safeSendToWebContents(win.webContents, "freebuddy://appearance-changed", {
          theme
        });
      }
      return { ok: true, theme };
    }
    case "conversation_open": {
      const id = String(params.id ?? "").trim();
      const titleQuery = String(params.titleQuery ?? "").trim().toLowerCase();
      const lastMessageStatus = String(params.lastMessageStatus ?? "").trim();
      const archived =
        params.archived === true ? true : params.archived === false ? false : false;

      let conv =
        id.length > 0
          ? withCaller(binding, () => requireOwnedConversation(id))
          : undefined;

      if (!conv && (titleQuery || lastMessageStatus)) {
        const conversations = withCaller(binding, () =>
          listConversations({ archived })
        );
        const lastStatusById = new Map<string, string>();
        if (conversations.length > 0 && lastMessageStatus) {
          const ids = conversations.map((c) => c.id);
          const placeholders = ids.map(() => "?").join(",");
          const rows = getDb()
            .prepare(
              `SELECT conversation_id, status FROM (
                 SELECT conversation_id, status,
                   ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC) AS rn
                 FROM conversation_messages
                 WHERE conversation_id IN (${placeholders})
               ) WHERE rn = 1`
            )
            .all(...ids) as Array<{ conversation_id: string; status: string }>;
          for (const row of rows) {
            lastStatusById.set(row.conversation_id, row.status);
          }
        }
        const matches = conversations.filter((c) => {
          if (titleQuery && !c.title.toLowerCase().includes(titleQuery)) {
            return false;
          }
          if (
            lastMessageStatus &&
            lastStatusById.get(c.id) !== lastMessageStatus
          ) {
            return false;
          }
          return Boolean(titleQuery || lastMessageStatus);
        });
        if (matches.length === 0) {
          return { ok: false, error: "No matching conversation found." };
        }
        if (matches.length > 1) {
          return {
            ok: false,
            error: "Multiple conversations matched; pass id to disambiguate.",
            matches: matches.slice(0, 10).map((c) => ({
              id: c.id,
              title: c.title,
              agentId: c.agentId,
              agentName: c.agentName,
              lastMessageStatus: lastStatusById.get(c.id)
            }))
          };
        }
        conv = matches[0];
      }

      if (!conv) {
        return {
          ok: false,
          error: "Provide id, or titleQuery / lastMessageStatus to find a conversation."
        };
      }

      const target = resolveButlerAppWebContents(binding.webContents);
      if (!target) {
        return { ok: false, error: "No active window to open conversation." };
      }
      focusButlerAppWindow();
      safeSendToWebContents(target, "window:open-conversation", conv.id);
      return {
        ok: true,
        id: conv.id,
        title: conv.title,
        agentId: conv.agentId,
        agentName: conv.agentName
      };
    }
    case "view_open": {
      const view = String(params.view ?? "").trim();
      if (
        view !== "chat" &&
        view !== "scheduledTasks" &&
        view !== "workflowTeams" &&
        view !== "usage"
      ) {
        return {
          ok: false,
          error: "view must be one of: chat, scheduledTasks, workflowTeams, usage."
        };
      }
      const target = resolveButlerAppWebContents(binding.webContents);
      if (!target) {
        return { ok: false, error: "No active window to open view." };
      }
      const payload: Record<string, unknown> = { view };
      if (view === "workflowTeams") {
        if (typeof params.teamId === "string" && params.teamId.trim()) {
          payload.teamId = params.teamId.trim();
        }
        if (params.create === true) {
          payload.create = true;
        }
      }
      focusButlerAppWindow();
      safeSendToWebContents(target, "freebuddy://open-view", payload);
      return { ok: true, ...payload };
    }
    case "delegation_team_list": {
      return { teams: listDelegationTeams().map(publicDelegationTeam) };
    }
    case "delegation_team_get": {
      const id = String(params.id ?? "").trim();
      const team = getDelegationTeam(id);
      if (!team) {
        return { ok: false, error: "Self-organizing team not found." };
      }
      return { team: publicDelegationTeam(team) };
    }
    case "delegation_team_create": {
      const agents = withCaller(binding, () => listCliMembers());
      const normalized = normalizeButlerDelegationTeamInput(params, agents);
      if (!normalized.ok) return normalized;

      const input: UpsertDelegationTeamInput = {
        id: `team-delegation-user-${randomBytes(4).toString("hex")}`,
        source: "user",
        ...normalized.input
      };
      const team = insertDelegationTeam(input);
      return { team: publicDelegationTeam(team) };
    }
    case "team_list": {
      const teams = listWorkflowTeams();
      for (const team of teams) {
        if (team.roles.every((r) => (r.skillIds?.length ?? 0) === 0)) {
          logMain().warn("workflowTeams", "team_list read empty skills", {
            teamId: team.id,
            pid: process.pid,
            updatedAt: team.updatedAt
          });
        }
      }
      return { teams: teams.map(publicTeam) };
    }
    case "team_get": {
      const id = String(params.id ?? "");
      const team = getWorkflowTeam(id);
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      const skillCounts = team.roles.map((r) => ({ id: r.id, n: r.skillIds?.length ?? 0 }));
      if (skillCounts.every((s) => s.n === 0)) {
        logMain().warn("workflowTeams", "team_get read empty skills", {
          teamId: id,
          pid: process.pid,
          skillCounts,
          updatedAt: team.updatedAt
        });
      }
      return {
        team: {
          ...publicTeam(team),
          template: {
            id: team.template.id,
            name: team.template.name,
            nodes: team.template.nodes.map((n) => ({
              id: n.id,
              title: n.title,
              mode: n.mode,
              roleId: n.roleId,
              contract: n.contract,
              promptTemplate: n.promptTemplate
            })),
            edges: team.template.edges.map((e) => ({
              id: e.id,
              from: e.from,
              to: e.to
            })),
            startNodeIds: team.template.startNodeIds,
            finalNodeIds: team.template.finalNodeIds
          }
        }
      };
    }
    case "team_create": {
      const name = String(params.name ?? "").trim();
      if (!name) {
        return { ok: false, error: "Team name is required." };
      }
      const id = `team-user-${randomBytes(4).toString("hex")}`;
      const input: UpsertWorkflowTeamInput = {
        id,
        name,
        description: params.description ? String(params.description) : undefined,
        icon: params.icon ? String(params.icon) : undefined,
        enabled: params.enabled !== false,
        source: "user",
        roles: [],
        template: {
          id: "tpl-configurable-delivery",
          name: "Configurable delivery",
          version: 1,
          nodes: [],
          edges: [],
          startNodeIds: [],
          finalNodeIds: []
        },
        policy: {
          allowWrites: true,
          requireApprovalBeforeWrite: true,
          requireApprovalAfterReview: false,
          maxParallelReadSteps: 1,
          maxParallelWriteSteps: 1,
          maxLoops: 2,
          stopOnVerifyFailure: false
        }
      };
      const team = insertWorkflowTeam(input);
      return { team: publicTeam(team) };
    }
    case "team_template_list": {
      const templates = builtinWorkflowTeams();
      return {
        templates: templates.map((template) => ({
          id: template.id,
          name: template.name,
          description: template.description,
          roles: template.roles.map((role) => ({
            id: role.id,
            label: role.label,
            kind: role.kind,
            agentId: role.agentId
          })),
          nodeCount: template.template.nodes.length,
          allowWrites: template.policy.allowWrites
        }))
      };
    }
    case "team_create_from_template": {
      const templateId = String(params.templateId ?? "");
      const template =
        builtinWorkflowTeams().find((t) => t.id === templateId) ??
        getWorkflowTeam(templateId);
      if (!template) {
        return { ok: false, error: "Template not found. Use team_template_list to list available templates." };
      }
      const name = String(params.name ?? "").trim() || template.name;
      const id = `team-user-${randomBytes(4).toString("hex")}`;
      const input: UpsertWorkflowTeamInput = {
        id,
        name,
        description: params.description ? String(params.description) : template.description,
        icon: template.icon,
        enabled: true,
        source: "user",
        roles: template.roles,
        template: {
          ...template.template,
          id: `${template.template.id}-${randomBytes(2).toString("hex")}`,
          name
        },
        policy: template.policy
      };
      const team = insertWorkflowTeam(input);
      return { team: publicTeam(team) };
    }
    case "team_role_set_agent": {
      const teamId = String(params.teamId ?? "");
      const roleId = String(params.roleId ?? "");
      const agentId = String(params.agentId ?? "");
      const team = getWorkflowTeam(teamId);
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      if (!team.roles.some((r) => r.id === roleId)) {
        return { ok: false, error: "Role not found in this team." };
      }
      const roles = team.roles.map((r) =>
        r.id === roleId ? { ...r, agentId } : r
      );
      const updated = updateWorkflowTeam(teamId, { roles });
      return { team: publicTeam(updated!) };
    }
    case "team_role_set_skills": {
      const teamId = String(params.teamId ?? "");
      const roleId = String(params.roleId ?? "");
      const skillIds = Array.isArray(params.skillIds)
        ? params.skillIds.map((s) => String(s))
        : [];
      const team = getWorkflowTeam(teamId);
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      if (!team.roles.some((r) => r.id === roleId)) {
        return { ok: false, error: "Role not found in this team." };
      }
      const roles = team.roles.map((r) =>
        r.id === roleId ? { ...r, skillIds } : r
      );
      const updated = updateWorkflowTeam(teamId, { roles });
      return { team: publicTeam(updated!) };
    }
    case "team_update_policy": {
      const teamId = String(params.teamId ?? "");
      const team = getWorkflowTeam(teamId);
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      const policy = { ...team.policy };
      if (typeof params.allowWrites === "boolean") policy.allowWrites = params.allowWrites;
      if (typeof params.requireApprovalBeforeWrite === "boolean") policy.requireApprovalBeforeWrite = params.requireApprovalBeforeWrite;
      if (typeof params.requireApprovalAfterReview === "boolean") policy.requireApprovalAfterReview = params.requireApprovalAfterReview;
      if (typeof params.maxParallelReadSteps === "number") policy.maxParallelReadSteps = params.maxParallelReadSteps;
      if (typeof params.maxLoops === "number") policy.maxLoops = params.maxLoops;
      if (typeof params.stopOnVerifyFailure === "boolean") policy.stopOnVerifyFailure = params.stopOnVerifyFailure;
      const updated = updateWorkflowTeam(teamId, { policy });
      return { team: publicTeam(updated!) };
    }
    case "team_node_list": {
      const teamId = String(params.teamId ?? "");
      const team = getWorkflowTeam(teamId);
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      return {
        nodes: team.template.nodes.map((n) => ({
          id: n.id,
          title: n.title,
          mode: n.mode,
          roleId: n.roleId,
          contract: n.contract,
          promptTemplate: n.promptTemplate
        })),
        edges: team.template.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
        startNodeIds: team.template.startNodeIds,
        finalNodeIds: team.template.finalNodeIds
      };
    }
    case "team_node_add": {
      const teamId = String(params.teamId ?? "");
      const team = getWorkflowTeam(teamId);
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      const nodeId = `node-${randomBytes(2).toString("hex")}`;
      const newNode = {
        id: nodeId,
        title: String(params.title ?? "").trim() || "Step",
        mode: String(params.mode ?? "research") as any,
        ...(params.roleId ? { roleId: String(params.roleId) } : {}),
        ...(params.contract ? { contract: String(params.contract) as any } : {}),
        ...(params.promptTemplate ? { promptTemplate: String(params.promptTemplate) } : {})
      };
      const fromNodeIds = Array.isArray(params.fromNodeIds) && params.fromNodeIds.length > 0
        ? params.fromNodeIds.map((s) => String(s))
        : team.template.finalNodeIds;
      const newEdges = fromNodeIds.map((from) => ({
        id: `edge-${randomBytes(2).toString("hex")}`,
        from,
        to: nodeId
      }));
      const template = {
        ...team.template,
        nodes: [...team.template.nodes, newNode],
        edges: [...team.template.edges, ...newEdges],
        finalNodeIds: [nodeId]
      };
      const updated = updateWorkflowTeam(teamId, { template });
      return { team: publicTeam(updated!) };
    }
    case "team_node_update": {
      const teamId = String(params.teamId ?? "");
      const nodeId = String(params.nodeId ?? "");
      const team = getWorkflowTeam(teamId);
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      if (!team.template.nodes.some((n) => n.id === nodeId)) {
        return { ok: false, error: "Node not found." };
      }
      const nodes = team.template.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const updated: typeof n = { ...n };
        if (typeof params.title === "string") updated.title = params.title;
        if (typeof params.mode === "string") updated.mode = params.mode as any;
        if (typeof params.contract === "string") updated.contract = params.contract as any;
        if (typeof params.roleId === "string") updated.roleId = params.roleId;
        if (typeof params.promptTemplate === "string") updated.promptTemplate = params.promptTemplate;
        return updated;
      });
      const updated = updateWorkflowTeam(teamId, { template: { ...team.template, nodes } });
      return { team: publicTeam(updated!) };
    }
    case "team_node_delete": {
      const teamId = String(params.teamId ?? "");
      const nodeId = String(params.nodeId ?? "");
      const team = getWorkflowTeam(teamId);
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      const nodes = team.template.nodes.filter((n) => n.id !== nodeId);
      const edges = team.template.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
      let startNodeIds = team.template.startNodeIds.filter((id) => id !== nodeId);
      let finalNodeIds = team.template.finalNodeIds.filter((id) => id !== nodeId);
      if (team.template.finalNodeIds.includes(nodeId)) {
        const preds = team.template.edges.filter((e) => e.to === nodeId).map((e) => e.from);
        finalNodeIds = [...new Set([...finalNodeIds, ...preds])];
      }
      if (team.template.startNodeIds.includes(nodeId)) {
        const succs = team.template.edges.filter((e) => e.from === nodeId).map((e) => e.to);
        startNodeIds = [...new Set([...startNodeIds, ...succs])];
      }
      const template = { ...team.template, nodes, edges, startNodeIds, finalNodeIds };
      const updated = updateWorkflowTeam(teamId, { template });
      return { team: publicTeam(updated!) };
    }
    case "team_edge_add": {
      const teamId = String(params.teamId ?? "");
      const team = getWorkflowTeam(teamId);
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      const edge = {
        id: `edge-${randomBytes(2).toString("hex")}`,
        from: String(params.from ?? ""),
        to: String(params.to ?? "")
      };
      const template = {
        ...team.template,
        edges: [...team.template.edges, edge]
      };
      const updated = updateWorkflowTeam(teamId, { template });
      return { team: publicTeam(updated!) };
    }
    case "team_edge_delete": {
      const teamId = String(params.teamId ?? "");
      const edgeId = String(params.edgeId ?? "");
      const team = getWorkflowTeam(teamId);
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      const edges = team.template.edges.filter((e) => e.id !== edgeId);
      const updated = updateWorkflowTeam(teamId, { template: { ...team.template, edges } });
      return { team: publicTeam(updated!) };
    }
    case "team_set_enabled": {
      const id = String(params.id ?? "");
      const enabled = Boolean(params.enabled);
      const team = updateWorkflowTeam(id, { enabled });
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      return { team: publicTeam(team) };
    }
    case "team_update": {
      const id = String(params.id ?? "");
      const patch: Record<string, unknown> = {};
      if (typeof params.name === "string") patch.name = params.name;
      if (params.description !== undefined) {
        patch.description =
          params.description === null ? null : String(params.description);
      }
      if (params.icon !== undefined) {
        patch.icon = params.icon === null ? null : String(params.icon);
      }
      const team = updateWorkflowTeam(id, patch as any);
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      return { team: publicTeam(team) };
    }
    case "team_delete": {
      const id = String(params.id ?? "");
      const team = getWorkflowTeam(id);
      if (!team) {
        return { ok: false, error: "Team not found." };
      }
      if (team.source === "builtin") {
        return { ok: false, error: "Built-in teams cannot be deleted." };
      }
      const ok = deleteWorkflowTeam(id);
      return { ok, id };
    }
  }
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Butler tool request body is too large.");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function bearerToken(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  if (!value?.startsWith("Bearer ")) return undefined;
  return value.slice("Bearer ".length).trim() || undefined;
}

export async function handleButlerToolHttpRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return false;
  }
  if (url.pathname !== BUTLER_TOOL_PATH) return false;

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }

  const token = bearerToken(req);
  const binding = token ? bindingsByToken.get(token) : undefined;
  if (!binding) {
    sendJson(res, 401, { ok: false, error: "invalid_capability_token" });
    return true;
  }

  try {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    if (!body || !isButlerToolAction(body.action)) {
      sendJson(res, 400, { ok: false, error: "invalid_action" });
      return true;
    }
    const params =
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};
    if (!token || bindingsByToken.get(token) !== binding) {
      sendJson(res, 410, { ok: false, error: "butler_tool_session_ended" });
      return true;
    }
    const result = await dispatchButlerAction(binding, body.action, params);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: (error as Error)?.message || String(error)
    });
  }
  return true;
}
