import type {
  CLIAdapterDefinition,
  CLIAdapterId
} from "@/config/cliAdapters";
import type {
  CLIExecutorOverride,
  CliRunArgs,
  CliEvent,
  CliRuntime,
  CliCheckResult,
  CliInstallResult,
  CliTaskRow,
  CliTaskLogPage,
  CliTaskListArgs,
  ToolSessionRecord,
  Conversation,
  ConversationMessage,
  AttachmentCandidate,
  CreateConversationInput,
  ListConversationsArgs,
  AppendMessageInput,
  UpdateMessageInput
} from "@/services/cli/types";
import type {
  WorkflowPlan,
  WorkflowRunRow,
  WorkflowStepRow,
  WorkflowValidationResult
} from "@/services/workflows/types";
import type {
  WorkflowTeam,
  WorkflowTeamPreview,
  WorkflowTeamRole,
  WorkflowTeamPolicy,
  WorkflowTemplate2
} from "@/services/workflowTeams/types";

export {};

declare global {
  interface FreebuddyCli {
    listAdapters(): Promise<CLIAdapterDefinition[]>;

    listOverrides(): Promise<CLIExecutorOverride[]>;
    upsertOverride(override: CLIExecutorOverride): Promise<void>;
    resetOverride(id: string): Promise<void>;

    listRuntimes(): Promise<CliRuntime[]>;
    check(adapter: string, binary?: string): Promise<CliCheckResult>;
    install(command: string): Promise<CliInstallResult>;
    installStream(
      command: string,
      cb: (event: { type: "stdout" | "stderr"; content: string } | { type: "done"; exitCode: number | null }) => void
    ): () => void;

    run(args: CliRunArgs): Promise<{ sessionId: string }>;
    kill(sessionId: string): Promise<boolean>;
    permissionDecision(args: {
      sessionId: string;
      requestId: string;
      outcome: "selected" | "cancelled";
      optionId?: string;
    }): Promise<boolean>;

    listTasks(args?: CliTaskListArgs): Promise<CliTaskRow[]>;
    getTask(id: string): Promise<CliTaskRow | undefined>;
    readTaskLog(args: {
      taskId: string;
      startLine?: number;
      limit?: number;
      maxBytes?: number;
    }): Promise<CliTaskLogPage>;

    getToolSession(
      agentId: string,
      workspacePath: string
    ): Promise<ToolSessionRecord | undefined>;
    saveToolSession(args: {
      agentId: string;
      workspacePath: string;
      adapter: CLIAdapterId;
      sessionId: string;
      title?: string;
    }): Promise<void>;

    listConversations(args?: ListConversationsArgs): Promise<Conversation[]>;
    getConversation(id: string): Promise<Conversation | undefined>;
    createConversation(
      input: CreateConversationInput
    ): Promise<Conversation>;
    renameConversation(id: string, title: string): Promise<void>;
    archiveConversation(id: string, archived: boolean): Promise<void>;
    deleteConversation(id: string): Promise<void>;
    setConversationApprovalMode(
      id: string,
      approvalMode: "auto" | "ask" | null
    ): Promise<void>;

    listMessages(conversationId: string): Promise<ConversationMessage[]>;
    appendMessage(input: AppendMessageInput): Promise<ConversationMessage>;
    updateMessage(input: UpdateMessageInput): Promise<void>;

    selectDirectory(): Promise<string | null>;
    selectAttachments(): Promise<AttachmentCandidate[]>;

    onEvent(sessionId: string, cb: (event: CliEvent) => void): () => void;
  }

  interface FreebuddyWindow {
    onChromeVisible(cb: (visible: boolean) => void): () => void;
  }

  interface FreebuddySettings {
    getSetting(key: string): Promise<string | null>;
    setSetting(key: string, value: string): Promise<void>;
  }

  interface FreebuddyWorkflow {
    validate(plan: WorkflowPlan): Promise<WorkflowValidationResult>;
    previewReviewLoop(input: {
      goal: string;
      cwd?: string;
      targetPaths?: string[];
    }): Promise<
      | { ok: true; plan: WorkflowPlan }
      | { ok: false; errors: string[] }
    >;
    coordinatorPrompt(input: {
      goal: string;
      cwd?: string;
      targetPaths?: string[];
    }): Promise<string>;
    createRun(input: {
      conversationId?: string;
      plan: WorkflowPlan;
    }): Promise<
      | { ok: true; run: WorkflowRunRow }
      | { ok: false; errors: string[] }
    >;
    start(runId: string): Promise<boolean>;
    pause(runId: string): Promise<boolean>;
    resume(runId: string): Promise<void>;
    stop(runId: string): Promise<boolean>;
    retryStep(args: { runId: string; stepRowId: string }): Promise<void>;
    approveGate(args: { runId: string; phaseId: string }): Promise<boolean>;
    getRun(runId: string): Promise<WorkflowRunRow | undefined>;
    getSteps(runId: string): Promise<WorkflowStepRow[]>;
    listRuns(conversationId: string): Promise<WorkflowRunRow[]>;
    previewTeamRun(input: {
      teamId: string;
      goal: string;
      cwd?: string;
      targetPaths?: string[];
    }): Promise<
      | { ok: true; preview: WorkflowTeamPreview }
      | { ok: false; errors: string[] }
    >;
    createTeamRun(input: {
      teamId: string;
      conversationId?: string;
      goal: string;
      cwd?: string;
      targetPaths?: string[];
    }): Promise<
      | { ok: true; run: WorkflowRunRow }
      | { ok: false; errors: string[] }
    >;
    onStepMessage(
      conversationId: string,
      cb: (event: {
        type: "appended" | "updated";
        messageId: string;
      }) => void
    ): () => void;
  }

  interface FreebuddyWorkflowTeams {
    list(): Promise<WorkflowTeam[]>;
    get(id: string): Promise<WorkflowTeam | undefined>;
    create(input: {
      id: string;
      name: string;
      description?: string;
      icon?: string;
      enabled: boolean;
      source: "builtin" | "user";
      roles: WorkflowTeamRole[];
      template: WorkflowTemplate2;
      policy: WorkflowTeamPolicy;
    }): Promise<
      | { ok: true; team: WorkflowTeam }
      | { ok: false; errors: string[] }
    >;
    update(args: {
      id: string;
      patch: {
        name?: string;
        description?: string | null;
        icon?: string | null;
        enabled?: boolean;
        roles?: WorkflowTeamRole[];
        template?: WorkflowTemplate2;
        policy?: WorkflowTeamPolicy;
      };
    }): Promise<
      | { ok: true; team: WorkflowTeam }
      | { ok: false; errors: string[] }
    >;
    delete(id: string): Promise<boolean>;
    seedBuiltins(): Promise<WorkflowTeam[]>;
  }

  type UpdaterEvent =
    | { type: "checking-for-update" }
    | {
        type: "update-available";
        version: string;
        releaseDate?: string;
        releaseNotes?: unknown;
      }
    | { type: "update-not-available"; version: string }
    | {
        type: "download-progress";
        percent: number;
        transferred: number;
        total: number;
        bytesPerSecond: number;
      }
    | { type: "update-downloaded"; version: string }
    | { type: "error"; message: string };

  interface FreebuddyUpdater {
    getVersion(): Promise<string>;
    check(): Promise<
      | { ok: true; available: boolean; version: string | null }
      | { ok: false; error: string }
    >;
    download(): Promise<{ ok: true } | { ok: false; error: string }>;
    quitAndInstall(): Promise<boolean>;
    onEvent(cb: (event: UpdaterEvent) => void): () => void;
  }

  interface FreebuddyApi {
    platform: string;
    arch: string;
    versions: {
      chrome?: string;
      electron?: string;
      node?: string;
    };
    appVersion: string;
    cli: FreebuddyCli;
    workflow: FreebuddyWorkflow;
    workflowTeams: FreebuddyWorkflowTeams;
    settings: FreebuddySettings;
    window: FreebuddyWindow;
    updater: FreebuddyUpdater;
  }

  interface Window {
    freebuddy?: FreebuddyApi;
  }
}
