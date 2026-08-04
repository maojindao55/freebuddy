import {
  extractReviewStatus,
  extractVisibleStepOutput,
  WORKFLOW_CONSUMED_STEP_MAX_CHARS
} from "./workflowScheduler.js";

export const WORKFLOW_STEP_CONTEXT_SUMMARY_MAX_CHARS = 6_000;
export const WORKFLOW_STEP_CONTEXT_SUMMARY_UNAVAILABLE =
  "WORKFLOW_CONTEXT_SUMMARY_UNAVAILABLE";

export const WORKFLOW_STEP_CONTEXT_SUMMARY_PROMPT = `You just completed a workflow step.

Do not continue the task, call tools, or modify files. Produce a compact handoff
for the next workflow agent using only facts from this session.

Use exactly these section headings:
WORKFLOW_CONTEXT_SUMMARY
STEP_OUTCOME
KEY_DECISIONS
ARTIFACTS
COMMANDS_AND_TESTS
EVIDENCE
ERRORS_AND_RISKS
UNRESOLVED
WORKFLOW_STATUS

Preserve file paths, commands, test results, errors, REVIEW_STATUS markers,
UNRESOLVED counts, and exit status exactly. Remove repeated logs, progress
chatter, hidden reasoning, and redundant explanation. Do not invent work or
claim that an unfinished item is complete.

Keep the entire response under ${WORKFLOW_STEP_CONTEXT_SUMMARY_MAX_CHARS} characters.
If the current session does not contain the completed step, reply with exactly:
${WORKFLOW_STEP_CONTEXT_SUMMARY_UNAVAILABLE}`;

interface WorkflowStepResultPayload {
  items?: unknown[];
  contextSummary?: unknown;
}

function parseWorkflowStepResult(
  resultJson: string | undefined
): WorkflowStepResultPayload | undefined {
  if (!resultJson) return undefined;
  try {
    return JSON.parse(resultJson) as WorkflowStepResultPayload;
  } catch {
    return undefined;
  }
}

function storedContextSummaryFromPayload(
  payload: WorkflowStepResultPayload | undefined
): string | undefined {
  if (typeof payload?.contextSummary !== "string") return undefined;
  return normalizeWorkflowStepContextSummary(
    payload.contextSummary,
    payload.contextSummary
  );
}

function lastUnresolvedMarker(text: string): string | undefined {
  return [...text.matchAll(/UNRESOLVED:\s*\d+/gi)].at(-1)?.[0];
}

function applyAuthoritativeWorkflowMarkers(
  summary: string,
  decisionText: string
): string {
  const reviewStatus = extractReviewStatus(decisionText);
  const unresolved = lastUnresolvedMarker(decisionText);
  let normalized = summary
    .replace(/REVIEW[\s_-]*STATUS\s*:\s*(PASS|FAIL)/gi, "")
    .replace(/<<<REVIEW_(PASS|FAIL)>>>/gi, "")
    .replace(/\[\[REVIEW:(PASS|FAIL)\]\]/gi, "")
    .replace(/UNRESOLVED:\s*\d+/gi, "")
    .trim();
  const markers = [
    reviewStatus ? `REVIEW_STATUS: ${reviewStatus}` : undefined,
    unresolved
  ].filter((value): value is string => Boolean(value));
  if (markers.length > 0) {
    normalized = `${normalized}\n${markers.join("\n")}`;
  }
  return normalized;
}

export function shouldCompressWorkflowStepOutput(output: string): boolean {
  return output.trim().length > WORKFLOW_CONSUMED_STEP_MAX_CHARS;
}

export function normalizeWorkflowStepContextSummary(
  summary: string,
  decisionText: string
): string | undefined {
  const trimmed = summary.trim();
  if (
    !trimmed ||
    trimmed.includes(WORKFLOW_STEP_CONTEXT_SUMMARY_UNAVAILABLE) ||
    !/^WORKFLOW_CONTEXT_SUMMARY\b/m.test(trimmed)
  ) {
    return undefined;
  }
  const normalized = applyAuthoritativeWorkflowMarkers(trimmed, decisionText);
  return normalized.length <= WORKFLOW_STEP_CONTEXT_SUMMARY_MAX_CHARS
    ? normalized
    : undefined;
}

/**
 * A bounded handoff used only when the same-session summary turn cannot be
 * trusted (for example, it times out or asks to use a tool). The original raw
 * output stays in resultJson; downstream workflow prompts receive this compact
 * fallback instead of a head/tail slice of that raw output.
 */
export function fallbackWorkflowStepContextSummary(
  compactSummary: string,
  decisionText: string
): string | undefined {
  return normalizeWorkflowStepContextSummary(
    [
      "WORKFLOW_CONTEXT_SUMMARY",
      "STEP_OUTCOME",
      compactSummary.trim(),
      "WORKFLOW_STATUS",
      "Same-session compression was unavailable; use the stored raw step output only for audit."
    ].join("\n"),
    decisionText
  );
}

export function storedWorkflowStepContextSummary(
  resultJson: string | undefined
): string | undefined {
  return storedContextSummaryFromPayload(parseWorkflowStepResult(resultJson));
}

export function selectWorkflowStepConsumedContext(
  resultJson: string | undefined,
  fallbackSummary: string | undefined
): string | undefined {
  const parsed = parseWorkflowStepResult(resultJson);
  if (!parsed) return fallbackSummary?.trim() || undefined;
  const compressed = storedContextSummaryFromPayload(parsed);
  if (compressed) return compressed;
  const output = extractVisibleStepOutput(parsed.items ?? []).trim();
  if (output && !shouldCompressWorkflowStepOutput(output)) return output;
  return fallbackSummary?.trim() || undefined;
}
