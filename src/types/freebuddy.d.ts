import type {
  CLIAdapterDefinition,
  CLIAdapterId
} from "@/config/cliAdapters";
import type {
  CLIExecutorOverride,
  CliRunArgs,
  SessionConfigOption,
  SessionConfigProbeInput,
  CliEvent,
  CliRuntime,
  CliCheckResult,
  CliInstallResult,
  CliInstallEvent,
  CliTaskRow,
  CliTaskLogPage,
  CliTaskListArgs,
  CodexUsageResult,
  AgentUsagePeriod,
  AgentUsageSummary,
  CliAuthControlArgs,
  CliAuthProbeResult,
  ToolSessionRecord,
  Conversation,
  ConversationMessage,
  ConversationTitleSource,
  AttachmentCandidate,
  WorkspaceFileMatch,
  PrepareAttachmentFilesResult,
  CreateConversationInput,
  ListConversationsArgs,
  AppendMessageInput,
  UpdateMessageInput,
  DraftToolEvent,
  DraftToolResolution,
  PreviewHandoffBriefInput,
  PreviewHandoffBriefResult,
  TransferConversationInput,
  TransferConversationResult
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
import type {
  AddFeedSourceInput,
  FeedItem,
  FeedRefreshResult,
  FeedSource,
  UpdateFeedSourceInput
} from "@/services/feed/types";
import type {
  CreateInfoCardInput,
  InfoCardConfig,
  InfoCardSnapshot,
  MarketProviderConfig,
  MarketSymbolSearchResult,
  UpdateInfoCardInput
} from "@/services/infoCards/types";
import type {
  MarketInstallRequest,
  MarketInstallResult,
  MarketProviderInfo,
  MarketSearchResult,
  SkillImportResult,
  SkillMarketProviderId,
  SkillRecord
} from "@/services/skills/types";
import type {
  ScheduledTask,
  ScheduledTaskAgent,
  ScheduledTaskInput,
  ScheduledTaskMutationResult,
  ScheduledTaskRun
} from "@/services/scheduledTasks/types";

export {};

declare global {
  interface FreebuddyCli {
    listAdapters(): Promise<CLIAdapterDefinition[]>;

    listOverrides(): Promise<CLIExecutorOverride[]>;
    upsertOverride(override: CLIExecutorOverride): Promise<void>;
    resetOverride(id: string): Promise<void>;

    listRuntimes(): Promise<CliRuntime[]>;
    onRuntimeUpdated(cb: (runtime: CliRuntime) => void): () => void;
    codexUsage(): Promise<CodexUsageResult>;
    usageSummary(period?: AgentUsagePeriod): Promise<AgentUsageSummary>;
    refreshUsage(period?: AgentUsagePeriod): Promise<AgentUsageSummary>;
    probeAuthentication(args: CliAuthControlArgs): Promise<CliAuthProbeResult>;
    logout(args: CliAuthControlArgs): Promise<void>;
    check(
      adapter: string,
      binary?: string,
      env?: Record<string, string>,
      runtimeAdapter?: string
    ): Promise<CliCheckResult>;
    install(adapter: string, command: string): Promise<CliInstallResult>;
    installStream(
      adapter: string,
      command: string,
      cb: (event: CliInstallEvent) => void
    ): () => void;

    run(args: CliRunArgs): Promise<{ sessionId: string }>;
    getCachedSessionConfigOptions(
      args: SessionConfigProbeInput
    ): Promise<SessionConfigOption[]>;
    inspectSessionConfigOptions(
      args: SessionConfigProbeInput
    ): Promise<SessionConfigOption[]>;
    kill(sessionId: string): Promise<boolean>;
    permissionDecision(args: {
      sessionId: string;
      requestId: string;
      outcome: "selected" | "cancelled";
      optionId?: string;
    }): Promise<boolean>;
    authenticationDecision(args: {
      sessionId: string;
      requestId: string;
      outcome: "selected" | "cancelled";
      methodId?: string;
    }): Promise<boolean>;
    authenticationTerminalInput(args: {
      sessionId: string;
      requestId: string;
      data: string;
    }): Promise<boolean>;
    authenticationTerminalCancel(args: {
      sessionId: string;
      requestId: string;
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
    previewHandoffBrief(
      input: PreviewHandoffBriefInput
    ): Promise<PreviewHandoffBriefResult>;
    transferConversation(
      input: TransferConversationInput
    ): Promise<TransferConversationResult>;
    renameConversation(
      id: string,
      title: string,
      titleSource?: ConversationTitleSource | null
    ): Promise<void>;
    updateConversationAgentName(
      agentId: string,
      agentName: string
    ): Promise<void>;
    archiveConversation(id: string, archived: boolean): Promise<void>;
    deleteConversation(id: string): Promise<void>;
    setConversationApprovalMode(
      id: string,
      approvalMode: "auto" | "ask" | null
    ): Promise<void>;
    setConversationConfigOptionOverrides(
      id: string,
      overrides: Record<string, string> | null
    ): Promise<Conversation | undefined>;
    setConversationSkills(
      id: string,
      skillIds: string[]
    ): Promise<Conversation | undefined>;

    listMessages(conversationId: string): Promise<ConversationMessage[]>;
    listMessage(id: string): Promise<ConversationMessage | undefined>;
    appendMessage(input: AppendMessageInput): Promise<ConversationMessage>;
    updateMessage(input: UpdateMessageInput): Promise<void>;

    selectDirectory(): Promise<string | null>;
    searchWorkspaceFiles(
      cwd: string,
      query: string,
      limit?: number
    ): Promise<WorkspaceFileMatch[]>;
    selectAttachments(): Promise<AttachmentCandidate[]>;
  prepareAttachmentFiles(
    files: File[],
    limit?: number,
    existingPaths?: string[]
  ): Promise<PrepareAttachmentFilesResult>;
    discardManagedAttachment(filePath: string): Promise<boolean>;
    discardManagedAttachmentIfUnreferenced(filePath: string): Promise<boolean>;
    discardManagedAttachments(paths: string[]): void;
    resolveDraftEntry(cwd: string): Promise<string | null>;
    readDraftMarkdown(cwd: string, rel: string): Promise<string | null>;
    openDraftExternal(url: string): Promise<boolean>;
    ensureAgentGuides(
      cwd: string,
      options?: { nativeDraftTools?: boolean }
    ): Promise<{ path: string; action: "created" | "updated" }[]>;

    onEvent(sessionId: string, cb: (event: CliEvent) => void): () => void;
  }

  interface FreebuddyWindow {
    onChromeVisible(cb: (visible: boolean) => void): () => void;
    onBridge(
      cb: (event: { action: string; params: Record<string, string> }) => void
    ): () => void;
    onDraftTool(cb: (event: DraftToolEvent) => void): () => void;
    resolveDraftTool(resolution: DraftToolResolution): Promise<boolean>;
  }

  interface FreebuddySettings {
    getSetting(key: string): Promise<string | null>;
    setSetting(key: string, value: string): Promise<void>;
  }

  interface FreebuddyFeed {
    listSources(): Promise<FeedSource[]>;
    addSource(input: AddFeedSourceInput): Promise<FeedSource>;
    updateSource(input: UpdateFeedSourceInput): Promise<FeedSource | undefined>;
    deleteSource(id: string): Promise<boolean>;
    listItems(args?: { limit?: number; offset?: number }): Promise<FeedItem[]>;
    refreshSource(id: string): Promise<FeedRefreshResult>;
    refreshAll(): Promise<FeedRefreshResult[]>;
    markInterpreted(id: string): Promise<FeedItem | undefined>;
  }

  interface FreebuddyInfoCards {
    list(): Promise<InfoCardConfig[]>;
    create(input: CreateInfoCardInput): Promise<InfoCardConfig>;
    update(input: UpdateInfoCardInput): Promise<InfoCardConfig | undefined>;
    delete(id: string): Promise<boolean>;
    reorder(ids: string[]): Promise<InfoCardConfig[]>;
    snapshot(id: string): Promise<InfoCardSnapshot>;
    refresh(id: string, timeZone?: string): Promise<InfoCardSnapshot>;
    marketProvider(): Promise<MarketProviderConfig>;
    searchMarketSymbols(query: string): Promise<MarketSymbolSearchResult[]>;
    onChanged(cb: () => void): () => void;
  }

  interface FreebuddySkills {
    list(): Promise<SkillRecord[]>;
    import(sourcePath: string): Promise<SkillImportResult>;
    setEnabled(id: string, enabled: boolean): Promise<SkillRecord | undefined>;
    setTrusted(id: string, trusted: boolean): Promise<SkillRecord | undefined>;
    delete(id: string): Promise<boolean>;
    read(id: string): Promise<string | undefined>;
    selectDirectory(): Promise<string | null>;
    selectArchive(): Promise<string | null>;
    reveal(id: string): Promise<boolean>;
    marketProviders(): Promise<MarketProviderInfo[]>;
    getMarketProvider(): Promise<SkillMarketProviderId>;
    setMarketProvider(provider: SkillMarketProviderId): Promise<SkillMarketProviderId>;
    searchMarket(args: {
      provider?: SkillMarketProviderId;
      query?: string;
      cursor?: string;
      limit?: number;
    }): Promise<MarketSearchResult>;
    installFromMarket(request: MarketInstallRequest): Promise<MarketInstallResult>;
    openMarketUrl(url: string): Promise<boolean>;
    resolveMarketHomepage(args: {
      provider: SkillMarketProviderId;
      slug: string;
      ownerHandle?: string;
      version?: string;
      downloadsHint?: number;
    }): Promise<string | null>;
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
    requestGateChanges(args: {
      runId: string;
      phaseId: string;
      feedback: string;
    }): Promise<boolean>;
    continueImplementReview(runId: string): Promise<boolean>;
    getRun(runId: string): Promise<WorkflowRunRow | undefined>;
    listActiveRuns(): Promise<WorkflowRunRow[]>;
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

  interface FreebuddyScheduledTasks {
    list(): Promise<ScheduledTask[]>;
    listRuns(taskId: string): Promise<ScheduledTaskRun[]>;
    listAgents(): Promise<ScheduledTaskAgent[]>;
    create(input: ScheduledTaskInput): Promise<ScheduledTaskMutationResult>;
    update(args: {
      id: string;
      input: ScheduledTaskInput;
    }): Promise<ScheduledTaskMutationResult>;
    delete(id: string): Promise<boolean>;
    run(id: string): Promise<boolean>;
    onChanged(cb: (task?: ScheduledTask) => void): () => void;
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
    skills: FreebuddySkills;
    scheduledTasks: FreebuddyScheduledTasks;
    settings: FreebuddySettings;
    feed: FreebuddyFeed;
    infoCards: FreebuddyInfoCards;
    window: FreebuddyWindow;
    updater: FreebuddyUpdater;
  }

  interface Window {
    freebuddy?: FreebuddyApi;
  }
}
