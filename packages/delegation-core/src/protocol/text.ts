import type {
  DelegationRosterEntry,
  DelegationVerdict
} from "@freebuddy/protocol/delegation";

/** Canonical async-delegation protocol. Skill / MCP / roster prompts derive from here. */

export const PROTOCOL_RULES = {
  delegateReturnsPending:
    'Call `delegate(teammate_id, task)` — returns IMMEDIATELY with a durable acceptance receipt `{request_id, status:"pending"}`. No receipt means the sub-task was not accepted.',
  delegateManyIsAtomic:
    'Use `delegate_many(delegations)` for independent sub-tasks. Acceptance is atomic: either every item returns a request handle, or none are created.',
  pendingMeansQueued:
    'status `pending` = durably accepted and queued behind the concurrency limit. Do not poll it.',
  runningMeansEndTurn:
    'status `running` = accepted and executing. Do not poll it.',
  yieldAfterAcceptance:
    'After one or more requests are accepted, call `yield_to_delegates(request_ids)` once. It only yields when at least one owned request is still active; otherwise it returns an error and you must keep working.',
  yieldInstruction:
    "Delegation wait accepted. The runtime is parking this turn now. Do not poll; it will wake you when a requested delegate settles.",
  /** Returned on `check_delegate_result` when status is running — shown at decision time. */
  runningCheckInstruction:
    "This delegate is still active. Call yield_to_delegates with its request_id instead of polling.",
  terminalMeansUseResult:
    'status `done`/`failed`/`timeout` = terminal. Prefer the versioned `outcome`; `result` is the legacy summary fallback.',
  noBounce: "Do NOT bounce work back to your caller or any ancestor on the call chain.",
  noWholeTask:
    "Do NOT delegate the entire task you were given (near-identical copy). Split a real sub-task, or do it yourself.",
  preferSelf: "Prefer work you can finish yourself; do not abuse delegation.",
  depthAwareness:
    "Your current delegation depth and the team roster are in the prompt header. Near the depth cap, prefer doing the work yourself."
} as const;

export function mcpListTeammatesDescription(): string {
  return "List the teammates available to delegate to in the current delegation run (excluding yourself and any caller/ancestor on the call chain — those cannot be delegated to). Each entry has id, label, capability (what to delegate to it), and canWrite. Read-only. An empty list means do the work yourself.";
}

export function mcpDelegateDescription(): string {
  return [
    "Asynchronously delegate a sub-task to a teammate.",
    PROTOCOL_RULES.delegateReturnsPending,
    "Pick the teammate by matching its capability to the sub-task.",
    PROTOCOL_RULES.preferSelf,
    PROTOCOL_RULES.noBounce,
    PROTOCOL_RULES.noWholeTask
  ].join(" ");
}

export function mcpDelegateManyDescription(): string {
  return [
    "Atomically delegate up to 8 independent sub-tasks.",
    PROTOCOL_RULES.delegateManyIsAtomic,
    PROTOCOL_RULES.yieldAfterAcceptance,
    PROTOCOL_RULES.noBounce,
    PROTOCOL_RULES.noWholeTask
  ].join(" ");
}

export function mcpYieldToDelegatesDescription(): string {
  return [
    "Yield the current agent turn after delegation requests were durably accepted.",
    PROTOCOL_RULES.yieldAfterAcceptance,
    "Pass request handles returned by delegate or delegate_many.",
    PROTOCOL_RULES.yieldInstruction
  ].join(" ");
}

export function mcpCheckResultDescription(): string {
  return [
    "Inspect a delegate call's current result when needed. Returns {status, outcome, result, request_id}; outcome is the versioned contract and result is its legacy summary. Do not use this tool for polling.",
    PROTOCOL_RULES.pendingMeansQueued,
    PROTOCOL_RULES.runningMeansEndTurn,
    "If it is still active, call `yield_to_delegates` instead.",
    PROTOCOL_RULES.terminalMeansUseResult
  ].join(" ");
}

export function mcpSubmitVerdictDescription(): string {
  return [
    "Submit a structured verdict for the current delegated task before you finish.",
    "Required for review/audit sub-tasks.",
    "verdict must be one of: pass (ready to close), needs_changes (caller must fix then re-delegate review), fail (blocking).",
    "Optional summary: one or two sentences."
  ].join(" ");
}

function writeFlag(canWrite: boolean): string {
  return canWrite ? "可写" : "只读";
}

export interface DelegationInstructionContext {
  /** Rules that every role in the team must follow on every turn. */
  sharedInstructions?: string;
  /** Rules that the currently executing role must follow on every turn. */
  roleInstructions?: string;
  selfLabel?: string;
}

function buildInstructionPrompt(context?: DelegationInstructionContext): string {
  const shared = context?.sharedInstructions?.trim();
  const role = context?.roleInstructions?.trim();
  const sections: string[] = [];
  if (shared) {
    sections.push("## 团队共享指令", shared);
  }
  if (context?.selfLabel || role) {
    sections.push("## 当前角色", `你是「${context?.selfLabel?.trim() || "未命名角色"}」。`);
  }
  if (role) {
    sections.push("## 角色自身执行指令", role);
  }
  return sections.join("\n");
}

export function buildDelegationRosterPrompt(
  roster: DelegationRosterEntry[],
  selfId: string,
  depth: number,
  maxDepth: number,
  instructionContext?: DelegationInstructionContext
): string {
  const lines = roster
    .filter((r) => r.id !== selfId)
    .map((r) => `- [${r.id}] ${r.label} (${writeFlag(r.canWrite)})："${r.capability}"`)
    .join("\n");
  const instructions = buildInstructionPrompt(instructionContext);
  return [
    ...(instructions ? [instructions, ""] : []),
    "## 协作团队（可委派）",
    "某子任务更适合某队友时：",
    '1. 单个子任务调 delegate(teammate_id, task)；多个独立子任务优先调 delegate_many(delegations)。',
    '2. 只有拿到 {request_id, status:"pending"} 或批量 requests 才算受理成功；批量受理是全有或全无。',
    "3. 受理成功后，把 request_id 列表一次传给 yield_to_delegates；不要轮询 check_delegate_result。",
    "4. yield 成功后运行时会自动 park 当前轮。结果就绪后系统会自动唤醒你；若 yield 拒绝，说明没有可等待的活跃委派，应继续处理结果或自行完成。",
    "5. 被唤醒后优先读取结构化 outcome；旧适配器可继续使用 result 摘要。",
    "优先自己能完成的；别滥用委派；别反弹回调用方；别把整份任务原样外派。",
    `当前深度 ${depth} / 上限 ${maxDepth}。`,
    "队友：",
    lines || "- （无其他队友）"
  ].join("\n");
}

export function buildDelegateTaskPrompt(
  task: string,
  roster: DelegationRosterEntry[],
  selfId: string,
  depth: number,
  maxDepth: number,
  instructionContext?: DelegationInstructionContext
): string {
  return [
    buildDelegationRosterPrompt(roster, selfId, depth, maxDepth, instructionContext),
    "",
    "## 本次任务",
    task
  ].join("\n");
}

export interface DelegateWakeInfo {
  taskText: string;
  roleLabel: string;
  status: string;
  resultSummary: string;
  verdict?: DelegationVerdict | null;
  verdictSummary?: string | null;
}

export function buildDelegateWakePrompt(
  info: DelegateWakeInfo,
  roster: DelegationRosterEntry[],
  selfId: string,
  depth: number,
  maxDepth: number,
  instructionContext?: DelegationInstructionContext
): string {
  const summary = info.resultSummary?.trim() || "(无输出)";
  const verdict = info.verdict ?? null;
  const verdictLine =
    verdict === null
      ? "结构化结论：未提交 verdict（按 needs_changes 保守处理）。"
      : `结构化结论：verdict=${verdict}${info.verdictSummary ? `；摘要：${info.verdictSummary}` : ""}`;

  let nextSteps: string;
  if (verdict === "pass") {
    nextSteps =
      "评审已通过（pass）。若无新待办可以收尾；不要无故再开一轮复审。";
  } else {
    // needs_changes | fail | null
    nextSteps = [
      "存在待改项或未通过（或对方未提交 verdict）。",
      "请先按上方结果修改。",
      `改完后必须再 delegate 给角色「${info.roleLabel}」做复审（用 list_teammates 选对应 id）。`,
      "在复审返回 verdict=pass 之前，不要宣布收尾。"
    ].join("");
  }

  return [
    buildDelegationRosterPrompt(roster, selfId, depth, maxDepth, instructionContext),
    "",
    "## 委派结果返回（你被唤醒）",
    `你之前委派给「${info.roleLabel}」的子任务已结束（status: ${info.status}）。`,
    verdictLine,
    "子任务：",
    info.taskText,
    "",
    "结果：",
    summary,
    "",
    nextSteps
  ].join("\n");
}

/** English SKILL.md body (frontmatter supplied by assets file / seed). */
export function buildDelegationSkillMarkdown(): string {
  return [
    "---",
    "name: delegation",
    "description: Collaborate with teammate agents in a self-organizing delegation run. Discover teammates and delegate sub-tasks asynchronously; the system wakes you when results settle.",
    "version: 1.4.0",
    "---",
    "",
    "# Delegation",
    "",
    "You are part of a self-organizing team. You can delegate sub-tasks to teammates and receive delegated sub-tasks from your caller.",
    "",
    "## When to delegate",
    "Delegate a sub-task ONLY when:",
    "- It falls clearly in a teammate's `capability` (read it via `list_teammates`), AND",
    "- It is non-trivial work you are not best suited to do yourself.",
    "",
    "Do NOT delegate:",
    "- Small things you can do directly.",
    "- Back to your caller or any ancestor (no ping-pong).",
    "- The entire task you were given (near-identical copy).",
    "",
    "## How to delegate",
    `1. Call \`list_teammates\` to see who is available.`,
    `2. For one sub-task, ${PROTOCOL_RULES.delegateReturnsPending}`,
    `3. For multiple independent sub-tasks, ${PROTOCOL_RULES.delegateManyIsAtomic}`,
    `4. ${PROTOCOL_RULES.yieldAfterAcceptance}`,
    `5. When yield succeeds, the runtime parks this turn automatically and wakes you with a settled result.`,
    "",
    "Do not poll `check_delegate_result`. It is only for inspecting a request when recovery or diagnostics require it.",
    "",
    "## Handle the result",
    "- `status: \"done\"` → prefer structured `outcome`; use legacy `result` as a fallback.",
    "- `status: \"failed\"` / `\"timeout\"` → decide: retry, delegate to a different teammate, or do it yourself. Do not loop forever.",
    "",
    "## Review verdicts",
    "For review/audit sub-tasks, call `submit_verdict` before you finish:",
    "- `pass` — ready to close",
    "- `needs_changes` — caller must fix, then re-delegate review",
    "- `fail` — blocking",
    "",
    "## After a wake with needs_changes/fail",
    "Fix first, then `delegate` review again. Do not declare done until a later wake has `verdict=pass`.",
    "",
    "## Current context",
    PROTOCOL_RULES.depthAwareness
  ].join("\n");
}

/** Phrases that Skill / MCP / roster text must all surface (for snapshot tests). */
export function protocolCanonicalPhrases(): string[] {
  return [
    'status:"pending"',
    "delegate_many",
    "yield_to_delegates",
    "running",
    "wake",
    "pending",
    "no ping-pong",
    "entire task",
    "submit_verdict",
    "needs_changes"
  ];
}
