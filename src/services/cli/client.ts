import i18next from "i18next";
import type {
  CLIExecutorOverride,
  CliCheckResult,
  CliEvent,
  CliInstallResult,
  CliInstallEvent,
  CliAuthControlArgs,
  CliAuthProbeResult,
  CliRunArgs,
  SessionConfigOption,
  SessionConfigProbeInput,
  CliRuntime,
  CliTaskListArgs,
  CliTaskLogPage,
  CliTaskRow,
  CodexUsageResult,
  AgentUsagePeriod,
  AgentUsageSummary,
  CursorUsageConnectInput,
  CursorUsageStatus,
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
  PreviewHandoffBriefInput,
  PreviewHandoffBriefResult,
  TransferConversationInput,
  TransferConversationResult,
  CreateConversationShareInput,
  CreateConversationShareResult,
  AttachConversationSharesInput,
  AttachConversationSharesResult,
  ConversationContextReference
} from "./types";
import type { CLIAdapterDefinition, CLIAdapterId } from "@/config/cliAdapters";
import { addPluginHostCompatibility } from "@/utils/pluginMentions";

function api() {
  const cli = window.freebuddy?.cli;
  if (!cli) {
    throw new Error(i18next.t("errors.cliBridgeUnavailable"));
  }
  return cli;
}

export const cliClient = {
  isAvailable(): boolean {
    return Boolean(window.freebuddy?.cli);
  },

  listAdapters(): Promise<CLIAdapterDefinition[]> {
    return api().listAdapters();
  },

  listOverrides(): Promise<CLIExecutorOverride[]> {
    return api().listOverrides();
  },
  upsertOverride(o: CLIExecutorOverride): Promise<void> {
    return api().upsertOverride(o);
  },
  resetOverride(id: string): Promise<void> {
    return api().resetOverride(id);
  },

  listRuntimes(): Promise<CliRuntime[]> {
    return api().listRuntimes();
  },
  codexUsage(): Promise<CodexUsageResult> {
    return api().codexUsage();
  },
  usageSummary(period: AgentUsagePeriod = "all"): Promise<AgentUsageSummary> {
    return api().usageSummary(period);
  },
  refreshUsage(period: AgentUsagePeriod = "all"): Promise<AgentUsageSummary> {
    return api().refreshUsage(period);
  },
  cursorUsageStatus(): Promise<CursorUsageStatus> {
    return api().cursorUsageStatus();
  },
  connectCursorUsage(input: CursorUsageConnectInput): Promise<CursorUsageStatus> {
    return api().connectCursorUsage(input);
  },
  disconnectCursorUsage(): Promise<CursorUsageStatus> {
    return api().disconnectCursorUsage();
  },
  openCursorUsageSettings(): Promise<void> {
    return api().openCursorUsageSettings();
  },
  probeAuthentication(args: CliAuthControlArgs): Promise<CliAuthProbeResult> {
    return api().probeAuthentication(args);
  },
  logout(args: CliAuthControlArgs): Promise<void> {
    return api().logout(args);
  },
  check(
    adapter: string,
    binary?: string,
    env?: Record<string, string>,
    runtimeAdapter?: string
  ): Promise<CliCheckResult> {
    return api().check(adapter, binary, env, runtimeAdapter);
  },
  install(adapter: string, command: string): Promise<CliInstallResult> {
    return api().install(adapter, command);
  },
  installStream(
    adapter: string,
    command: string,
    cb: (event: CliInstallEvent) => void
  ): () => void {
    return api().installStream(adapter, command, cb);
  },

  run(args: CliRunArgs): Promise<{ sessionId: string }> {
    return api().run({
      ...args,
      prompt: addPluginHostCompatibility(args.prompt, args.adapter)
    });
  },
  getCachedSessionConfigOptions(
    args: SessionConfigProbeInput
  ): Promise<SessionConfigOption[]> {
    return api().getCachedSessionConfigOptions(args);
  },
  inspectSessionConfigOptions(
    args: SessionConfigProbeInput
  ): Promise<SessionConfigOption[]> {
    return api().inspectSessionConfigOptions(args);
  },
  kill(sessionId: string): Promise<boolean> {
    return api().kill(sessionId);
  },
  permissionDecision(args: {
    sessionId: string;
    requestId: string;
    outcome: "selected" | "cancelled";
    optionId?: string;
  }): Promise<boolean> {
    return api().permissionDecision(args);
  },
  authenticationDecision(args: {
    sessionId: string;
    requestId: string;
    outcome: "selected" | "cancelled";
    methodId?: string;
  }): Promise<boolean> {
    return api().authenticationDecision(args);
  },
  authenticationTerminalInput(args: {
    sessionId: string;
    requestId: string;
    data: string;
  }): Promise<boolean> {
    return api().authenticationTerminalInput(args);
  },
  authenticationTerminalCancel(args: {
    sessionId: string;
    requestId: string;
  }): Promise<boolean> {
    return api().authenticationTerminalCancel(args);
  },

  listTasks(args?: CliTaskListArgs): Promise<CliTaskRow[]> {
    return api().listTasks(args);
  },
  getTask(id: string): Promise<CliTaskRow | undefined> {
    return api().getTask(id);
  },
  readTaskLog(args: {
    taskId: string;
    startLine?: number;
    limit?: number;
    maxBytes?: number;
  }): Promise<CliTaskLogPage> {
    return api().readTaskLog(args);
  },

  getToolSession(
    agentId: string,
    workspacePath: string
  ): Promise<ToolSessionRecord | undefined> {
    return api().getToolSession(agentId, workspacePath);
  },
  saveToolSession(args: {
    agentId: string;
    workspacePath: string;
    adapter: CLIAdapterId;
    sessionId: string;
    title?: string;
  }): Promise<void> {
    return api().saveToolSession(args);
  },

  listConversations(args?: ListConversationsArgs): Promise<Conversation[]> {
    return api().listConversations(args);
  },
  getConversation(id: string): Promise<Conversation | undefined> {
    return api().getConversation(id);
  },
  createConversation(input: CreateConversationInput): Promise<Conversation> {
    return api().createConversation(input);
  },
  previewHandoffBrief(input: PreviewHandoffBriefInput): Promise<PreviewHandoffBriefResult> {
    return api().previewHandoffBrief(input);
  },

  transferConversation(input: TransferConversationInput): Promise<TransferConversationResult> {
    return api().transferConversation(input);
  },
  createConversationShare(
    input: CreateConversationShareInput
  ): Promise<CreateConversationShareResult> {
    return api().createConversationShare(input);
  },
  attachConversationShares(
    input: AttachConversationSharesInput
  ): Promise<AttachConversationSharesResult> {
    return api().attachConversationShares(input);
  },
  listConversationContextReferences(
    conversationId: string
  ): Promise<ConversationContextReference[]> {
    return api().listConversationContextReferences(conversationId);
  },
  removeConversationContextReference(input: {
    targetConversationId: string;
    referenceId: string;
  }): Promise<ConversationContextReference[]> {
    return api().removeConversationContextReference(input);
  },
  renameConversation(
    id: string,
    title: string,
    titleSource?: ConversationTitleSource | null
  ): Promise<void> {
    return api().renameConversation(id, title, titleSource);
  },
  updateConversationAgentName(
    agentId: string,
    agentName: string
  ): Promise<void> {
    return api().updateConversationAgentName(agentId, agentName);
  },
  archiveConversation(id: string, archived: boolean): Promise<void> {
    return api().archiveConversation(id, archived);
  },
  deleteConversation(id: string): Promise<void> {
    return api().deleteConversation(id);
  },
  setConversationApprovalMode(
    id: string,
    approvalMode: "auto" | "ask" | null
  ): Promise<void> {
    return api().setConversationApprovalMode(id, approvalMode);
  },
  setConversationConfigOptionOverrides(
    id: string,
    overrides: Record<string, string> | null
  ): Promise<Conversation | undefined> {
    return api().setConversationConfigOptionOverrides(id, overrides);
  },
  setConversationSkills(
    id: string,
    skillIds: string[]
  ): Promise<Conversation | undefined> {
    return api().setConversationSkills(id, skillIds);
  },
  listMessages(conversationId: string): Promise<ConversationMessage[]> {
    return api().listMessages(conversationId);
  },
  listMessage(id: string): Promise<ConversationMessage | undefined> {
    return api().listMessage(id);
  },
  appendMessage(input: AppendMessageInput): Promise<ConversationMessage> {
    return api().appendMessage(input);
  },
  updateMessage(input: UpdateMessageInput): Promise<void> {
    return api().updateMessage(input);
  },
  selectDirectory(): Promise<string | null> {
    return api().selectDirectory();
  },
  searchWorkspaceFiles(
    cwd: string,
    query: string,
    limit?: number
  ): Promise<WorkspaceFileMatch[]> {
    return api().searchWorkspaceFiles(cwd, query, limit);
  },
  selectAttachments(): Promise<AttachmentCandidate[]> {
    return api().selectAttachments();
  },
  prepareAttachmentFiles(
    files: File[],
    limit?: number,
    existingPaths?: string[]
  ): Promise<PrepareAttachmentFilesResult> {
    return api().prepareAttachmentFiles(files, limit, existingPaths);
  },
  discardManagedAttachment(filePath: string): Promise<boolean> {
    return api().discardManagedAttachment(filePath);
  },
  discardManagedAttachmentIfUnreferenced(filePath: string): Promise<boolean> {
    return api().discardManagedAttachmentIfUnreferenced(filePath);
  },
  discardManagedAttachments(paths: string[]): void {
    api().discardManagedAttachments(paths);
  },
  resolveDraftEntry(cwd: string): Promise<string | null> {
    return api().resolveDraftEntry(cwd);
  },
  readDraftMarkdown(cwd: string, rel: string): Promise<string | null> {
    return api().readDraftMarkdown(cwd, rel);
  },
  openDraftExternal(url: string): Promise<boolean> {
    return api().openDraftExternal(url);
  },
  ensureAgentGuides(
    cwd: string,
    options?: { nativeDraftTools?: boolean }
  ): Promise<{ path: string; action: "created" | "updated" }[]> {
    return api().ensureAgentGuides(cwd, options);
  },

  getSetting(key: string): Promise<string | null> {
    const api = window.freebuddy;
    if (!api) return Promise.resolve(null);
    return api.settings.getSetting(key);
  },
  setSetting(key: string, value: string): Promise<void> {
    const api = window.freebuddy;
    if (!api) return Promise.resolve();
    return api.settings.setSetting(key, value);
  },

  onEvent(sessionId: string, cb: (e: CliEvent) => void): () => void {
    return api().onEvent(sessionId, cb as (e: unknown) => void);
  }
};
