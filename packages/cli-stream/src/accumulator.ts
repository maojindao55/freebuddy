import type { CliStreamItem } from "@freebuddy/protocol/cli";

type ToolResultItem = Extract<CliStreamItem, { kind: "tool-result" }>;
type CommandItem = Extract<CliStreamItem, { kind: "command" }>;
type PlanItem = Extract<CliStreamItem, { kind: "plan" }>;
type PlanEntry = PlanItem["entries"][number];
type ToolCallItem = Extract<CliStreamItem, { kind: "tool-call" }>;

export const MAX_MERGED_ASSISTANT_CHARS = 200_000;
export const MAX_MERGED_OUTPUT_CHARS = 12_000;
const MERGED_STREAM_TRUNCATION_MARKER = "\n… [stream truncated] …\n";

function boundMergedStreamText(value: string, max: number): string {
  if (value.length <= max) return value;
  const available = Math.max(0, max - MERGED_STREAM_TRUNCATION_MARKER.length);
  const headLength = Math.floor(available * 0.6);
  const tailLength = available - headLength;
  return (
    value.slice(0, headLength) +
    MERGED_STREAM_TRUNCATION_MARKER +
    value.slice(-tailLength)
  );
}

function appendBoundedStreamText(
  current: string,
  addition: string,
  max: number
): string {
  if (current.length + addition.length <= max) return current + addition;

  const markerIndex = current.indexOf(MERGED_STREAM_TRUNCATION_MARKER);
  if (markerIndex < 0) {
    return boundMergedStreamText(current + addition, max);
  }

  const available = Math.max(0, max - MERGED_STREAM_TRUNCATION_MARKER.length);
  const headLength = Math.floor(available * 0.6);
  const tailLength = available - headLength;
  const head = current.slice(0, markerIndex).slice(0, headLength);
  const previousTail = current.slice(
    markerIndex + MERGED_STREAM_TRUNCATION_MARKER.length
  );
  return (
    head +
    MERGED_STREAM_TRUNCATION_MARKER +
    (previousTail + addition).slice(-tailLength)
  );
}

function mergeStreamText(
  previous: Extract<CliStreamItem, { kind: "text" }>,
  next: Extract<CliStreamItem, { kind: "text" }>
): Extract<CliStreamItem, { kind: "text" }> {
  if (next.append) {
    return {
      ...previous,
      content: appendBoundedStreamText(
        previous.content,
        next.content,
        MAX_MERGED_ASSISTANT_CHARS
      )
    };
  }
  if (next.content === previous.content) return previous;
  if (next.content.startsWith(previous.content)) {
    return {
      ...previous,
      content: boundMergedStreamText(
        next.content,
        MAX_MERGED_ASSISTANT_CHARS
      )
    };
  }
  return {
    ...previous,
    ...next,
    content: boundMergedStreamText(next.content, MAX_MERGED_ASSISTANT_CHARS)
  };
}

function mergeStreamThinking(
  previous: Extract<CliStreamItem, { kind: "thinking" }>,
  next: Extract<CliStreamItem, { kind: "thinking" }>
): Extract<CliStreamItem, { kind: "thinking" }> {
  if (next.append) {
    return {
      ...previous,
      content: appendBoundedStreamText(
        previous.content,
        next.content,
        MAX_MERGED_ASSISTANT_CHARS
      )
    };
  }
  if (next.content === previous.content) return previous;
  if (next.content.startsWith(previous.content)) {
    return {
      ...previous,
      content: boundMergedStreamText(
        next.content,
        MAX_MERGED_ASSISTANT_CHARS
      )
    };
  }
  return {
    ...previous,
    ...next,
    content: boundMergedStreamText(next.content, MAX_MERGED_ASSISTANT_CHARS)
  };
}

export function mergeToolCalls(
  previous: ToolCallItem,
  next: ToolCallItem
): ToolCallItem {
  const merged: ToolCallItem = {
    kind: "tool-call",
    id: previous.id!,
    tool: next.tool || previous.tool
  };

  const input = next.input !== undefined ? next.input : previous.input;
  if (input !== undefined) merged.input = input;

  const status = next.status ?? previous.status;
  if (status !== undefined) merged.status = status;

  const toolKind = next.toolKind ?? previous.toolKind;
  if (toolKind !== undefined) merged.toolKind = toolKind;

  const locations = next.locations ?? previous.locations;
  if (locations !== undefined) merged.locations = locations;

  const output = next.output !== undefined ? next.output : previous.output;
  if (output !== undefined) merged.output = output;

  const isError = next.isError ?? previous.isError;
  if (isError !== undefined) merged.isError = isError;

  if (next.toolOutputs) {
    merged.toolOutputs = next.replaceToolOutputs
      ? next.toolOutputs
      : [...(previous.toolOutputs ?? []), ...next.toolOutputs];
  } else if (previous.toolOutputs) {
    merged.toolOutputs = previous.toolOutputs;
  }

  return merged;
}

function toolResultKey(item: ToolResultItem): string {
  return `${item.tool}\u0000${item.content.trim()}`;
}

export function dedupeToolResults(results: ToolResultItem[]): ToolResultItem[] {
  const seen = new Set<string>();
  const output: ToolResultItem[] = [];

  for (const result of results) {
    if (!result.content.trim()) {
      output.push(result);
      continue;
    }
    const key = toolResultKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(result);
  }

  return output;
}

export function dedupeCommands(commands: CommandItem[]): CommandItem[] {
  const seen = new Set<string>();
  const output: CommandItem[] = [];

  for (const command of commands) {
    const key = command.command.trim();
    if (!key) {
      output.push(command);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(command);
  }

  return output;
}

function planPriority(value: unknown): PlanEntry["priority"] {
  return value === "high" || value === "low" ? value : "medium";
}

function planStatus(value: unknown): PlanEntry["status"] {
  return value === "in_progress" ||
    value === "completed" ||
    value === "cancelled"
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

function coalesceIncomingItems(items: CliStreamItem[]): CliStreamItem[] {
  const output: CliStreamItem[] = [];
  for (const item of items) {
    const last = output[output.length - 1];
    if (
      item.kind === "text" &&
      item.append &&
      last?.kind === "text" &&
      last.role === item.role &&
      last.messageId === item.messageId
    ) {
      output[output.length - 1] = {
        ...last,
        content: appendBoundedStreamText(
          last.content,
          item.content,
          MAX_MERGED_ASSISTANT_CHARS
        )
      };
      continue;
    }
    if (
      item.kind === "thinking" &&
      item.append &&
      last?.kind === "thinking" &&
      last.messageId === item.messageId
    ) {
      output[output.length - 1] = {
        ...last,
        content: appendBoundedStreamText(
          last.content,
          item.content,
          MAX_MERGED_ASSISTANT_CHARS
        )
      };
      continue;
    }
    if (
      item.kind === "command-output" &&
      last?.kind === "command-output" &&
      last.stream === item.stream
    ) {
      output[output.length - 1] = {
        ...last,
        content: appendBoundedStreamText(
          last.content,
          `\n${item.content}`,
          MAX_MERGED_OUTPUT_CHARS
        )
      };
      continue;
    }
    output.push(item);
  }
  return output;
}

export function appendItems(
  previous: CliStreamItem[],
  next: CliStreamItem[]
): CliStreamItem[] {
  if (!next.length) return previous;
  const output = [...previous];
  for (const rawItem of coalesceIncomingItems(next)) {
    const item = legacyTodoPlan(rawItem) ?? rawItem;
    const last = output[output.length - 1];
    if (item.kind === "text" && item.messageId) {
      const index = output.findIndex(
        (existing) =>
          existing.kind === "text" &&
          existing.messageId === item.messageId &&
          existing.role === item.role
      );
      if (index >= 0) {
        const existing = output[index] as Extract<CliStreamItem, { kind: "text" }>;
        output[index] = mergeStreamText(existing, item);
        continue;
      }
    }
    if (item.kind === "thinking" && item.messageId) {
      const index = output.findIndex(
        (existing) =>
          existing.kind === "thinking" && existing.messageId === item.messageId
      );
      if (index >= 0) {
        const existing = output[index] as Extract<CliStreamItem, { kind: "thinking" }>;
        output[index] = mergeStreamThinking(existing, item);
        continue;
      }
    }
    if (item.kind === "terminal-embed") {
      const index = output.findIndex(
        (existing) =>
          existing.kind === "terminal-embed" &&
          existing.terminalId === item.terminalId
      );
      if (index >= 0) {
        output[index] = { ...output[index], ...item };
        continue;
      }
    }
    if (
      item.kind === "text" &&
      last?.kind === "text" &&
      last.role === item.role
    ) {
      if (item.append) {
        output[output.length - 1] = {
          ...last,
          content: appendBoundedStreamText(
            last.content,
            item.content,
            MAX_MERGED_ASSISTANT_CHARS
          )
        };
        continue;
      }
      if (item.content === last.content) continue;
      if (item.content.startsWith(last.content)) {
        output[output.length - 1] = {
          ...last,
          content: boundMergedStreamText(
            item.content,
            MAX_MERGED_ASSISTANT_CHARS
          )
        };
        continue;
      }
    }
    if (item.kind === "thinking" && last?.kind === "thinking") {
      if (item.append) {
        output[output.length - 1] = {
          ...last,
          content: appendBoundedStreamText(
            last.content,
            item.content,
            MAX_MERGED_ASSISTANT_CHARS
          )
        };
        continue;
      }
      if (item.content === last.content) continue;
      if (item.content.startsWith(last.content)) {
        output[output.length - 1] = {
          ...last,
          content: boundMergedStreamText(
            item.content,
            MAX_MERGED_ASSISTANT_CHARS
          )
        };
        continue;
      }
    }
    if (
      item.kind === "error" &&
      last?.kind === "error" &&
      last.message === item.message
    ) {
      continue;
    }
    if (item.kind === "plan") {
      const planIndex = output.findIndex((existing) => existing.kind === "plan");
      if (planIndex >= 0) {
        output[planIndex] = item;
        continue;
      }
    }
    if (item.kind === "session") {
      const index = output.findIndex((existing) => existing.kind === "session");
      if (index >= 0) {
        output[index] = item;
        continue;
      }
    }
    if (item.kind === "available-commands") {
      const index = output.findIndex(
        (existing) => existing.kind === "available-commands"
      );
      if (index >= 0) {
        output[index] = item;
        continue;
      }
    }
    if (item.kind === "config-options") {
      const index = output.findIndex(
        (existing) => existing.kind === "config-options"
      );
      if (index >= 0) {
        output[index] = item;
        continue;
      }
    }
    if (item.kind === "tool-call" && item.id) {
      const toolIndex = output.findIndex(
        (existing) => existing.kind === "tool-call" && existing.id === item.id
      );
      if (toolIndex >= 0) {
        output[toolIndex] = mergeToolCalls(
          output[toolIndex] as ToolCallItem,
          item
        );
        continue;
      }
    }
    if (
      item.kind === "command-output" &&
      last?.kind === "command-output" &&
      last.stream === item.stream
    ) {
      output[output.length - 1] = {
        ...last,
        content: appendBoundedStreamText(
          last.content,
          `\n${item.content}`,
          MAX_MERGED_OUTPUT_CHARS
        )
      };
      continue;
    }
    if (item.kind === "command" && item.command.trim()) {
      const trailingCommands: CommandItem[] = [];
      for (let index = output.length - 1; index >= 0; index -= 1) {
        const existing = output[index];
        if (existing.kind === "tool-call") break;
        if (existing.kind !== "command") break;
        trailingCommands.unshift(existing);
      }
      if (dedupeCommands([...trailingCommands, item]).length === trailingCommands.length) {
        continue;
      }
    }
    if (
      item.kind === "tool-result" &&
      last?.kind === "tool-result" &&
      last.tool === item.tool &&
      ((last.id && item.id && last.id === item.id) || (!last.id && !item.id))
    ) {
      if (!item.content.trim() && last.content.trim()) continue;
      if (item.content === last.content) continue;
      output[output.length - 1] = {
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
      for (let index = output.length - 1; index >= 0; index -= 1) {
        const existing = output[index];
        if (existing.kind === "tool-call") break;
        if (existing.kind !== "tool-result") break;
        trailingResults.unshift(existing);
      }
      if (dedupeToolResults([...trailingResults, item]).length === trailingResults.length) {
        continue;
      }
    }
    output.push(item);
  }
  return output;
}

export function plainAssistantText(items: CliStreamItem[]): string {
  return items
    .filter((item) => item.kind === "text" && item.role === "assistant")
    .map((item) => (item as Extract<CliStreamItem, { kind: "text" }>).content)
    .join("\n")
    .trim();
}
