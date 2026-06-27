import type {
  WorkflowGate,
  WorkflowPlan,
  WorkflowStepStatus
} from "./workflowTypes.js";

export interface StepState {
  stepId: string;
  phaseId?: string;
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
  const fullText = extractVisibleStepOutput(items);
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

/** Join assistant-visible text used for workflow control markers. */
export function collectDecisionTextFromItems(items: unknown[]): string {
  const normalized = normalizeStreamItemsForDecision(items);
  const pieces: string[] = [];
  for (const item of normalized) {
    extractTextPiecesFromItem(item, pieces);
  }
  return pieces.join("\n");
}

interface StreamLike {
  kind?: string;
  content?: string;
  text?: string;
  role?: string;
  messageId?: string;
  append?: boolean;
  blockType?: string;
  entries?: Array<{ content?: string }>;
  output?: string;
  toolOutputs?: StreamLike[];
  input?: unknown;
}

function mergeStreamTextLike(prev: StreamLike, next: StreamLike): StreamLike {
  const prevContent = String(prev.content ?? prev.text ?? "");
  const nextContent = String(next.content ?? next.text ?? "");
  if (next.append) {
    return { ...prev, content: prevContent + nextContent };
  }
  if (nextContent === prevContent) return prev;
  if (nextContent.startsWith(prevContent)) {
    return { ...prev, content: nextContent };
  }
  return { ...next, content: nextContent };
}

/** Merge ACP append chunks the same way the chat renderer does. */
function normalizeStreamItemsForDecision(items: unknown[]): StreamLike[] {
  const out: StreamLike[] = [];
  for (const raw of items) {
    const item = raw as StreamLike;
    if (!item || typeof item !== "object") continue;

    if (item.kind === "text" || item.kind === "thinking") {
      if (item.messageId) {
        const idx = out.findIndex(
          (previous) =>
            previous.kind === item.kind &&
            previous.messageId === item.messageId &&
            (item.kind !== "text" || previous.role === item.role)
        );
        if (idx >= 0) {
          out[idx] = mergeStreamTextLike(out[idx]!, item);
          continue;
        }
      }
      const last = out[out.length - 1];
      if (
        item.append &&
        last &&
        last.kind === item.kind &&
        (item.kind !== "text" || last.role === item.role)
      ) {
        out[out.length - 1] = mergeStreamTextLike(last, item);
        continue;
      }
      if (
        last &&
        last.kind === item.kind &&
        (item.kind !== "text" || last.role === item.role)
      ) {
        const merged = mergeStreamTextLike(last, item);
        if (merged !== last) {
          out[out.length - 1] = merged;
          continue;
        }
      }
      out.push({ ...item, content: item.content ?? item.text ?? "" });
      continue;
    }
    out.push(item);
  }
  return out;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextPiecesFromItem(item: StreamLike, pieces: string[]): void {
  switch (item.kind) {
    case "text":
    case "thinking":
    case "raw":
    case "command-output": {
      const piece = String(item.content ?? item.text ?? "").trim();
      if (piece) pieces.push(piece);
      return;
    }
    case "tool-result": {
      const piece = String(item.content ?? "").trim();
      if (piece) pieces.push(piece);
      return;
    }
    case "tool-call": {
      if (typeof item.output === "string" && item.output.trim()) {
        pieces.push(item.output.trim());
      }
      if (item.input !== undefined) {
        const input = stringifyUnknown(item.input).trim();
        if (input && input !== "{}") pieces.push(input);
      }
      for (const nested of item.toolOutputs ?? []) {
        extractTextPiecesFromItem(nested, pieces);
      }
      return;
    }
    case "content-block": {
      if (item.blockType === "resource" && typeof item.text === "string") {
        const piece = item.text.trim();
        if (piece) pieces.push(piece);
      }
      return;
    }
    case "plan": {
      for (const entry of item.entries ?? []) {
        const piece = String(entry?.content ?? "").trim();
        if (piece) pieces.push(piece);
      }
      return;
    }
    default:
      return;
  }
}

/** Join every assistant text chunk in order (ACP may split long replies). */
export function collectAllTextFromItems(items: unknown[]): string {
  return collectDecisionTextFromItems(items);
}

/** Assistant-visible final output used for summaries and downstream context. */
export function extractVisibleStepOutput(items: unknown[]): string {
  const pieces: StreamLike[] = [];
  for (const raw of items) {
    const item = raw as StreamLike;
    if (!item || typeof item !== "object") continue;
    if (item.kind !== "text") continue;
    const content = String(item.content ?? item.text ?? "");
    if (item.messageId) {
      const idx = pieces.findIndex(
        (previous) =>
          previous.messageId === item.messageId &&
          previous.role === item.role
      );
      if (idx >= 0) {
        pieces[idx] = mergeStreamTextLike(pieces[idx]!, {
          ...item,
          content
        });
        continue;
      }
    }
    const last = pieces[pieces.length - 1];
    if (
      item.append &&
      last &&
      !last.messageId &&
      last.kind === "text" &&
      last.role === item.role
    ) {
      pieces[pieces.length - 1] = mergeStreamTextLike(last, {
        ...item,
        content
      });
      continue;
    }
    pieces.push({ ...item, content });
  }
  return pieces
    .map((item) => String(item.content ?? item.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/** Prefer full stream text from resultJson when deciding loop outcomes. */
export function resolveReviewDecisionText(
  summary: string | undefined,
  resultJson: string | undefined
): string | undefined {
  if (resultJson) {
    try {
      const parsed = JSON.parse(resultJson) as { items?: unknown[] };
      const full = collectDecisionTextFromItems(parsed.items ?? []).trim();
      if (full) return full;
    } catch {
      /* fall through to summary */
    }
  }
  return summary;
}

function compactStepSummary(text: string, maxLen = 400): string {
  const status = extractReviewStatus(text);
  const reviewMarker = status ? `REVIEW_STATUS: ${status}` : undefined;
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
  if (/<<<REVIEW_FAIL>>>/i.test(text)) return "FAIL";
  if (/<<<REVIEW_PASS>>>/i.test(text)) return "PASS";
  if (/\[\[REVIEW:FAIL\]\]/i.test(text)) return "FAIL";
  if (/\[\[REVIEW:PASS\]\]/i.test(text)) return "PASS";
  const matches = [
    ...text.matchAll(/REVIEW[\s_-]*STATUS\s*:\s*(PASS|FAIL)/gi)
  ];
  const last = matches.at(-1)?.[1];
  if (!last) return undefined;
  return last.toUpperCase() as "PASS" | "FAIL";
}

/** Ensure compact summaries still carry a review status marker when present in full text. */
export function ensureReviewStatusInSummary(
  summary: string,
  decisionText: string
): string {
  const status = extractReviewStatus(decisionText);
  if (!status) return summary;
  if (extractReviewStatus(summary)) return summary;
  return `${summary}\nREVIEW_STATUS: ${status}`;
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
  const reviewStatus = extractReviewStatus(reviewerSummary);
  if (reviewStatus === "PASS") return "finish";
  if (reviewStatus === "FAIL") {
    if (reviewerStatus !== "done" && reviewerStatus !== "failed") {
      return "partial";
    }
    if (loopIndex + 1 < maxLoops) return "loop";
    return "partial";
  }
  if (reviewerStatus !== "done") return "partial";
  return "finish";
}

/** First phase that still has steps not in done|skipped. */
export function findResumePhaseIndex(
  plan: WorkflowPlan,
  states: StepState[]
): number {
  for (let i = 0; i < plan.phases.length; i++) {
    const phase = plan.phases[i]!;
    const phaseSteps = states.filter((s) => s.phaseId === phase.id);
    if (phaseSteps.length === 0) continue;
    const finished = phaseSteps.every(
      (s) => s.status === "done" || s.status === "skipped"
    );
    if (!finished) return i;
  }
  return plan.phases.length;
}

/** Step row ids in a phase that should be reset before resuming after a block. */
export function resumableStepRowIds(
  phaseId: string,
  states: Array<{ id: string; phaseId: string; status?: WorkflowStepStatus }>
): string[] {
  return states
    .filter(
      (s) =>
        s.phaseId === phaseId &&
        (s.status === "failed" || s.status === "blocked" || s.status === "running")
    )
    .map((s) => s.id);
}

export interface ConsumedStepRef {
  stepId: string;
  title: string;
  summary?: string;
  output?: string;
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
    if (!ref) continue;
    const context = ref?.output?.trim() || ref?.summary?.trim();
    if (context) {
      blocks.push(`--- ${ref.title} ---\n${context}`);
    }
  }
  if (blocks.length === 0) return basePrompt;
  return `${basePrompt}\n\nContext from prior steps:\n${blocks.join("\n\n")}`;
}
