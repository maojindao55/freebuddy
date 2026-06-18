import type { CliStreamItem } from "@/services/cli/parsers";
import type { CLIMember } from "@/config/aiMembers";

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
