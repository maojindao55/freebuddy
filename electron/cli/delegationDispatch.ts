import type {
  DelegationArtifact,
  DelegationRosterEntry,
  DelegationPolicy
} from "./delegationTeamTypes.js";
import {
  buildDelegationResult,
  transitionDelegationEvent
} from "./delegationRuns.js";
import { DelegateConcurrencyQueue } from "./delegation/bus/concurrency.js";
import { electronDelegationRepository } from "../runtime/adapters/delegationRepository.js";
import {
  checkDelegateResultAction,
  decideDelegate,
  insertPendingChildEventsAtomic,
  listTeammatesAction,
  submitVerdictAction,
  yieldToDelegatesAction,
  type DelegateToolBinding,
  type DelegateRunContext,
  type DelegateToolResponse,
  type DelegateDecision
} from "./delegation/protocol/tools.js";

export type {
  DelegateToolBinding,
  DelegateRunContext,
  DelegateToolResponse
} from "./delegation/protocol/tools.js";

const MAX_RESULT_CHARS = 12_000;
const MAX_DELEGATE_BATCH_SIZE = 8;

export type DelegateRunContextProvider = (runId: string) => DelegateRunContext | undefined;

export interface DelegateExecArgs {
  teammate: DelegationRosterEntry;
  task: string;
  runId: string;
  teamId: string;
  cwd?: string;
  childEventId: string;
  parentEventId: string;
  depth: number;
  signal?: AbortSignal;
}

export interface DelegateExecResult {
  summary: string;
  exitCode: number | null;
  error: string | null;
  hasOutput?: boolean;
  diagnostic?: string | null;
  artifacts?: DelegationArtifact[];
}

export type DelegateExecutor = (args: DelegateExecArgs) => Promise<DelegateExecResult>;
export type DelegateWriteApprovalHook = (
  binding: DelegateToolBinding,
  teammate: DelegationRosterEntry
) => Promise<boolean>;

export interface DelegateActionDeps {
  contextProvider: DelegateRunContextProvider;
  executor: DelegateExecutor;
  writeApproval: DelegateWriteApprovalHook;
  /** Fired after a delegated event reaches a terminal status (done/failed/timeout/cancelled). */
  onSettle?: (eventId: string) => void;
  /** Optional: notify bus that a child node was enqueued / started. */
  onChildEnqueued?: (args: {
    runId: string;
    childEventId: string;
    parentEventId: string;
    depth: number;
  }) => void;
  /** Called after a validated yield response has been returned to the tool client. */
  onYieldRequested?: (binding: DelegateToolBinding) => void;
}

function boundSummary(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const head = text.slice(0, Math.floor(MAX_RESULT_CHARS / 2));
  const tail = text.slice(text.length - Math.floor(MAX_RESULT_CHARS / 2));
  return `${head}\n…[truncated]…\n${tail}`;
}

/** Per-deps queue instance so tests injecting different deps don't share state incorrectly.
 *  We key by deps object identity via WeakMap; settle always drains the same queue. */
const queuesByDeps = new WeakMap<
  DelegateActionDeps,
  DelegateConcurrencyQueue<DelegateExecArgs, DelegateExecResult>
>();

function queueFor(deps: DelegateActionDeps): DelegateConcurrencyQueue<
  DelegateExecArgs,
  DelegateExecResult
> {
  let q = queuesByDeps.get(deps);
  if (!q) {
    q = new DelegateConcurrencyQueue<DelegateExecArgs, DelegateExecResult>({
      repository: electronDelegationRepository(),
      getPolicy: (runId) => deps.contextProvider(runId)?.policy,
      executor: async (args) => deps.executor(args),
      onResult: (childEventId, result) => {
        const status = result.error ? "failed" : "done";
        const summary = result.error ?? boundSummary(result.summary);
        transitionDelegationEvent(
          childEventId,
          status,
          summary,
          {
            result: buildDelegationResult({
              status,
              summary,
              exitCode: result.exitCode,
              errorMessage: result.error,
              artifacts: result.artifacts
            })
          }
        );
      },
      onTimeout: (childEventId) => {
        transitionDelegationEvent(childEventId, "timeout", "委派超时");
      },
      onError: (childEventId, err) => {
        transitionDelegationEvent(
          childEventId,
          "failed",
          (err as Error)?.message ?? String(err)
        );
      },
      onCancelled: (childEventId, reason) => {
        transitionDelegationEvent(childEventId, "cancelled", reason);
      },
      onSettled: (childEventId) => {
        deps.onSettle?.(childEventId);
      }
    });
    queuesByDeps.set(deps, q);
  }
  return q;
}

type EnqueueDecision = Extract<DelegateDecision, { ok: true; kind: "enqueue" }>;

async function approveWriteDelegates(
  binding: DelegateToolBinding,
  decisions: EnqueueDecision[],
  ctx: DelegateRunContext,
  deps: DelegateActionDeps
): Promise<DelegateToolResponse | undefined> {
  if (!ctx.policy.requireApprovalBeforeDelegateWrite) return undefined;
  const writableTeammates = new Map<string, DelegationRosterEntry>();
  for (const decision of decisions) {
    if (decision.teammate.canWrite) {
      writableTeammates.set(decision.teammate.id, decision.teammate);
    }
  }
  for (const teammate of writableTeammates.values()) {
    let approved = false;
    try {
      approved = await deps.writeApproval(binding, teammate);
    } catch (error) {
      return {
        ok: false,
        status: "failed",
        error: `write approval failed: ${(error as Error)?.message ?? String(error)}`
      };
    }
    if (!approved) {
      return { ok: true, status: "failed", result: "写委派被用户拒绝；本批次未受理任何子任务" };
    }
  }
  return undefined;
}

function enqueueAcceptedDelegates(
  binding: DelegateToolBinding,
  ctx: DelegateRunContext,
  decisions: EnqueueDecision[],
  childEventIds: string[],
  deps: DelegateActionDeps
): void {
  const queue = queueFor(deps);
  decisions.forEach((decision, index) => {
    const childEventId = childEventIds[index]!;
    const abortController = new AbortController();
    try {
      deps.onChildEnqueued?.({
        runId: binding.runId,
        childEventId,
        parentEventId: binding.parentEventId,
        depth: decision.childDepth
      });
      queue.enqueue(binding.runId, {
        childEventId,
        execArgs: {
          teammate: decision.teammate,
          task: decision.task,
          runId: binding.runId,
          teamId: ctx.teamId,
          cwd: ctx.cwd,
          childEventId,
          parentEventId: binding.parentEventId,
          depth: decision.childDepth,
          signal: abortController.signal
        },
        timeoutMs: ctx.policy.delegateTimeoutMs,
        abortController
      });
    } catch (error) {
      transitionDelegationEvent(
        childEventId,
        "failed",
        `delegate start failed: ${(error as Error)?.message ?? String(error)}`
      );
      deps.onSettle?.(childEventId);
    }
  });
}

export async function runDelegateAction(
  binding: DelegateToolBinding,
  action: string,
  params: Record<string, unknown>,
  deps: DelegateActionDeps
): Promise<DelegateToolResponse> {
  if (action === "list_teammates") {
    return listTeammatesAction(binding, deps.contextProvider(binding.runId));
  }

  if (action === "submit_verdict") {
    return submitVerdictAction(binding, params);
  }

  if (action === "delegate") {
    const ctx = deps.contextProvider(binding.runId);
    const decision = decideDelegate({
      binding,
      ctx,
      teammateId: String(params.teammate_id ?? ""),
      task: String(params.task ?? "")
    });
    if (!decision.ok) {
      return { ok: false, error: decision.error, status: decision.status };
    }
    if (decision.kind === "reject") {
      return { ok: true, status: decision.status, result: decision.result };
    }

    const approvalFailure = await approveWriteDelegates(binding, [decision], ctx!, deps);
    if (approvalFailure) return approvalFailure;

    const [childEventId] = insertPendingChildEventsAtomic([{
      runId: binding.runId,
      parentEventId: binding.parentEventId,
      teammate: decision.teammate,
      task: decision.task,
      childDepth: decision.childDepth
    }]);
    enqueueAcceptedDelegates(binding, ctx!, [decision], [childEventId!], deps);
    return {
      ok: true,
      status: "pending",
      request_id: childEventId,
      event_id: childEventId
    };
  }


  if (action === "delegate_many") {
    const rawDelegations = params.delegations;
    if (!Array.isArray(rawDelegations) || rawDelegations.length === 0) {
      return { ok: false, error: "delegations must be a non-empty array" };
    }
    if (rawDelegations.length > MAX_DELEGATE_BATCH_SIZE) {
      return {
        ok: false,
        error: `delegations exceeds maximum batch size (${MAX_DELEGATE_BATCH_SIZE})`
      };
    }
    const ctx = deps.contextProvider(binding.runId);
    const decisions: EnqueueDecision[] = [];
    for (let index = 0; index < rawDelegations.length; index += 1) {
      const item = rawDelegations[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return { ok: false, error: `delegations[${index}] must be an object` };
      }
      const record = item as Record<string, unknown>;
      const decision = decideDelegate({
        binding,
        ctx,
        teammateId: String(record.teammate_id ?? ""),
        task: String(record.task ?? "")
      });
      if (!decision.ok) {
        return {
          ok: false,
          status: decision.status,
          error: `delegations[${index}]: ${decision.error}`
        };
      }
      if (decision.kind === "reject") {
        return {
          ok: true,
          status: "failed",
          result: `delegations[${index}]: ${decision.result}；本批次未受理任何子任务`
        };
      }
      decisions.push(decision);
    }

    const approvalFailure = await approveWriteDelegates(binding, decisions, ctx!, deps);
    if (approvalFailure) return approvalFailure;

    const childEventIds = insertPendingChildEventsAtomic(
      decisions.map((decision) => ({
        runId: binding.runId,
        parentEventId: binding.parentEventId,
        teammate: decision.teammate,
        task: decision.task,
        childDepth: decision.childDepth
      }))
    );
    enqueueAcceptedDelegates(binding, ctx!, decisions, childEventIds, deps);
    return {
      ok: true,
      status: "pending",
      accepted_count: childEventIds.length,
      request_ids: childEventIds,
      requests: childEventIds.map((id, index) => ({
        request_id: id,
        event_id: id,
        teammate_id: decisions[index]!.teammate.id,
        status: "pending"
      }))
    };
  }

  if (action === "yield_to_delegates") {
    return yieldToDelegatesAction(binding, params);
  }

  if (action === "check_delegate_result") {
    return checkDelegateResultAction(binding, params);
  }

  return { ok: false, error: `unknown action: ${action}` };
}

let singletonDeps: DelegateActionDeps | null = null;
export function setDelegateDeps(deps: DelegateActionDeps | null): void {
  singletonDeps = deps;
}
export async function dispatchDelegateAction(
  binding: DelegateToolBinding,
  action: string,
  params: Record<string, unknown>
): Promise<DelegateToolResponse> {
  if (!singletonDeps) return { ok: false, error: "delegate deps not configured" };
  return runDelegateAction(binding, action, params, singletonDeps);
}

export function cancelDelegatesForRun(runId: string, reason: string): void {
  if (!singletonDeps) return;
  queueFor(singletonDeps).cancelRun(runId, reason);
}

export function notifyDelegateYieldRequested(binding: DelegateToolBinding): void {
  singletonDeps?.onYieldRequested?.(binding);
}

// Re-export policy type touch for consumers that imported from here historically.
export type { DelegationPolicy };
