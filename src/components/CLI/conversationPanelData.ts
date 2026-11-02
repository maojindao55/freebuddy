import type { TFunction } from "i18next";
import type { CliStreamItem, ConversationOverview } from "@freebuddy/protocol";
import type { Conversation } from "@/services/cli/types";
import type { LiveAssistant } from "@/store/conversationStore";

export type PanelStatus = ConversationOverview["status"];
export type PanelActivity = ConversationOverview["activities"][number];

export const RUNNING_PANEL_STATUSES: ReadonlySet<PanelStatus> = new Set(["starting", "running"]);
export const ATTENTION_PANEL_STATUSES: ReadonlySet<PanelStatus> = new Set(["needs-input", "failed"]);

export function selectConversationPanelStatus(
  overview: ConversationOverview | undefined,
  signals: { attentionCount?: number; live?: Pick<LiveAssistant, "status">; workflowStatus?: string }
): PanelStatus {
  if ((signals.attentionCount ?? 0) > 0) return "needs-input";
  if (signals.live?.status === "starting" || signals.live?.status === "running") {
    return signals.live.status;
  }
  // A fetched snapshot is newer evidence than the selected-chat workflow cache.
  if (!overview || overview.status === "unknown") {
    switch (signals.workflowStatus) {
      case "pending_approval": return "needs-input";
      case "running": return "running";
      case "blocked": return "waiting";
      case "paused": return "paused";
    }
  }
  return overview?.status ?? "unknown";
}

export function currentConversationPanelSnapshot(
  overview: ConversationOverview | undefined,
  live: Pick<LiveAssistant, "status" | "taskSessionId"> | undefined
): ConversationOverview | undefined {
  if (live && (live.status === "starting" || live.status === "running") && overview?.taskId !== live.taskSessionId) return undefined;
  return overview;
}

/** Preserve positions during streaming; append newly observed conversations at the front. */
export function stableConversationOrder(previous: string[], conversations: Conversation[]): string[] {
  const present = new Set(conversations.map((conversation) => conversation.id));
  const retained = previous.filter((id) => present.has(id));
  const known = new Set(retained);
  const additions = conversations.filter((conversation) => !known.has(conversation.id)).sort((a, b) => {
    const timeA = Date.parse(a.lastMessageAt ?? a.updatedAt ?? a.createdAt) || 0;
    const timeB = Date.parse(b.lastMessageAt ?? b.updatedAt ?? b.createdAt) || 0;
    return timeB - timeA || a.id.localeCompare(b.id);
  });
  return [...additions.map((conversation) => conversation.id), ...retained];
}

function compactValue(input: unknown): string {
  if (typeof input === "string") return input.replace(/\s+/g, " ").slice(0, 200);
  if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    for (const key of ["file_path", "filePath", "path", "command", "cmd", "query", "url"]) {
      if (typeof value[key] === "string") return compactValue(value[key]);
    }
  }
  return "";
}

export function livePanelActivity(items: CliStreamItem[], messageId: string): { activities: PanelActivity[]; summary?: string; model?: string } {
  const activities = new Map<string, PanelActivity>();
  let summary = "";
  let model: string | undefined;
  items.forEach((item, index) => {
    if (item.kind === "text" && item.role === "assistant") summary = item.append ? summary + item.content : item.content;
    if (item.kind === "config-options") {
      const option = item.options.find((entry) => entry.category === "model" || entry.id === "model");
      model = option?.currentLabel || option?.currentValue || model;
    }
    if (item.kind === "tool-call" && item.toolKind !== "think") {
      const id = item.id || `tool:${index}`;
      const previous = activities.get(id);
      const input = item.input && typeof item.input === "object" ? item.input as Record<string, unknown> : undefined;
      const edit = item.toolOutputs?.find((output) => output.kind === "file-edit");
      const inputPath = [input?.path, input?.file_path, input?.filePath].find((value): value is string => typeof value === "string");
      const filePath = item.locations?.[0]?.path || inputPath || (edit?.kind === "file-edit" ? edit.path : undefined) || previous?.filePath;
      activities.set(id, {
        id, messageId, toolCallId: item.id, kind: "tool-call", toolKind: item.toolKind || previous?.toolKind,
        status: item.isError ? "failed" : item.status || previous?.status || "running",
        target: filePath || compactValue(item.input) || previous?.target || item.tool || "",
        filePath
      });
    } else if (item.kind === "tool-result" && item.id && activities.has(item.id)) {
      const previous = activities.get(item.id)!;
      activities.set(item.id, { ...previous, status: item.isError ? "failed" : "completed" });
    } else if (item.kind === "file-edit") {
      const id = `file:${item.path}`;
      activities.set(id, { id, messageId, kind: "file-edit", toolKind: item.action === "delete" ? "delete" : "edit", status: item.status || "completed", target: item.path, filePath: item.path });
    } else if (item.kind === "command") {
      const id = `command:${index}`;
      activities.set(id, { id, messageId, kind: "command", toolKind: "execute", status: "running", target: item.command });
    } else if (item.kind === "error") {
      const id = `error:${index}`;
      activities.set(id, { id, messageId, kind: "error", status: "failed", target: item.message });
    }
  });
  // Code needs its opening fence; prose keeps the most recent reply/result.
  const reply = summary.trim();
  const hasCode = /`{3,}|~{3,}/.test(reply) || BARE_PANEL_DIAGRAM.test(reply);
  return { activities: [...activities.values()].slice(-6), summary: (hasCode ? reply.slice(0, 500) : reply.slice(-500)) || undefined, model };
}

type ActivityLabel = { key: string; target?: string; literal?: never } | { literal: string; key?: never; target?: never };
// A type name inside a prose sentence is not evidence of diagram source.
const BARE_PANEL_DIAGRAM = /(?:^|\n)\s*(?:mermaid\s+)?(?:sequenceDiagram|flowchart\s+(?:TD|TB|BT|RL|LR)|graph\s+(?:TD|TB|BT|RL|LR)|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|mindmap|timeline)\s*(?=\n|$)/;

function boundedText(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("").trimEnd()}…`;
}

function panelPath(value: string, cwd?: string): string {
  const path = value.trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  const base = cwd?.trim().replace(/\\/g, "/").replace(/\/$/, "");
  const windowsPath = /^[a-z]:\//i.test(path) || path.startsWith("//");
  const comparablePath = windowsPath ? path.toLowerCase() : path;
  const comparableBase = windowsPath ? base?.toLowerCase() : base;
  let relative = path;
  if (comparableBase && comparablePath.startsWith(`${comparableBase}/`)) relative = path.slice(base!.length + 1);
  else if (/^(?:\/|[a-z]:\/)/i.test(path)) relative = path.split("/").filter(Boolean).slice(-2).join("/");
  return boundedText(relative.replace(/^\.\//, ""), 56);
}

function isToolName(value: string): boolean {
  return /^mcp(?:[_:.]|__)/i.test(value) || /^[a-z][a-z\d]*(?:_[a-z\d]+)+$/i.test(value);
}

function readableActivity(value: string, cwd?: string): ActivityLabel | undefined {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || isToolName(text) || /(?:^|\s)mcp[_:.]|[;|<>`{}]|&&|\b(?:const|let|var|function|def|import|export)\s|=>/.test(text)) return undefined;
  if (/^(?:cd|npm|pnpm|yarn|bun|npx|python\d*|node|ruby|perl|bash|sh|powershell|pwsh|printf|echo|cat|head|tail|grep|rg|git|curl|wget|ls|dir|pwd)\b/i.test(text)) return undefined;
  if (!/[\u3400-\u9fff]/.test(text) && !/^[a-z][a-z\d'’,-]*(?:\s+[a-z][a-z\d'’(),./:+-]*){1,}$/i.test(text)) return undefined;
  const shortPaths = text.replace(/[a-z]:[/\\][^\s"'<>|;]+|(?<![:\w/])\/[^\s"'<>|;]+/gi, (path) => panelPath(path, cwd));
  return { literal: boundedText(shortPaths, 56) };
}

function activityFile(activity: PanelActivity, cwd?: string): string | undefined {
  if (activity.filePath) return panelPath(activity.filePath, cwd);
  const target = activity.target.trim().replace(/^["']|["']$/g, "");
  // A tool name or shell fragment is not evidence of a file target.
  if (isToolName(target) || /[\n;&|<>`]/.test(target) || /\s/.test(target)) return undefined;
  return /[/\\]|\.[a-z\d]{1,12}$/i.test(target) ? panelPath(target, cwd) : undefined;
}

function knownToolLabel(target: string): ActivityLabel | undefined {
  const name = target.trim().toLowerCase().replace(/[:.]+/g, "_").replace(/_+/g, "_");
  const actions: [RegExp, string][] = [
    [/(?:^|_)freebuddy_(?:skills_)?skill_list$/, "listSkills"],
    [/(?:^|_)freebuddy_(?:skills_)?skill_load$/, "loadSkill"],
    [/(?:^|_)freebuddy_(?:delegate_)?list_teammates$/, "listTeammates"],
    [/(?:^|_)freebuddy_(?:delegate_)?delegate$/, "delegateTask"],
    [/(?:^|_)freebuddy_(?:delegate_)?yield_to_delegates$/, "waitDelegates"]
  ];
  const action = actions.find(([pattern]) => pattern.test(name));
  return action ? { key: `conversationPanel.activity.${action[1]}` } : undefined;
}

function commandLabel(target: string, cwd?: string): ActivityLabel {
  // Hide cwd setup, shell arguments, heredocs and output. Only name a recognized action.
  const command = target.trim()
    .replace(/^cd(?:\s+\/d)?\s+(?:"[^"]*"|'[^']*'|[^\s;&]+)\s*(?:&&|;)\s*/i, "")
    .replace(/^Set-Location(?:\s+-Path)?\s+(?:"[^"]*"|'[^']*'|[^;]+)\s*;\s*/i, "")
    .replace(/^(?:[a-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/i, "");
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  const executable = (tokens[0]?.replace(/^["']|["']$/g, "").split(/[/\\]/).pop() ?? "").toLowerCase().replace(/\.(?:cmd|exe|bat)$/, "");
  const args = tokens.slice(1).map((value) => value.replace(/^["']|["']$/g, ""));
  const action = (name: string): ActivityLabel => ({ key: `conversationPanel.activity.${name}` });
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    const script = args[0] === "run" ? args[1] : args[0];
    if (/^(?:test|vitest|jest)(?::|$)/.test(script ?? "")) return action("runTests");
    if (/^build(?::|$)/.test(script ?? "")) return action("build");
    if (/^(?:typecheck|check-types)(?::|$)/.test(script ?? "")) return action("typecheck");
    if (/^(?:lint|eslint)(?::|$)/.test(script ?? "")) return action("lint");
    if (["install", "ci", "add"].includes(script ?? "")) return action("install");
  }
  if (["pytest", "vitest", "jest"].includes(executable) || (/^python(?:\d(?:\.\d+)?)?$/.test(executable) && args[0] === "-m" && args[1] === "pytest")) return action("runTests");
  if (executable === "tsc") return action("typecheck");
  if (executable === "eslint") return action("lint");
  if (executable === "vite" && args[0] === "build") return action("build");
  if (["rg", "grep", "findstr"].includes(executable)) return action("searchCode");
  if (executable === "git" && ["diff", "show", "log"].includes(args[0])) return action("inspectChanges");
  if (executable === "git" && args[0] === "status") return action("inspectStatus");
  if (["ls", "dir", "Get-ChildItem".toLowerCase()].includes(executable)) return action("listFiles");
  if (["pwd", "Get-Location".toLowerCase()].includes(executable)) return action("workingDirectory");
  if (["cat", "head", "tail", "type", "Get-Content".toLowerCase()].includes(executable)) {
    const file = args.find((value) => !value.startsWith("-") && !/^\d+$/.test(value) && !/[;&|<>]/.test(value));
    return file ? { key: "stream.read", target: panelPath(file, cwd) } : action("readFile");
  }
  if (["curl", "wget"].includes(executable)) return action("fetchPage");
  if (/^(?:python(?:\d(?:\.\d+)?)?|node|ruby|perl|bash|sh|powershell|pwsh)$/.test(executable)) return action("runScript");
  return action("runCommand");
}

function activityLabel(activity: PanelActivity, cwd?: string): ActivityLabel {
  const target = activity.target.replace(/\s+/g, " ").trim();
  if (activity.kind === "error") return { key: "conversationPanel.activity.error" };
  const known = knownToolLabel(target);
  if (known) return known;
  if (activity.kind === "command" || activity.toolKind === "execute") return commandLabel(activity.target, cwd);
  const file = activityFile(activity, cwd);
  const readable = readableActivity(activity.target, cwd);
  switch (activity.toolKind) {
    case "read": return file ? { key: "stream.read", target: file } : readable ?? { key: "conversationPanel.activity.readFile" };
    case "edit": return file ? { key: "stream.edit", target: file } : readable ?? { key: "conversationPanel.activity.editFile" };
    case "delete": return file ? { key: "stream.delete", target: file } : readable ?? { key: "conversationPanel.activity.deleteFile" };
    case "move": return file ? { key: "stream.move", target: file } : readable ?? { key: "conversationPanel.activity.moveFile" };
    case "search": return target && !isToolName(target) && !/[\n;&|<>`]/.test(activity.target)
      ? { key: "conversationPanel.activity.search", target: boundedText(file || target, 48) } : { key: "conversationPanel.activity.searchCode" };
    case "fetch": {
      try {
        const url = new URL(target);
        if (url.protocol === "https:" || url.protocol === "http:") return { key: "conversationPanel.activity.fetch", target: boundedText(url.host, 48) };
      } catch { /* No URL evidence; use the generic action. */ }
      return { key: "conversationPanel.activity.fetchPage" };
    }
    case "mode": return { key: "conversationPanel.activity.switchMode" };
    default: return readable ?? { key: "conversationPanel.activity.callTool" };
  }
}

export function formatPanelActivity(activity: PanelActivity, t: TFunction, cwd?: string): string {
  const { key, target, literal } = activityLabel(activity, cwd);
  if (literal !== undefined) return literal;
  return t(key, target ? { target } : undefined);
}

/** A card preview uses prose only; code and diagrams remain in their source chat. */
export function formatPanelSummary(summary: string | undefined, t: TFunction): string | undefined {
  if (!summary?.trim()) return undefined;
  let hadCode = false;
  let text = summary.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1(?:`+|~+)?|$)/g, () => { hadCode = true; return " "; });
  const diagram = BARE_PANEL_DIAGRAM.exec(text);
  if (diagram) { hadCode = true; text = text.slice(0, diagram.index); }
  text = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/!\[[^\]]*\](?:\[[^\]]*\])?/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, " ")
    .replace(/<(?:https?:\/\/|mailto:)[^>]+>/g, " ")
    .replace(/<\/?[a-z][\w-]*(?:\s+[a-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/gi, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(^|[\s(（])[*_]([^*_\n]+)[*_](?=$|[\s).,!?:;，。！？：；）])/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\([\\`*_[\]{}()#+.!>-])/g, "$1")
    .replace(/&(?:nbsp|amp|lt|gt|quot);/g, (entity) => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"' }[entity]!))
    .replace(/\s+/g, " ").replace(/\s+([，。！？：；）])/g, "$1").trim();
  if (hadCode && /(?:\u5982\u4e0b(?:\u6240\u793a)?|\u89c1\u4e0b\u65b9|\u89c1\u4e0b\u6587|shown below|as follows|below)\s*[：:]?$/i.test(text)) {
    const sentences = text.split(/(?<=[。！？!?])\s*|(?<=\.)(?:\s+|$)/).filter(Boolean);
    const introduction = sentences.pop() ?? "";
    // An introduction without the code would leave a dangling, unhelpful preview.
    if (!/(?:\u5df2\u5b8c\u6210|\u5df2\u4fee\u590d|\u5df2\u901a\u8fc7|\u5931\u8d25|\u6210\u529f|completed|fixed|passed|failed)/i.test(introduction)) text = sentences.join(" ");
  }
  if (!text) return hadCode ? t("conversationPanel.codeResult") : undefined;
  const characters = Array.from(text);
  return !hadCode && characters.length > 160 ? `…${characters.slice(-159).join("").trimStart()}` : boundedText(text, 160);
}

/** Keep navigable source objects while removing repeated completed labels. */
export function selectPanelActivities(activities: PanelActivity[], limit = 3): PanelActivity[] {
  const count = Number.isFinite(limit) ? Math.min(3, Math.max(0, Math.floor(limit))) : 3;
  if (!count) return [];
  const labels = activities.map((activity) => {
    const label = activityLabel(activity);
    return label.literal ?? `${label.key}:${label.target ?? ""}`;
  });
  const importantLabels = new Set(activities.flatMap((activity, index) => activity.status !== "completed" ? [labels[index]] : []));
  const unique = new Map<string, { activity: PanelActivity; index: number }>();
  activities.forEach((activity, index) => {
    if (activity.status === "completed" && importantLabels.has(labels[index])) return;
    // Separate live/failed invocations remain navigable even when labels match.
    const key = activity.status === "completed" ? `completed:${labels[index]}` : `source:${activity.messageId}:${activity.id}`;
    unique.set(key, { activity, index });
  });
  const rank = (activity: PanelActivity) => activity.status === "running" || activity.status === "pending" ? 0 : activity.status === "failed" ? 1 : 2;
  return [...unique.values()].sort((a, b) => rank(a.activity) - rank(b.activity) || b.index - a.index)
    .slice(0, count).sort((a, b) => a.index - b.index).map(({ activity }) => activity);
}

export function panelRelativeTime(value: string, language: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  if (seconds < 60) return formatter.format(0, "second");
  if (seconds < 3600) return formatter.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return formatter.format(-Math.floor(seconds / 3600), "hour");
  return formatter.format(-Math.floor(seconds / 86400), "day");
}
