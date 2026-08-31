export const PROTOCOL_PACKAGE = "@freebuddy/protocol";

export type {
  WorkflowAgentRef,
  WorkflowEdgeCondition,
  WorkflowGate,
  WorkflowNodeContract,
  WorkflowPhase,
  WorkflowPlan,
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepMode,
  WorkflowStepRow,
  WorkflowStepStatus,
  WorkflowTeam,
  WorkflowTeamPolicy,
  WorkflowTeamPreview,
  WorkflowTeamRole,
  WorkflowTeamRoleKind,
  WorkflowTeamValidationResult,
  WorkflowTemplate2,
  WorkflowTemplateEdge,
  WorkflowTemplateNode,
  WorkflowTemplateNodeGate,
  WorkflowTemplateNodeMode,
  WorkflowValidationResult
} from "./workflow.js";

export { workflowStepFailureReason } from "./workflow.js";

export type {
  DelegationArtifact,
  DelegationEvent,
  DelegationEventRow,
  DelegationEventStatus,
  DelegationPolicy,
  DelegationResult,
  DelegationRosterEntry,
  DelegationRunFinishedEvent,
  DelegationRunRow,
  DelegationTeam,
  DelegationTeamValidationResult,
  DelegationVerdict
} from "./delegation.js";

export {
  effectiveDelegationRoleCanWrite,
  validateDelegationTeam
} from "./delegation.js";

export type {
  CLIStreamMode,
  CliStreamItem,
  ParseContext,
  ToolCallStatus,
  ToolKind,
  ToolOutputItem
} from "./cli.js";

export {
  DEFAULT_HOST_CAPABILITIES,
  DEFAULT_RUNTIME_CAPABILITIES,
  HOST_API_VERSION,
  RUNTIME_BUNDLE_ID,
  RUNTIME_MANIFEST_SCHEMA_VERSION,
  RUNTIME_RPC_VERSION,
  RUNTIME_STATE_SCHEMA_VERSION
} from "./runtime.js";

export type {
  RuntimeChannelDescriptor,
  RuntimeChecksums,
  RuntimeHealthSnapshot,
  RuntimeHelloRequest,
  RuntimeHelloResponse,
  RuntimeHostId,
  RuntimeManifest,
  RuntimeReadyEvent,
  RuntimeRpcError,
  RuntimeRpcFrame,
  RuntimeRpcKind
} from "./runtime.js";

export {
  BoundedIdempotencyCache,
  IDEMPOTENCY_CACHE_MAX_ENTRIES,
  IDEMPOTENCY_CACHE_TTL_MS
} from "./idempotencyCache.js";
export type {
  BoundedIdempotencyCacheOptions,
  BoundedIdempotencyLookup
} from "./idempotencyCache.js";
