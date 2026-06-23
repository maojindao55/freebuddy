import type { CliStreamItem } from "@/services/cli/parsers";
import type { CLIMember } from "@/config/aiMembers";

type ToolResultItem = Extract<CliStreamItem, { kind: "tool-result" }>;
type CommandItem = Extract<CliStreamItem, { kind: "command" }>;
type PlanItem = Extract<CliStreamItem, { kind: "plan" }>;
type PlanEntry = PlanItem["entries"][number];
type ToolCallItem = Extract<CliStreamItem, { kind: "tool-call" }>;

export function mergeToolCalls(prev: ToolCallItem, next: ToolCallItem): ToolCallItem {
  const merged: ToolCallItem = {
    kind: "tool-call",
    id: prev.id!,
    tool: next.tool || prev.tool
  };

  const input = next.input !== undefined ? next.input : prev.input;
  if (input !== undefined) merged.input = input;

  const status = next.status ?? prev.status;
  if (status !== undefined) merged.status = status;

  const toolKind = next.toolKind ?? prev.toolKind;
  if (toolKind !== undefined) merged.toolKind = toolKind;

  const locations = next.locations ?? prev.locations;
  if (locations !== undefined) merged.locations = locations;

  const output = next.output !== undefined ? next.output : prev.output;
  if (output !== undefined) merged.output = output;

  const isError = next.isError ?? prev.isError;
  if (isError !== undefined) merged.isError = isError;

  if (next.toolOutputs) {
    merged.toolOutputs = next.replaceToolOutputs
      ? next.toolOutputs
      : [...(prev.toolOutputs ?? []), ...next.toolOutputs];
  } else if (prev.toolOutputs) {
    merged.toolOutputs = prev.toolOutputs;
  }

  return merged;
}

function toolResultKey(item: ToolResultItem) {
  return `${item.tool}\u0000${item.content.trim()}`;
}

export function dedupeToolResults(results: ToolResultItem[]): ToolResultItem[] {
  const seen = new Set<string>();
  const out: ToolResultItem[] = [];

  for (const result of results) {
    if (!result.content.trim()) {
      out.push(result);
      continue;
    }
    const key = toolResultKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }

  return out;
}

export function dedupeCommands(commands: CommandItem[]): CommandItem[] {
  const seen = new Set<string>();
  const out: CommandItem[] = [];

  for (const command of commands) {
    const key = command.command.trim();
    if (!key) {
      out.push(command);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(command);
  }

  return out;
}

function planPriority(value: unknown): PlanEntry["priority"] {
  return value === "high" || value === "low" ? value : "medium";
}

function planStatus(value: unknown): PlanEntry["status"] {
  return value === "in_progress" || value === "completed"
    ? value
    : "pending";
}

function normalizePlanEntries(entries: unknown): PlanEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      const item = entry as {
        content?: unknown;
        priority?: unknown;
        status?: unknown;
      };
      return {
        content: typeof item.content === "string" ? item.content.trim() : "",
        priority: planPriority(item.priority),
        status: planStatus(item.status)
      };
    })
    .filter((entry) => entry.content.length > 0);
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function legacyTodoPlan(item: CliStreamItem): PlanItem | undefined {
  if (item.kind === "tool-call") {
    const input = item.input as { todos?: unknown } | undefined;
    const entries = normalizePlanEntries(input?.todos);
    return entries.length ? { kind: "plan", entries } : undefined;
  }

  if (item.kind === "tool-result") {
    const raw = parseJsonObject(item.content);
    const metadata = raw?.metadata as { todos?: unknown } | undefined;
    const entries = normalizePlanEntries(metadata?.todos ?? raw?.todos);
    return entries.length ? { kind: "plan", entries } : undefined;
  }

  return undefined;
}

export function appendItems(
  prev: CliStreamItem[],
  next: CliStreamItem[]
): CliStreamItem[] {
  if (!next.length) return prev;
  const out = [...prev];
  for (const rawItem of next) {
    const item = legacyTodoPlan(rawItem) ?? rawItem;
    const last = out[out.length - 1];
    if (
      item.kind === "text" &&
      last &&
      last.kind === "text" &&
      last.role === item.role
    ) {
      if (item.append) {
        out[out.length - 1] = { ...last, content: last.content + item.content };
        continue;
      }
      if (item.content === last.content) continue;
      if (item.content.startsWith(last.content)) {
        out[out.length - 1] = { ...last, content: item.content };
        continue;
      }
    }
    if (
      item.kind === "thinking" &&
      last &&
      last.kind === "thinking"
    ) {
      if (item.append) {
        out[out.length - 1] = { ...last, content: last.content + item.content };
        continue;
      }
      if (item.content === last.content) continue;
      if (item.content.startsWith(last.content)) {
        out[out.length - 1] = { ...last, content: item.content };
        continue;
      }
    }
    if (
      item.kind === "error" &&
      last &&
      last.kind === "error" &&
      last.message === item.message
    ) {
      continue;
    }
    if (item.kind === "plan") {
      const planIndex = out.findIndex((previous) => previous.kind === "plan");
      if (planIndex >= 0) {
        out[planIndex] = item;
        continue;
      }
    }
    if (item.kind === "available-commands") {
      const index = out.findIndex((previous) => previous.kind === "available-commands");
      if (index >= 0) {
        out[index] = item;
        continue;
      }
    }
    if (item.kind === "config-options") {
      const index = out.findIndex((previous) => previous.kind === "config-options");
      if (index >= 0) {
        out[index] = item;
        continue;
      }
    }
    if (item.kind === "tool-call" && item.id) {
      const toolIndex = out.findIndex(
        (previous) => previous.kind === "tool-call" && previous.id === item.id
      );
      if (toolIndex >= 0) {
        out[toolIndex] = mergeToolCalls(out[toolIndex] as ToolCallItem, item);
        continue;
      }
    }
    if (
      item.kind === "command-output" &&
      last &&
      last.kind === "command-output" &&
      last.stream === item.stream
    ) {
      out[out.length - 1] = {
        ...last,
        content: `${last.content}\n${item.content}`
      };
      continue;
    }
    if (item.kind === "command" && item.command.trim()) {
      const trailingCommands: CommandItem[] = [];
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const previous = out[i];
        if (previous.kind === "tool-call") break;
        if (previous.kind !== "command") break;
        trailingCommands.unshift(previous);
      }
      if (dedupeCommands([...trailingCommands, item]).length === trailingCommands.length) {
        continue;
      }
    }
    if (
      item.kind === "tool-result" &&
      last &&
      last.kind === "tool-result" &&
      last.tool === item.tool &&
      ((last.id && item.id && last.id === item.id) || (!last.id && !item.id))
    ) {
      if (!item.content.trim() && last.content.trim()) continue;
      if (item.content === last.content) continue;
      out[out.length - 1] = {
        ...last,
        ...item,
        ...(item.isError ?? last.isError
          ? { isError: item.isError ?? last.isError }
          : {})
      };
      continue;
    }
    if (item.kind === "tool-result" && item.content.trim()) {
      const trailingResults: ToolResultItem[] = [];
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const previous = out[i];
        if (previous.kind === "tool-call") break;
        if (previous.kind !== "tool-result") break;
        trailingResults.unshift(previous);
      }
      if (dedupeToolResults([...trailingResults, item]).length === trailingResults.length) {
        continue;
      }
    }
    out.push(item);
  }
  return out;
}

export function plainAssistantText(items: CliStreamItem[]): string {
  return items
    .filter((i) => i.kind === "text" && i.role === "assistant")
    .map((i) => (i as Extract<CliStreamItem, { kind: "text" }>).content)
    .join("\n")
    .trim();
}

export function defaultTitleFor(member: CLIMember, cwd?: string): string {
  const tail = cwd
    ? cwd.split(/[/\\]/).filter(Boolean).slice(-1)[0]
    : undefined;
  return tail ? `${member.name} · ${tail}` : member.name;
}
