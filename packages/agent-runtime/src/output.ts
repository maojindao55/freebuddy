export const EMPTY_AGENT_OUTPUT_ERROR =
  "Agent returned no output. Check the API service status and retry.";

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
