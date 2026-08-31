import type {
  WorkflowPlan,
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStepRow,
  WorkflowStepStatus
} from "@freebuddy/protocol/workflow";
import type {
  EventPublisher,
  TelemetryPort
} from "@freebuddy/agent-runtime";

export interface ConversationMessageRef {
  role: string;
  attachments?: Array<{
    path: string;
    kind?: string;
    mimeType?: string;
    name?: string;
  }>;
}

export interface ConversationPort {
  requireOwned?(conversationId: string): unknown;
  listMessages(conversationId: string): ConversationMessageRef[];
  appendMessage(input: Record<string, unknown>): unknown;
  updateMessage?(input: Record<string, unknown>): void;
}

export interface CreateWorkflowRunInput {
  id: string;
  conversationId?: string;
  teamId?: string;
  teamSnapshotJson?: string;
  planVersion?: number;
  name: string;
  goal: string;
  cwd?: string;
  template?: string;
  maxLoops: number;
  planJson: string;
  status?: WorkflowRunStatus;
  runtimeVersion?: string | null;
  runtimeApiVersion?: string | null;
}

export interface CreateWorkflowStepInput {
  id: string;
  workflowRunId: string;
  phaseId: string;
  stepId: string;
  title: string;
  agentId: string;
  agentName: string;
  adapter: string;
  mode: WorkflowStepRow["mode"];
  prompt: string;
  dependsOn?: string[];
  targetPaths?: string[];
}

export interface WorkflowRepository {
  createRun(input: CreateWorkflowRunInput): WorkflowRunRow;
  getRun(id: string): WorkflowRunRow | undefined;
  updateRun(
    id: string,
    patch: Partial<{
      status: WorkflowRunStatus;
      summary: string | null;
      loopIndex: number;
      maxLoops: number;
      planJson: string;
      endedAt: string | null;
    }>
  ): void;
  createStep(input: CreateWorkflowStepInput): void;
  getSteps(runId: string): WorkflowStepRow[];
  updateStep(
    id: string,
    patch: Partial<{
      status: WorkflowStepStatus;
      summary: string | null;
      resultJson: string | null;
      cliTaskId: string | null;
      toolSessionId: string | null;
      startedAt: string | null;
      endedAt: string | null;
      prompt: string;
    }>
  ): void;
  resetStepsForLoop(runId: string, phaseIds: string[]): void;
}

export interface AgentResolver {
  resolve(agentId: string):
    | {
        adapter: string;
        agentName: string;
        binary?: string;
        extraArgs?: string[];
        env?: Record<string, string>;
        skillIds?: string[];
      }
    | undefined;
}

export interface LanguagePort {
  getLanguage(): string;
  applyPreference(prompt: string, language: string): string;
}

export interface ToolSessionPort {
  get(agentId: string, scope: string): { sessionId: string } | undefined;
}

export interface WorkflowRuntimePorts {
  repository: WorkflowRepository;
  conversations: ConversationPort;
  executor: StepExecutor;
  resolveAgent: AgentResolver["resolve"];
  events: EventPublisher;
  telemetry: TelemetryPort;
  language: LanguagePort;
  toolSessions?: ToolSessionPort;
  killSession?: (sessionId: string) => void;
}

export interface StepExecutor {
  run(args: {
    sessionId: string;
    conversationId?: string;
    agentId: string;
    agentName: string;
    adapter: string;
    binary?: string;
    extraArgs?: string[];
    env?: Record<string, string>;
    configOptionOverrides?: Record<string, string>;
    skillIds?: string[];
    prompt: string;
    promptAttachments?: Array<{
      path: string;
      kind?: string;
      mimeType?: string;
      name?: string;
    }>;
    toolSessionScope?: string;
    toolSessionId?: string;
    resumeToolSession?: boolean;
    cwd?: string;
    workspaceAccess?: "read-only" | "read-write";
    onEvent: (e: {
      type: string;
      items?: unknown[];
      exitCode?: number;
      message?: string;
      [key: string]: unknown;
    }) => void;
  }): Promise<void>;
}

export type { WorkflowPlan };
