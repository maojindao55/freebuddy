import { ipcMain, BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { cliAdapterDefinitions } from "./adapters.js";
import { cliCheck, cliInstall, cliInstallStream, listRuntimes } from "./check.js";
import {
  listOverrides,
  upsertOverride,
  resetOverride,
  getToolSession,
  saveToolSession,
  type CLIExecutorOverride
} from "./store.js";
import {
  cliKill,
  cliRun,
  type CliRunArgs
} from "./runtime.js";
import {
  getCachedSessionConfigOptions,
  inspectSessionConfigOptions,
  type SessionConfigProbeInput
} from "./sessionConfigProbe.js";
import {
  takeAuthenticationResolver,
  takePermissionResolver
} from "./runtimeShared.js";
import {
  getTask,
  listTasks,
  readTaskLog,
  type CliTaskListArgs
} from "./tasks.js";
import {
  appendMessage,
  archiveConversation,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessage,
  listMessages,
  renameConversation,
  setConversationApprovalMode,
  setConversationConfigOptionOverrides,
  setConversationSkills,
  recoverInterruptedMessages,
  updateConversationAgentName,
  updateMessage,
  type AppendMessageInput,
  type ConversationTitleSource,
  type CreateConversationInput,
  type ListConversationsArgs,
  type UpdateMessageInput
} from "./conversations.js";
import { getSetting, setSetting, getLanguage } from "./settings.js";
import { setTelemetryEnabled, trackTelemetryEvent } from "../telemetry.js";
import { normalizeTelemetryAdapter } from "../telemetryPrivacy.js";
import {
  addFeedSource,
  deleteFeedSource,
  listFeedItems,
  listFeedSources,
  markFeedItemInterpreted,
  refreshAllFeedSources,
  refreshFeedSource,
  updateFeedSource,
  type AddFeedSourceInput,
  type UpdateFeedSourceInput
} from "./feed.js";
import {
  createInfoCard,
  deleteInfoCard,
  getInfoCardSnapshot,
  getMarketProviderConfig,
  listInfoCards,
  reorderInfoCards,
  refreshInfoCard,
  searchMarketSymbols,
  updateInfoCard
} from "./infoCards.js";
import type {
  CreateInfoCardInput,
  UpdateInfoCardInput
} from "../shared/infoCardProtocol.js";
import { parseDraftUrl, readDraftMarkdown, resolveDraftEntry } from "../draftProtocol.js";
import { resolveAttachmentFilePath } from "../freebuddyFileProtocol.js";
import { ensureAgentGuides } from "../agentGuides.js";
import {
  cleanupManagedAttachments,
  cleanupManagedAttachmentsIfUnreferenced,
  discardManagedAttachment,
  discardManagedAttachmentIfUnreferenced,
  prepareAttachmentFiles,
  type PrepareAttachmentPayload
} from "./attachments.js";
import { tMain } from "./i18n.js";
import { setApplicationMenuForLanguage } from "../menu.js";
import { registerWorkflowIpc } from "./workflowIpc.js";
import { readCodexUsage } from "./codexUsage.js";
import {
  deleteSkill,
  importSkills,
  listSkills,
  readSkillMarkdown,
  setSkillEnabled,
  setSkillTrusted
} from "./skills.js";
import {
  getSkillMarketProvider,
  installSkillFromMarket,
  isAllowedSkillMarketHomepage,
  listSkillMarketProviders,
  resolveSkillMarketHomepage,
  searchSkillMarket,
  setSkillMarketProvider
} from "./skillMarket.js";
import type { SkillMarketProviderId } from "./skillTypes.js";
import { resolveDraftToolRequest } from "../draftToolService.js";
import type { DraftToolResolution } from "../shared/draftToolProtocol.js";
import {
  logoutAcpAgent,
  probeAcpAuthentication,
  type CliAuthControlArgs
} from "./acpAuth.js";
import {
  cancelAuthenticationTerminal,
  writeAuthenticationTerminal
} from "./acpAuthTerminal.js";
import { registerScheduledTaskIpc } from "./scheduledTasks.js";
import { searchWorkspaceFiles } from "./workspaceFiles.js";
import { getDb } from "./db.js";
import { nanoid } from "nanoid";
import { extractHandoffBrief } from "./handoffBriefExtractor.js";
import {
  insertHandoffBrief,
  getHandoffBriefByTarget
} from "./handoffBriefs.js";
import type {
  HandoffBrief,
  PreviewHandoffBriefInput,
  PreviewHandoffBriefResult,
  TransferConversationInput,
  TransferConversationResult
} from "../shared/handoffTypes.js";

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

const ATTACHMENT_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "pdf",
  "txt",
  "md",
  "json",
  "csv",
  "log",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "rs",
  "go",
  "java",
  "php",
  "html",
  "css",
  "scss",
  "yaml",
  "yml",
  "toml",
  "xml",
  "sh"
];

function attachmentMimeFromExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "pdf":
      return "application/pdf";
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    default:
      return "text/plain";
  }
}

function attachmentCandidate(filePath: string) {
  const extension = path.extname(filePath).replace(/^\./, "").toLowerCase();
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    extension,
    mimeType: attachmentMimeFromExtension(extension)
  };
}

export function registerCliIpc() {
  recoverInterruptedMessages();
  ipcMain.handle("skills:list", () => listSkills());
  ipcMain.handle("skills:import", (_event, sourcePath: string) =>
    importSkills(sourcePath)
  );
  ipcMain.handle("skills:setEnabled", (_event, id: string, enabled: boolean) =>
    setSkillEnabled(id, enabled)
  );
  ipcMain.handle("skills:setTrusted", (_event, id: string, trusted: unknown) => {
    if (typeof id !== "string" || !id.trim()) return undefined;
    if (trusted !== true && trusted !== false) {
      throw new Error("skills:setTrusted requires a strict boolean");
    }
    return setSkillTrusted(id.trim(), trusted);
  });
  ipcMain.handle("skills:delete", (_event, id: string) => deleteSkill(id));
  ipcMain.handle("skills:read", (_event, id: string) => readSkillMarkdown(id));
  ipcMain.handle("skills:selectDirectory", async (event) => {
    const win = senderWindow(event);
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"]
    });
    return canceled ? null : filePaths[0] ?? null;
  });
  ipcMain.handle("skills:selectArchive", async (event) => {
    const win = senderWindow(event);
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "Skill ZIP", extensions: ["zip"] }]
    });
    return canceled ? null : filePaths[0] ?? null;
  });
  ipcMain.handle("skills:reveal", (_event, id: string) => {
    const skill = listSkills().find((entry) => entry.id === id);
    if (!skill) return false;
    shell.showItemInFolder(path.join(skill.rootPath, "SKILL.md"));
    return true;
  });
  ipcMain.handle("skills:marketProviders", () => listSkillMarketProviders());
  ipcMain.handle("skills:getMarketProvider", () => getSkillMarketProvider());
  ipcMain.handle(
    "skills:setMarketProvider",
    (_event, provider: SkillMarketProviderId) => setSkillMarketProvider(provider)
  );
  ipcMain.handle(
    "skills:searchMarket",
    (
      _event,
      args: {
        provider?: SkillMarketProviderId;
        query?: string;
        cursor?: string;
        limit?: number;
      } = {}
    ) =>
      searchSkillMarket({
        provider: args.provider,
        query: typeof args.query === "string" ? args.query.slice(0, 200) : undefined,
        cursor: typeof args.cursor === "string" ? args.cursor.slice(0, 2048) : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined
      })
  );
  ipcMain.handle("skills:installFromMarket", (_event, request: unknown) =>
    installSkillFromMarket(request)
  );
  ipcMain.handle("skills:openMarketUrl", async (_event, url: string) => {
    if (typeof url !== "string" || !isAllowedSkillMarketHomepage(url)) return false;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle(
    "skills:resolveMarketHomepage",
    (
      _event,
      args: {
        provider?: SkillMarketProviderId;
        slug?: string;
        ownerHandle?: string;
        version?: string;
        downloadsHint?: number;
      } = {}
    ) => {
      if (!args.provider || typeof args.slug !== "string") return null;
      return resolveSkillMarketHomepage({
        provider: args.provider,
        slug: args.slug.slice(0, 200),
        ownerHandle:
          typeof args.ownerHandle === "string" ? args.ownerHandle.slice(0, 200) : undefined,
        version: typeof args.version === "string" ? args.version.slice(0, 64) : undefined,
        downloadsHint:
          typeof args.downloadsHint === "number" && Number.isFinite(args.downloadsHint)
            ? args.downloadsHint
            : undefined
      });
    }
  );

  ipcMain.handle(
    "cli:searchWorkspaceFiles",
    (
      _event,
      args: { cwd?: unknown; query?: unknown; limit?: unknown } | undefined
    ) => {
      const cwd = typeof args?.cwd === "string" ? args.cwd : "";
      const query = typeof args?.query === "string" ? args.query.slice(0, 256) : "";
      const limit = typeof args?.limit === "number" ? args.limit : undefined;
      return searchWorkspaceFiles(cwd, query, limit);
    }
  );

  ipcMain.handle("cli:selectDirectory", async (event) => {
    const win = senderWindow(event);
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"]
    });
    if (canceled) return null;
    return filePaths[0] ?? null;
  });

  ipcMain.handle("cli:selectAttachments", async (event) => {
    const win = senderWindow(event);
    if (!win) return [];
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: tMain("dialog.supportedAttachments", getLanguage()), extensions: ATTACHMENT_EXTENSIONS },
        { name: tMain("dialog.allFiles", getLanguage()), extensions: ["*"] }
      ]
    });
    if (canceled) return [];
    return filePaths
      .filter((filePath) => {
        try {
          return fs.statSync(filePath).isFile();
        } catch {
          return false;
        }
      })
      .map(attachmentCandidate);
  });

  ipcMain.handle(
    "cli:prepareAttachmentFiles",
    (_e, payloads: PrepareAttachmentPayload[]) =>
      prepareAttachmentFiles(Array.isArray(payloads) ? payloads : [])
  );

  ipcMain.handle("cli:discardManagedAttachment", (_e, filePath: string) =>
    discardManagedAttachment(typeof filePath === "string" ? filePath : "")
  );

  ipcMain.handle(
    "cli:discardManagedAttachmentIfUnreferenced",
    (_e, filePath: string) =>
      discardManagedAttachmentIfUnreferenced(typeof filePath === "string" ? filePath : "")
  );

  ipcMain.on("cli:discardManagedAttachments", (_e, paths: unknown) => {
    if (!Array.isArray(paths)) return;
    cleanupManagedAttachmentsIfUnreferenced(
      paths.filter((entry): entry is string => typeof entry === "string")
    );
  });

  ipcMain.handle("cli:listAdapters", () => cliAdapterDefinitions);

  ipcMain.handle("cli:listOverrides", () => listOverrides());
  ipcMain.handle(
    "cli:upsertOverride",
    (_e, override: CLIExecutorOverride) => upsertOverride(override)
  );
  ipcMain.handle("cli:resetOverride", (_e, id: string) => resetOverride(id));

  ipcMain.handle("cli:listRuntimes", () => listRuntimes());
  ipcMain.handle("cli:codexUsage", () => readCodexUsage());
  ipcMain.handle("cli:probeAuthentication", (_e, args: CliAuthControlArgs) =>
    probeAcpAuthentication(args)
  );
  ipcMain.handle("cli:logout", (_e, args: CliAuthControlArgs) =>
    logoutAcpAgent(args)
  );
  ipcMain.handle(
    "cli:check",
    async (
      _e,
      args: {
        adapter: string;
        binary?: string;
        env?: Record<string, string>;
        runtimeAdapter?: string;
      }
    ) => cliCheck(args.adapter, args.binary, args.env, args.runtimeAdapter)
  );
  ipcMain.handle("cli:install", async (_e, args: { adapter: string; command: string }) =>
    cliInstall(args.command, args.adapter)
  );
  ipcMain.handle("cli:installStream", async (event, args: {
    adapter: string;
    command: string;
    requestId: string;
  }) =>
    cliInstallStream(
      args.command,
      event.sender,
      args.adapter,
      args.requestId
    )
  );

  ipcMain.handle("cli:run", async (event, args: CliRunArgs) => {
    const win = senderWindow(event);
    if (!win) throw new Error("no sender window");
    // Don't await: spawn returns immediately, streaming continues via events.
    void cliRun(win.webContents, args);
    return { sessionId: args.sessionId };
  });
  ipcMain.handle(
    "cli:getCachedSessionConfigOptions",
    (_event, args: SessionConfigProbeInput) =>
      getCachedSessionConfigOptions(args)
  );
  ipcMain.handle(
    "cli:inspectSessionConfigOptions",
    (_event, args: SessionConfigProbeInput) =>
      inspectSessionConfigOptions(args)
  );
  ipcMain.handle("cli:kill", (_e, sessionId: string) => cliKill(sessionId));
  ipcMain.handle(
    "draft-tool:resolve",
    (event, resolution: DraftToolResolution) =>
      resolveDraftToolRequest(event.sender, resolution)
  );

  ipcMain.handle(
    "cli:permissionDecision",
    (
      _e,
      args: {
        sessionId: string;
        requestId: string;
        outcome: "selected" | "cancelled";
        optionId?: string;
      }
    ) => {
      const resolver = takePermissionResolver(args.sessionId, args.requestId);
      if (!resolver) return false;
      if (args.outcome === "selected" && args.optionId) {
        resolver({ outcome: "selected", optionId: args.optionId });
      } else {
        resolver({ outcome: "cancelled" });
      }
      return true;
    }
  );

  ipcMain.handle(
    "cli:authenticationDecision",
    (
      _e,
      args: {
        sessionId: string;
        requestId: string;
        outcome: "selected" | "cancelled";
        methodId?: string;
      }
    ) => {
      const resolver = takeAuthenticationResolver(args.sessionId, args.requestId);
      if (!resolver) return false;
      if (args.outcome === "selected" && args.methodId) {
        resolver({ outcome: "selected", methodId: args.methodId });
      } else {
        resolver({ outcome: "cancelled" });
      }
      return true;
    }
  );

  ipcMain.handle(
    "cli:authenticationTerminalInput",
    (_e, args: { sessionId: string; requestId: string; data: string }) =>
      writeAuthenticationTerminal(args.sessionId, args.requestId, args.data)
  );
  ipcMain.handle(
    "cli:authenticationTerminalCancel",
    (_e, args: { sessionId: string; requestId: string }) =>
      cancelAuthenticationTerminal(args.sessionId, args.requestId)
  );

  ipcMain.handle("cli:listTasks", (_e, args: CliTaskListArgs = {}) =>
    listTasks(args)
  );
  ipcMain.handle("cli:getTask", (_e, id: string) => getTask(id));
  ipcMain.handle(
    "cli:readTaskLog",
    (_e, args: { taskId: string; startLine?: number; limit?: number; maxBytes?: number }) =>
      readTaskLog(args.taskId, args)
  );

  ipcMain.handle(
    "cli:getToolSession",
    (_e, args: { agentId: string; workspacePath: string }) =>
      getToolSession(args.agentId, args.workspacePath)
  );
  ipcMain.handle(
    "cli:saveToolSession",
    (
      _e,
      args: {
        agentId: string;
        workspacePath: string;
        adapter: string;
        sessionId: string;
        title?: string;
      }
    ) =>
      saveToolSession(
        args.agentId,
        args.workspacePath,
        args.adapter,
        args.sessionId,
        args.title
      )
  );

  ipcMain.handle("cli:resolveDraftEntry", (_e, cwd: string) =>
    resolveDraftEntry(cwd ?? "")
  );

  ipcMain.handle(
    "cli:readDraftMarkdown",
    (_e, args: { cwd?: string; rel?: string }) =>
      readDraftMarkdown(args?.cwd ?? "", args?.rel ?? "")
  );

  ipcMain.handle("cli:openDraftExternal", async (_e, url: string) => {
    if (!url) return false;
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    if (url.startsWith("freebuddy-file://")) {
      const filePath = resolveAttachmentFilePath(url);
      await shell.openExternal(pathToFileURL(filePath).toString());
      return true;
    }
    if (!url.startsWith("freebuddy-draft://")) return false;
    const { root, rel } = parseDraftUrl(url);
    const filePath = path.resolve(root, rel);
    if (!filePath.startsWith(root + path.sep) && filePath !== root) return false;
    await shell.openExternal(pathToFileURL(filePath).toString());
    return true;
  });

  ipcMain.handle(
    "cli:ensureAgentGuides",
    (
      _e,
      input: { cwd?: string; options?: { nativeDraftTools?: boolean } } | string
    ) =>
      typeof input === "string"
        ? ensureAgentGuides(input)
        : ensureAgentGuides(input?.cwd ?? "", input?.options)
  );

  // ---- Conversations -----------------------------------------------------

  ipcMain.handle("cli:listConversations", (_e, args: ListConversationsArgs = {}) =>
    listConversations(args)
  );
  ipcMain.handle("cli:getConversation", (_e, id: string) => getConversation(id));
  ipcMain.handle(
    "cli:createConversation",
    (_e, input: CreateConversationInput) => {
      const conversation = createConversation(input);
      trackTelemetryEvent("conversation_created", {
        adapter: normalizeTelemetryAdapter(input.adapter),
        has_workspace: Boolean(input.cwd),
        approval_mode: input.approvalMode ?? "default"
      });
      return conversation;
    }
  );
  ipcMain.handle(
    "cli:previewHandoffBrief",
    (_e, input: PreviewHandoffBriefInput): PreviewHandoffBriefResult => {
      const conversation = getConversation(input.sourceConversationId);
      if (!conversation) {
        return { brief: null, warning: "brief_extraction_failed" };
      }
      const messages = listMessages(input.sourceConversationId);
      try {
        return { brief: extractHandoffBrief({ conversation, messages }) };
      } catch {
        return { brief: null, warning: "brief_extraction_failed" };
      }
    }
  );
  ipcMain.handle(
    "cli:getHandoffBriefByTarget",
    (_e, targetConversationId: string) =>
      getHandoffBriefByTarget(targetConversationId)
  );
  ipcMain.handle(
    "cli:transferConversation",
    (_e, input: TransferConversationInput): TransferConversationResult => {
      const source = getConversation(input.sourceConversationId);
      if (!source) {
        throw new Error("Source conversation not found");
      }
      const messages = listMessages(input.sourceConversationId);

      let brief: HandoffBrief | null = null;
      try {
        brief = extractHandoffBrief({ conversation: source, messages });
      } catch {
        brief = null;
      }

      let briefId: string | null = null;
      const txResult = getDb().transaction(() => {
        if (brief) {
          briefId = nanoid();
          insertHandoffBrief({
            id: briefId,
            sourceConversationId: source.id,
            targetConversationId: input.targetConversationId,
            sourceAgentId: source.agentId,
            sourceAgentName: source.agentName,
            sourceAdapter: source.adapter,
            brief,
            sourceMessageCount: messages.length,
            sourceLastMessageId: messages[messages.length - 1]?.id
          });
        }
        const conversation = createConversation({
          id: input.targetConversationId,
          title: source.title,
          agentId: input.targetAgentId,
          agentName: input.targetAgentName,
          adapter: input.targetAdapter,
          cwd: input.cwd ?? source.cwd,
          skillIds: [],
          titleSource: "default",
          sourceConversationId: source.id,
          sourceAgentId: source.agentId,
          sourceAgentName: source.agentName,
          sourceAdapter: source.adapter,
          sourceBriefId: briefId ?? undefined
        });
        return { conversation };
      })();

      return {
        conversation: txResult.conversation,
        briefId,
        seedPrompt: buildSeedPrompt(source, brief),
        warning: brief ? undefined : "brief_extraction_failed"
      };
    }
  );
  ipcMain.handle(
    "cli:renameConversation",
    (
      _e,
      args: {
        id: string;
        title: string;
        titleSource?: ConversationTitleSource | null;
      }
    ) => renameConversation(args.id, args.title, args.titleSource)
  );
  ipcMain.handle(
    "cli:updateConversationAgentName",
    (_e, args: { agentId: string; agentName: string }) =>
      updateConversationAgentName(args.agentId, args.agentName)
  );
  ipcMain.handle(
    "cli:archiveConversation",
    (_e, args: { id: string; archived: boolean }) =>
      archiveConversation(args.id, args.archived)
  );
  ipcMain.handle("cli:deleteConversation", (_e, id: string) =>
    deleteConversation(id)
  );

  ipcMain.handle(
    "cli:setConversationApprovalMode",
    (_e, args: { id: string; approvalMode: "auto" | "ask" | null }) =>
      setConversationApprovalMode(args.id, args.approvalMode)
  );

  ipcMain.handle(
    "cli:setConversationConfigOptionOverrides",
    (
      _e,
      args: { id: string; overrides: Record<string, string> | null }
    ) => {
      setConversationConfigOptionOverrides(args.id, args.overrides);
      return getConversation(args.id);
    }
  );
  ipcMain.handle(
    "cli:setConversationSkills",
    (_e, args: { id: string; skillIds: string[] }) =>
      setConversationSkills(args.id, Array.isArray(args.skillIds) ? args.skillIds : [])
  );

  ipcMain.handle("cli:listMessages", (_e, conversationId: string) =>
    listMessages(conversationId)
  );
  ipcMain.handle("cli:listMessage", (_e, id: string) =>
    listMessage(id)
  );
  ipcMain.handle("cli:appendMessage", (_e, input: AppendMessageInput) =>
    appendMessage(input)
  );
  ipcMain.handle("cli:updateMessage", (_e, input: UpdateMessageInput) =>
    updateMessage(input)
  );

  ipcMain.handle("settings:get", (_e, key: string) => getSetting(key));
  ipcMain.handle("settings:set", (_e, args: { key: string; value: string }) => {
    if (args.key === "telemetry.enabled") {
      setTelemetryEnabled(args.value === "true");
      return;
    }
    setSetting(args.key, args.value);
    if (
      args.key === "language" &&
      (args.value === "system" || args.value === "en" || args.value === "zh-CN")
    ) {
      setApplicationMenuForLanguage(getLanguage());
    }
  });

  ipcMain.handle("feed:listSources", () => listFeedSources());
  ipcMain.handle("feed:addSource", (_e, input: AddFeedSourceInput) =>
    addFeedSource(input)
  );
  ipcMain.handle("feed:updateSource", (_e, input: UpdateFeedSourceInput) =>
    updateFeedSource(input)
  );
  ipcMain.handle("feed:deleteSource", (_e, id: string) =>
    deleteFeedSource(id)
  );
  ipcMain.handle("feed:listItems", (_e, args: { limit?: number; offset?: number } = {}) =>
    listFeedItems(args)
  );
  ipcMain.handle("feed:refreshSource", (_e, id: string) =>
    refreshFeedSource(id)
  );
  ipcMain.handle("feed:refreshAll", () => refreshAllFeedSources());
  ipcMain.handle("feed:markInterpreted", (_e, id: string) =>
    markFeedItemInterpreted(id)
  );

  ipcMain.handle("infoCards:list", () => listInfoCards());
  ipcMain.handle("infoCards:create", (_e, input: CreateInfoCardInput) =>
    createInfoCard(input)
  );
  ipcMain.handle("infoCards:update", (_e, input: UpdateInfoCardInput) =>
    updateInfoCard(input)
  );
  ipcMain.handle("infoCards:delete", (_e, id: string) => deleteInfoCard(id));
  ipcMain.handle("infoCards:reorder", (_e, ids: string[]) =>
    reorderInfoCards(ids)
  );
  ipcMain.handle("infoCards:snapshot", (_e, id: string) =>
    getInfoCardSnapshot(id)
  );
  ipcMain.handle("infoCards:refresh", (_e, id: string, timeZone?: string) =>
    refreshInfoCard(id, timeZone)
  );
  ipcMain.handle("infoCards:marketProvider", () => getMarketProviderConfig());
  ipcMain.handle("infoCards:searchMarketSymbols", (_e, query: string) =>
    searchMarketSymbols(query)
  );

  registerWorkflowIpc();
  registerScheduledTaskIpc();
}

function buildSeedPrompt(
  source: { agentName: string; adapter: string },
  brief: HandoffBrief | null
): string {
  if (!brief) {
    return `Continuing a task transferred from ${source.agentName} (${source.adapter}). ` +
      `No prior context is available. Ask the user what they'd like to focus on.`;
  }
  return `Continuing a task transferred from ${source.agentName} (${source.adapter}).\n` +
    `Call the \`freebuddy-context.read_handoff_brief\` tool now to load the ` +
    `handoff (original goal, recent messages, file changes), then ask me ` +
    `what you'd like to focus on first.`;
}
