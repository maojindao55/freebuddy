import type { CliStreamItem } from "@/services/cli/parsers";
import { appendItems } from "@/store/conversationUtils";

export function isVisibleItem(item: CliStreamItem, hideDiagnosticStderr = false) {
  if (
    hideDiagnosticStderr &&
    item.kind === "command-output" &&
    item.stream === "stderr"
  ) {
    return false;
  }
  return (
    item.kind !== "session" &&
    item.kind !== "usage" &&
    item.kind !== "plan" &&
    item.kind !== "available-commands" &&
    item.kind !== "config-options"
  );
}

export type VisibleBlock =
  | { kind: "single"; item: CliStreamItem }
  | {
      kind: "tool";
      call: Extract<CliStreamItem, { kind: "tool-call" }>;
      results: Extract<CliStreamItem, { kind: "tool-result" }>[];
      commands: Extract<CliStreamItem, { kind: "command" }>[];
      extras: CliStreamItem[];
    };

function sameToolInvocation(
  call: Extract<CliStreamItem, { kind: "tool-call" }>,
  result: Extract<CliStreamItem, { kind: "tool-result" }>
) {
  if (call.id || result.id) return call.id === result.id;
  return true;
}

function syntheticToolResult(
  call: Extract<CliStreamItem, { kind: "tool-call" }>
): Extract<CliStreamItem, { kind: "tool-result" }> | undefined {
  if (call.output === undefined) return undefined;
  return {
    kind: "tool-result",
    id: call.id,
    tool: call.tool,
    content: call.output,
    ...(call.isError ? { isError: true } : {})
  };
}

export function visibleBlocks(items: CliStreamItem[]): VisibleBlock[] {
  const blocks: VisibleBlock[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind !== "tool-call") {
      blocks.push({ kind: "single", item });
      continue;
    }

    const results: Extract<CliStreamItem, { kind: "tool-result" }>[] = [];
    const commands: Extract<CliStreamItem, { kind: "command" }>[] = [];
    const synthetic = syntheticToolResult(item);
    if (synthetic) results.push(synthetic);

    let cursor = i + 1;
    while (cursor < items.length) {
      const next = items[cursor];
      if (next.kind !== "tool-result" && next.kind !== "command") break;
      if (next.kind === "tool-result") {
        if (!sameToolInvocation(item, next)) break;
        results.push(next);
      } else {
        commands.push(next);
      }
      cursor += 1;
    }
    blocks.push({
      kind: "tool",
      call: item,
      results,
      commands,
      extras: item.toolOutputs ?? []
    });
    i = cursor - 1;
  }

  return blocks;
}

function normalizeLight(items: CliStreamItem[]): CliStreamItem[] {
  let out: CliStreamItem[] = [];
  for (const item of items) {
    out = appendItems(out, [item]);
  }
  return out;
}

export function computeMessageBlocks(messageContent: string): VisibleBlock[] {
  try {
    const parsed = JSON.parse(messageContent);
    const base = Array.isArray(parsed)
      ? (parsed as CliStreamItem[])
      : [{ kind: "raw", content: messageContent } satisfies CliStreamItem];
    const items = normalizeLight(base);
    const hideDiagnosticStderr = items.some(
      (item) => item.kind === "error" && Boolean(item.details?.length)
    );
    const visible = items.filter((item) =>
      isVisibleItem(item, hideDiagnosticStderr)
    );
    return visibleBlocks(visible);
  } catch {
    return [{ kind: "single", item: { kind: "raw", content: messageContent } }];
  }
}

export function countVisibleBlocks(messageContent: string): number {
  return computeMessageBlocks(messageContent).length;
}
