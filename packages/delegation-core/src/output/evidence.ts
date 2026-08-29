const MAX_SUMMARY_CHARS = 12_000;
const MAX_DIAGNOSTIC_CHARS = 800;

export interface DelegationOutputEvidence {
  summary: string;
  hasAssistantText: boolean;
  hasArtifactOutput: boolean;
  hasOutput: boolean;
  toolError: string | null;
}

function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n…[truncated]…\n${text.slice(text.length - half)}`;
}

function toolErrorText(item: Record<string, unknown>): string | null {
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

/**
 * Inspect a streamed agent turn for user-visible output. Tool activity alone is
 * deliberately not output: reads, searches, and failed calls cannot prove the
 * requested work was completed.
 */
export function analyzeDelegationOutput(items: unknown[]): DelegationOutputEvidence {
  const texts: string[] = [];
  let hasArtifactOutput = false;
  let toolError: string | null = null;

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
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
      if (Array.isArray(item.toolOutputs)) {
        const nested = analyzeDelegationOutput(item.toolOutputs);
        toolError = toolError ?? nested.toolError;
        hasArtifactOutput = hasArtifactOutput || nested.hasArtifactOutput;
      }
      const isSuccessfulMutation =
        (item.toolKind === "edit" || item.toolKind === "delete" || item.toolKind === "move") &&
        item.isError !== true &&
        item.status === "completed";
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
