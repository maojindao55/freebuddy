import type { CliStreamItem } from "@/services/cli/parsers";
import type { CLIMember } from "@/config/aiMembers";

type ToolResultItem = Extract<CliStreamItem, { kind: "tool-result" }>;
type CommandItem = Extract<CliStreamItem, { kind: "command" }>;

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

export function appendItems(
  prev: CliStreamItem[],
  next: CliStreamItem[]
): CliStreamItem[] {
  if (!next.length) return prev;
  const out = [...prev];
  for (const item of next) {
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
