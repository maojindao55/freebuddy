export const EMPTY_AGENT_OUTPUT_ERROR =
  "Agent returned no output. Check the API service status and retry.";

const MAX_SUMMARY_CHARS = 12_000;
const MAX_DIAGNOSTIC_CHARS = 800;

export interface AgentOutputEvidence {
  summary: string;
  hasAssistantText: boolean;
  hasArtifactOutput: boolean;
  hasOutput: boolean;
  toolError: string | null;
}

type StreamItem = Record<string, unknown>;

function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n…[truncated]…\n${text.slice(text.length - half)}`;
}

function toolErrorText(item: StreamItem): string | null {
  if (item.isError !== true && item.status !== "failed") return null;
  const candidates = [item.output, item.content];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return boundText(value.trim(), MAX_DIAGNOSTIC_CHARS);
    }
  }
  const tool = typeof item.tool === "string" && item.tool.trim() ? item.tool.trim() : "tool";
  return `${tool} failed`;
}

function toolCallId(item: StreamItem): string | undefined {
  for (const candidate of [item.id, item.toolCallId, item.callId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function mergeToolCall(prev: StreamItem, next: StreamItem): StreamItem {
  const merged: StreamItem = { ...prev, ...next };
  if (Array.isArray(next.toolOutputs)) {
    merged.toolOutputs =
      next.replaceToolOutputs === true
        ? next.toolOutputs
        : [...(Array.isArray(prev.toolOutputs) ? prev.toolOutputs : []), ...next.toolOutputs];
  } else if (Array.isArray(prev.toolOutputs)) {
    merged.toolOutputs = prev.toolOutputs;
  }
  if (next.isError === undefined && next.status === "completed") {
    merged.isError = false;
  }
  return merged;
}

/**
 * ACP and other streaming adapters can emit several snapshots for one tool
 * call. Evidence must use the final status, while retaining outputs delivered
 * by earlier snapshots of that same call.
 */
function coalesceToolCalls(items: unknown[]): unknown[] {
  const coalesced: unknown[] = [];
  const indexById = new Map<string, number>();
  for (const raw of items) {
    if (!raw || typeof raw !== "object") {
      coalesced.push(raw);
      continue;
    }
    const item = raw as StreamItem;
    if (item.kind !== "tool-call") {
      coalesced.push(raw);
      continue;
    }
    const id = toolCallId(item);
    if (!id) {
      coalesced.push(raw);
      continue;
    }
    const existingIndex = indexById.get(id);
    if (existingIndex === undefined) {
      indexById.set(id, coalesced.length);
      coalesced.push(item);
      continue;
    }
    coalesced[existingIndex] = mergeToolCall(
      coalesced[existingIndex] as StreamItem,
      item
    );
  }
  return coalesced;
}

/**
 * Inspect a streamed turn for assistant-visible text, durable artifacts and
 * final tool failures. Reads/searches and unfinished or failed mutations do
 * not prove that requested work completed.
 */
export function analyzeAgentOutput(items: unknown[]): AgentOutputEvidence {
  const texts: string[] = [];
  let hasArtifactOutput = false;
  let toolError: string | null = null;

  for (const raw of coalesceToolCalls(items)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as StreamItem;
    if (
      item.kind === "text" &&
      item.role === "assistant" &&
      typeof item.content === "string"
    ) {
      texts.push(item.content);
      continue;
    }
    if (item.kind === "file-edit") {
      hasArtifactOutput = true;
      continue;
    }
    if (
      item.kind === "content-block" &&
      (item.blockType === "image" ||
        item.blockType === "audio" ||
        item.blockType === "resource_link" ||
        item.blockType === "resource")
    ) {
      hasArtifactOutput = true;
      continue;
    }
    if (item.kind === "tool-call") {
      toolError = toolError ?? toolErrorText(item);
      const succeeded = item.status === "completed" && item.isError !== true;
      if (Array.isArray(item.toolOutputs)) {
        const nested = analyzeAgentOutput(item.toolOutputs);
        toolError = toolError ?? nested.toolError;
        if (succeeded) {
          hasArtifactOutput = hasArtifactOutput || nested.hasArtifactOutput;
        }
      }
      const isSuccessfulMutation =
        (item.toolKind === "edit" || item.toolKind === "delete" || item.toolKind === "move") &&
        succeeded;
      if (isSuccessfulMutation) hasArtifactOutput = true;
      continue;
    }
    if (item.kind === "tool-result") {
      toolError = toolError ?? toolErrorText(item);
    }
  }

  const assistantText = texts.join("").trim();
  const hasAssistantText = assistantText.length > 0;
  const hasOutput = hasAssistantText || hasArtifactOutput;
  return {
    summary: hasAssistantText
      ? boundText(assistantText, MAX_SUMMARY_CHARS)
      : hasArtifactOutput
        ? "Produced artifact output."
        : "(no assistant response or artifact)",
    hasAssistantText,
    hasArtifactOutput,
    hasOutput,
    toolError
  };
}

/**
 * A successful team turn must produce either assistant-visible text or an
 * observable tool action. Hidden reasoning and echoed user/system prompts do
 * not count as output.
 */
export function hasMeaningfulAgentOutput(items: unknown[]): boolean {
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as {
      kind?: unknown;
      role?: unknown;
      content?: unknown;
      text?: unknown;
    };
    if (item.kind === "text") {
      if (item.role === "user" || item.role === "system") continue;
      const text =
        typeof item.content === "string"
          ? item.content
          : typeof item.text === "string"
            ? item.text
            : "";
      if (text.trim()) return true;
      continue;
    }
    if (
      item.kind === "tool-call" ||
      item.kind === "tool-result" ||
      item.kind === "command" ||
      item.kind === "command-output" ||
      item.kind === "file-edit" ||
      item.kind === "terminal-embed"
    ) {
      return true;
    }
  }
  return false;
}

/** Preserve the adapter's exact error, then cover silent/non-zero completions. */
export function resolveAgentRunError(
  items: unknown[],
  error: string | null,
  exitCode: number | null
): string | null {
  if (error?.trim()) return error;
  if (exitCode !== null && exitCode !== 0) {
    return `Agent exited with code ${exitCode}.`;
  }
  return hasMeaningfulAgentOutput(items) ? null : EMPTY_AGENT_OUTPUT_ERROR;
}
