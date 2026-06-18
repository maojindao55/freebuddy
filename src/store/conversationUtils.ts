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
      item.append &&
      last &&
      last.kind === "text" &&
      last.role === item.role
    ) {
      out[out.length - 1] = { ...last, content: last.content + item.content };
      continue;
    }
    if (
      item.kind === "thinking" &&
      item.append &&
      last &&
      last.kind === "thinking"
    ) {
      out[out.length - 1] = { ...last, content: last.content + item.content };
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
