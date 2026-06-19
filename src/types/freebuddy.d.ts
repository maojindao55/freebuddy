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

  interface FreebuddyApi {
    platform: string;
    versions: {
      chrome?: string;
      electron?: string;
      node?: string;
    };
    cli: FreebuddyCli;
    settings: FreebuddySettings;
    window: FreebuddyWindow;
  }

  interface Window {
    freebuddy?: FreebuddyApi;
  }
}
