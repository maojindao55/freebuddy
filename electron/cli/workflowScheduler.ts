import type {
  WorkflowGate,
  WorkflowPlan,
  WorkflowStepStatus
} from "./workflowTypes.js";

export interface StepState {
  stepId: string;
  status?: WorkflowStepStatus;
}

export interface SchedulerContext {
  /** True if a write step is currently running anywhere in the run. */
  writeBusy: boolean;
  /** True once the user has explicitly approved a write step or phase. */
  writeApproved?: boolean;
}

export interface RunnableSelection {
  phaseId: string;
  stepId: string;
}

const TERMINAL_OK: ReadonlySet<WorkflowStepStatus> = new Set(["done", "skipped"]);

function isTerminalOk(status?: WorkflowStepStatus): boolean {
  return status !== undefined && TERMINAL_OK.has(status);
}

/**
 * Select steps that may start now. Phases run sequentially; only the first
 * phase that still has unfinished work is considered. Within that phase we fill
 * remaining parallelism slots, honoring step dependencies and the global
 * one-write-at-a-time rule.
 */
export function selectRunnableSteps(
  plan: WorkflowPlan,
  states: StepState[],
  ctx: SchedulerContext
): RunnableSelection[] {
  const statusById = new Map<string, WorkflowStepStatus | undefined>();
  for (const s of states) statusById.set(s.stepId, s.status);

  const result: RunnableSelection[] = [];
  let writeStarted = ctx.writeBusy;

  for (const phase of plan.phases) {
    const statuses = phase.steps.map((s) => statusById.get(s.id));
    const phaseFinished = statuses.every((st) => isTerminalOk(st));
    if (phaseFinished) continue; // move to next phase

    const runningInPhase = statuses.filter((st) => st === "running").length;
    let slots = Math.max(0, (phase.parallelism ?? 1) - runningInPhase);

    for (const step of phase.steps) {
      if (slots <= 0) break;
      const status = statusById.get(step.id);
      // Already-scheduled steps (anything other than absent/pending) are not candidates.
      if (status !== undefined && status !== "pending") continue;
      const depsOk = (step.dependsOn || []).every((dep) =>
        isTerminalOk(statusById.get(dep))
      );
      if (!depsOk) continue;
      if (step.mode === "write" && (!ctx.writeApproved || writeStarted)) continue;
      result.push({ phaseId: phase.id, stepId: step.id });
      slots -= 1;
      if (step.mode === "write") {
        // A write step takes the floor for this selection pass; the orchestrator
        // will re-evaluate (with writeBusy=true) after it starts.
        writeStarted = true;
        break;
      }
    }
    return result; // only the first unfinished phase
  }

  return result;
}

export interface GateEvaluation {
  pass: boolean;
  pause: boolean;
  reason?: string;
}

/**
 * Evaluate a phase gate once all of a phase's steps are terminal.
 * Called by the runtime before advancing to the next phase.
 */
export function phaseGateSatisfied(
  gate: WorkflowGate | undefined,
  ctx: {
    approvedPhases: ReadonlySet<string>;
    phaseId: string;
    reviewerStepStatus?: WorkflowStepStatus;
  }
): GateEvaluation {
  if (!gate) return { pass: true, pause: false };
  if (gate.type === "all_done") return { pass: true, pause: false };
  if (gate.type === "manual_approval") {
    if (ctx.approvedPhases.has(ctx.phaseId)) {
      return { pass: true, pause: false };
    }
    return { pass: false, pause: true, reason: gate.reason };
  }
  // review_required
  return {
    pass: ctx.reviewerStepStatus === "done",
    pause: ctx.reviewerStepStatus !== "done"
  };
}

/**
 * Decide the Review Loop outcome after the verifier step completes.
 */
export function decideReviewLoop(
  verifierStatus: WorkflowStepStatus | undefined,
  verifierFoundUnresolved: boolean,
  loopIndex: number,
  maxLoops: number
): "loop" | "finish" | "partial" {
  if (verifierStatus !== "done") return "partial";
  if (!verifierFoundUnresolved) return "finish";
  if (loopIndex + 1 < maxLoops) return "loop";
  return "partial";
}

/**
 * Extract a concise summary from the final assistant stream items of a step.
 * Concatenates all text chunks and preserves workflow control markers
 * (REVIEW_STATUS / UNRESOLVED) even when the body is truncated.
 */
export function deriveStepSummary(items: unknown[]): string {
  const fullText = collectAllTextFromItems(items);
  let toolCount = 0;
  for (const raw of items) {
    const item = raw as { kind?: string };
    if (!item || typeof item !== "object") continue;
    if (item.kind === "tool-call" || item.kind === "tool-result") {
      toolCount += 1;
    }
  }
  const trimmed = fullText.trim();
  if (trimmed) return compactStepSummary(trimmed);
  if (toolCount > 0) {
    return `Completed ${toolCount} tool action${toolCount === 1 ? "" : "s"}.`;
  }
  return "Step completed.";
}

/** Join every assistant text chunk in order (ACP may split long replies). */
export function collectAllTextFromItems(items: unknown[]): string {
  const parts: string[] = [];
  for (const raw of items) {
    const item = raw as { kind?: string; content?: string };
    if (!item || typeof item !== "object") continue;
    if (item.kind === "text" && typeof item.content === "string") {
      const piece = item.content.trim();
      if (piece) parts.push(piece);
    }
  }
  return parts.join("\n");
}

/** Prefer full stream text from resultJson when deciding loop outcomes. */
export function resolveReviewDecisionText(
  summary: string | undefined,
  resultJson: string | undefined
): string | undefined {
  if (resultJson) {
    try {
      const parsed = JSON.parse(resultJson) as { items?: unknown[] };
      const full = collectAllTextFromItems(parsed.items ?? []).trim();
      if (full) return full;
    } catch {
      /* fall through to summary */
    }
  }
  return summary;
}

function compactStepSummary(text: string, maxLen = 400): string {
  const reviewMarker = [...text.matchAll(/REVIEW_STATUS:\s*(?:PASS|FAIL)/gi)]
    .at(-1)?.[0];
  const unresolvedMarker = text.match(/UNRESOLVED:\s*\d+/i)?.[0];
  const markers = [reviewMarker, unresolvedMarker].filter(Boolean) as string[];
  if (text.length <= maxLen) return text;
  if (markers.length === 0) return text.slice(0, maxLen);
  const markerBlock = markers.join("\n");
  const budget = Math.max(80, maxLen - markerBlock.length - 2);
  return `${text.slice(0, budget).trimEnd()}\n…\n${markerBlock}`;
}

export function extractReviewStatus(
  text: string | undefined
): "PASS" | "FAIL" | undefined {
  if (!text) return undefined;
  const matches = [...text.matchAll(/REVIEW_STATUS:\s*(PASS|FAIL)/gi)];
  const last = matches.at(-1)?.[1];
  if (!last) return undefined;
  return last.toUpperCase() as "PASS" | "FAIL";
}

/** Heuristic: detect "UNRESOLVED: <n>" with n > 0 in a verifier summary. */
export function verifierHasUnresolved(summary: string | undefined): boolean {
  if (!summary) return false;
  const match = summary.match(/UNRESOLVED:\s*(\d+)/i);
  if (match) return Number(match[1]) > 0;
  return false;
}

/** Heuristic: detect REVIEW_STATUS: FAIL in a reviewer summary. */
export function reviewerHasFail(summary: string | undefined): boolean {
  return extractReviewStatus(summary) === "FAIL";
}

/**
 * Decide the Implement-Review Loop outcome after the reviewer step completes.
 */
export function decideImplementReviewLoop(
  reviewerStatus: WorkflowStepStatus | undefined,
  reviewerSummary: string | undefined,
  loopIndex: number,
  maxLoops: number
): "loop" | "finish" | "partial" {
  if (reviewerStatus !== "done") return "partial";
  if (!reviewerHasFail(reviewerSummary)) return "finish";
  if (loopIndex + 1 < maxLoops) return "loop";
  return "partial";
}

export interface ConsumedStepRef {
  stepId: string;
  title: string;
  summary?: string;
}

/** Append upstream step summaries referenced by consumes ids. */
export function augmentPromptWithConsumedSummaries(
  basePrompt: string,
  consumes: string[] | undefined,
  stepsById: Map<string, ConsumedStepRef>
): string {
  if (!consumes?.length) return basePrompt;
  const blocks: string[] = [];
  for (const id of consumes) {
    const ref = stepsById.get(id);
    if (ref?.summary?.trim()) {
      blocks.push(`--- ${ref.title} ---\n${ref.summary.trim()}`);
    }
  }
  if (blocks.length === 0) return basePrompt;
  return `${basePrompt}\n\nContext from prior steps:\n${blocks.join("\n\n")}`;
}
