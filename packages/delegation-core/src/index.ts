import type { DelegationPolicy } from "@freebuddy/protocol/delegation";

export function defaultDelegationPolicy(): DelegationPolicy {
  return {
    allowWrites: true,
    requireApprovalBeforeDelegateWrite: true,
    maxDepth: 3,
    delegateTimeoutMs: 600000,
    maxConcurrentDelegates: 1,
    stopOnDelegateFailure: false
  };
}

export type {
  BusEffect,
  BusEvent,
  BusNode,
  BusState,
  NodeStatus,
  ReduceResult,
  RunStatus
} from "./bus/types.js";
export { createInitialBusState, ensureChildNode, markChildTurning, reduce } from "./bus/stateMachine.js";
export {
  analyzeDelegationOutput,
  type DelegationOutputEvidence
} from "./output/evidence.js";
export {
  ancestorRosterIds,
  isWholeTaskRedelegate,
  normalizeTaskText,
  rosterIdForEvent,
  taskSimilarity,
  WHOLE_TASK_SIMILARITY_THRESHOLD
} from "./protocol/guards.js";
export {
  buildDelegateTaskPrompt,
  buildDelegateWakePrompt,
  buildDelegationRosterPrompt,
  buildDelegationSkillMarkdown,
  mcpCheckResultDescription,
  mcpDelegateDescription,
  mcpDelegateManyDescription,
  mcpListTeammatesDescription,
  mcpSubmitVerdictDescription,
  mcpYieldToDelegatesDescription,
  protocolCanonicalPhrases,
  PROTOCOL_RULES
} from "./protocol/text.js";
export type { DelegateWakeInfo, DelegationInstructionContext } from "./protocol/text.js";
export {
  resolveEffectiveWakeVerdict,
  type EffectiveWakeVerdict
} from "./protocol/wakeVerdict.js";
