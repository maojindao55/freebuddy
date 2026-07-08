import i18next from "i18next";
import type {
  CLIExecutorOverride,
  CliCheckResult,
  CliEvent,
  CliInstallResult,
  CliRunArgs,
  CliRuntime,
  CliTaskListArgs,
  CliTaskLogPage,
  CliTaskRow,
  CodexUsageResult,
  ToolSessionRecord,
  Conversation,
  ConversationMessage,
  AttachmentCandidate,
  CreateConversationInput,
  ListConversationsArgs,
  AppendMessageInput,
  UpdateMessageInput
} from "./types";
import type { CLIAdapterDefinition, CLIAdapterId } from "@/config/cliAdapters";

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
  check(
    adapter: string,
    binary?: string,
    env?: Record<string, string>,
    runtimeAdapter?: string
  ): Promise<CliCheckResult> {
    return api().check(adapter, binary, env, runtimeAdapter);
  },
  install(command: string): Promise<CliInstallResult> {
    return api().install(command);
  },
  installStream(
    command: string,
    cb: (event: { type: "stdout" | "stderr"; content: string } | { type: "done"; exitCode: number | null }) => void
  ): () => void {
    return api().installStream(command, cb);
  },

  run(args: CliRunArgs): Promise<{ sessionId: string }> {
    return api().run(args);
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
  renameConversation(id: string, title: string): Promise<void> {
    return api().renameConversation(id, title);
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
  selectAttachments(): Promise<AttachmentCandidate[]> {
    return api().selectAttachments();
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
  ensureAgentGuides(cwd: string): Promise<string[]> {
    return api().ensureAgentGuides(cwd);
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
