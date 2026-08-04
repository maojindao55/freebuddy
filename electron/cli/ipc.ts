import { ipcMain, BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from "electron";
import { registerHandler } from "../invokeRegistry.js";
import { appendRendererLogEntries } from "../debugLog.js";
import { buildDebugLogPreview, exportDebugLogs } from "../debugLogExport.js";
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
  channelName,
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
  callerCanAccessMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessage,
  listMessages,
  renameConversation,
  requireOwnedConversation,
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
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  resolveWorkspaceRootsForConversation,
  updateProject,
  type ProjectInput
} from "./projects.js";
import { getSetting, setSetting, getLanguage } from "./settings.js";
import { getCallerUserId } from "./callerContext.js";
import {
  callerCanControlSession,
  recordSessionOwner,
  clearSessionOwner
} from "./sessionOwners.js";
import { isolateRemoteCwdForCaller } from "./remoteWorkspaceAccess.js";
import { importCodexSession } from "./codexRolloutImport.js";
import { safeSendToWebContents } from "./ipcSend.js";
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
import { getDataDir, getDb } from "./db.js";
import { nanoid } from "nanoid";
import { extractHandoffBrief } from "./handoffBriefExtractor.js";
import { getHandoffBriefByTarget } from "./handoffBriefs.js";
import type {
  AttachConversationSharesInput,
  AttachConversationSharesResult,
  CreateConversationShareInput,
  CreateConversationShareResult,
  HandoffBrief,
  HandoffTranscriptRef,
  PreviewHandoffBriefInput,
  PreviewHandoffBriefResult,
  TransferConversationInput,
  TransferConversationResult
} from "../shared/handoffTypes.js";
import {
  createHandoffTranscriptSnapshot,
  deleteHandoffTranscriptSnapshot
} from "../shared/handoffTranscript.js";
import {
  attachConversationSharesFromText,
  buildTransferSeedPrompt,
  createConversationShareToken,
  deleteUnreferencedConversationContextSnapshots,
  insertConversationContextReference,
  insertConversationContextSnapshot,
  listResolvedConversationContextPayloads,
  listConversationContextReferences,
  conversationContextPromptPrefix,
  removeConversationContextReference
} from "./conversationContext.js";
import { applyAgentLanguagePreference } from "./agentLanguage.js";
import {
  connectCursorUsage,
  disconnectCursorUsage,
  getCursorUsageStatus,
  reconcileAgentUsage
} from "./usageReconciler.js";
import { getAgentUsageSummary } from "./usageStore.js";
import { normalizeAgentUsagePeriod } from "./usageCore.js";
import {
  addNativePluginMarketplace,
  installNativePlugin,
  listNativePlugins,
  removeNativePluginMarketplace,
  uninstallNativePlugin,
  updateNativePlugin,
  updateNativePluginMarketplace,
  type NativePluginAgent,
  type NativePluginScope
} from "./nativePlugins.js";

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function nativePluginAgent(value: unknown): NativePluginAgent {
  if (value === "codex" || value === "claude") return value;
  throw new Error("Unsupported plugin agent");
}

function nativePluginScope(value: unknown): NativePluginScope | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "user" || value === "project" || value === "local" || value === "managed") {
    return value;
  }
  throw new Error("Unsupported plugin scope");
}

function requiredPluginString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredProjectId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Project id is required");
  }
  return value.trim();
}

function parseProjectInput(input: unknown): ProjectInput {
  if (!input || typeof input !== "object") {
    throw new Error("Project input is required");
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.name !== "string") {
    throw new Error("Project name is required");
  }
  if (typeof raw.primaryPath !== "string") {
    throw new Error("primaryPath is required");
  }
  if (
    !Array.isArray(raw.folders) ||
    !raw.folders.every((folder) => typeof folder === "string")
  ) {
    throw new Error("folders must be an array of strings");
  }
  return {
    name: raw.name,
    folders: raw.folders,
    primaryPath: raw.primaryPath
  };
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
  "sh",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx"
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
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
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

const CONVERSATIONS_CHANGED_CHANNEL = "conversations://changed";

function notifyConversationsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeSendToWebContents(win.webContents, CONVERSATIONS_CHANGED_CHANNEL, {
      at: Date.now()
    });
  }
}

export function registerCliIpc() {
  recoverInterruptedMessages();
  registerHandler("plugins:list", (_event, agent: unknown) =>
    listNativePlugins(nativePluginAgent(agent))
  );
  registerHandler("plugins:install", (_event, args: Record<string, unknown> = {}) =>
    installNativePlugin(
      nativePluginAgent(args.agent),
      requiredPluginString(args.pluginId, "Plugin id"),
      nativePluginScope(args.scope)
    )
  );
  registerHandler("plugins:update", (_event, args: Record<string, unknown> = {}) =>
    updateNativePlugin(
      nativePluginAgent(args.agent),
      requiredPluginString(args.pluginId, "Plugin id"),
      typeof args.marketplace === "string" ? args.marketplace : undefined,
      nativePluginScope(args.scope)
    )
  );
  registerHandler("plugins:uninstall", (_event, args: Record<string, unknown> = {}) =>
    uninstallNativePlugin(
      nativePluginAgent(args.agent),
      requiredPluginString(args.pluginId, "Plugin id"),
      nativePluginScope(args.scope)
    )
  );
  registerHandler("plugins:addMarketplace", (_event, args: Record<string, unknown> = {}) =>
    addNativePluginMarketplace(
      nativePluginAgent(args.agent),
      requiredPluginString(args.source, "Marketplace source"),
      typeof args.ref === "string" ? args.ref : undefined,
      nativePluginScope(args.scope)
    )
  );
  registerHandler("plugins:updateMarketplace", (_event, args: Record<string, unknown> = {}) =>
    updateNativePluginMarketplace(
      nativePluginAgent(args.agent),
      typeof args.marketplace === "string" ? args.marketplace : undefined
    )
  );
  registerHandler("plugins:removeMarketplace", (_event, args: Record<string, unknown> = {}) =>
    removeNativePluginMarketplace(
      nativePluginAgent(args.agent),
      requiredPluginString(args.marketplace, "Marketplace")
    )
  );
  registerHandler("skills:list", () => listSkills());
  registerHandler("skills:import", (_event, sourcePath: string) =>
    importSkills(sourcePath)
  );
  registerHandler("skills:setEnabled", (_event, id: string, enabled: boolean) =>
    setSkillEnabled(id, enabled)
  );
  registerHandler("skills:setTrusted", (_event, id: string, trusted: unknown) => {
    if (typeof id !== "string" || !id.trim()) return undefined;
    if (trusted !== true && trusted !== false) {
      throw new Error("skills:setTrusted requires a strict boolean");
    }
    return setSkillTrusted(id.trim(), trusted);
  });
  registerHandler("skills:delete", (_event, id: string) => deleteSkill(id));
  registerHandler("skills:read", (_event, id: string) => readSkillMarkdown(id));
  registerHandler("skills:selectDirectory", async (event) => {
    const win = senderWindow(event);
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"]
    });
    return canceled ? null : filePaths[0] ?? null;
  });
  registerHandler("skills:selectArchive", async (event) => {
    const win = senderWindow(event);
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "Skill ZIP", extensions: ["zip"] }]
    });
    return canceled ? null : filePaths[0] ?? null;
  });
  registerHandler("skills:reveal", (_event, id: string) => {
    const skill = listSkills().find((entry) => entry.id === id);
    if (!skill) return false;
    shell.showItemInFolder(path.join(skill.rootPath, "SKILL.md"));
    return true;
  });
  registerHandler("shell:showItemInFolder", (_event, targetPath: unknown) => {
    if (typeof targetPath !== "string" || !targetPath.trim()) return false;
    const resolved = path.resolve(targetPath.trim());
    if (!path.isAbsolute(resolved)) return false;
    if (!fs.existsSync(resolved)) return false;
    shell.showItemInFolder(resolved);
    return true;
  });
  registerHandler("skills:marketProviders", () => listSkillMarketProviders());
  registerHandler("skills:getMarketProvider", () => getSkillMarketProvider());
  registerHandler(
    "skills:setMarketProvider",
    (_event, provider: SkillMarketProviderId) => setSkillMarketProvider(provider)
  );
  registerHandler(
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
  registerHandler("skills:installFromMarket", (_event, request: unknown) =>
    installSkillFromMarket(request)
  );
  registerHandler("skills:openMarketUrl", async (_event, url: string) => {
    if (typeof url !== "string" || !isAllowedSkillMarketHomepage(url)) return false;
    await shell.openExternal(url);
    return true;
  });
  registerHandler(
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

  registerHandler(
    "cli:searchWorkspaceFiles",
    (
      _event,
      args:
        | { cwd?: unknown; query?: unknown; limit?: unknown; roots?: unknown }
        | undefined
    ) => {
      const cwd = typeof args?.cwd === "string" ? args.cwd : "";
      const query = typeof args?.query === "string" ? args.query.slice(0, 256) : "";
      const limit = typeof args?.limit === "number" ? args.limit : undefined;
      const roots = Array.isArray(args?.roots)
        ? args.roots.filter((entry): entry is string => typeof entry === "string")
        : undefined;
      return searchWorkspaceFiles(cwd, query, limit, roots);
    }
  );

  registerHandler("cli:selectDirectory", async (event) => {
    const win = senderWindow(event);
    if (!win) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"]
    });
    if (canceled) return null;
    return filePaths[0] ?? null;
  });

  registerHandler("cli:selectAttachments", async (event) => {
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

  registerHandler(
    "cli:prepareAttachmentFiles",
    (_e, payloads: PrepareAttachmentPayload[]) =>
      prepareAttachmentFiles(Array.isArray(payloads) ? payloads : [])
  );

  registerHandler("cli:discardManagedAttachment", (_e, filePath: string) =>
    discardManagedAttachment(typeof filePath === "string" ? filePath : "")
  );

  registerHandler(
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

  registerHandler("cli:listAdapters", () => cliAdapterDefinitions);
  registerHandler("debugLog:write", (_event, entries: unknown) => {
    appendRendererLogEntries(entries);
  });
  registerHandler("debugLogs:preview", (_event, mode: unknown, conversationId: unknown) =>
    buildDebugLogPreview(
      mode === "full" ? "full" : "standard",
      typeof conversationId === "string" ? conversationId : undefined
    )
  );
  registerHandler("debugLogs:export", (event, mode: unknown, conversationId: unknown) => {
    const win = event.sender ? BrowserWindow.fromWebContents(event.sender) : null;
    if (!win) throw new Error("no window");
    return exportDebugLogs(
      win,
      mode === "full" ? "full" : "standard",
      typeof conversationId === "string" ? conversationId : undefined
    );
  });
  registerHandler("cli:usageSummary", (_event, rawPeriod: unknown) => {
    const period = normalizeAgentUsagePeriod(rawPeriod);
    return getAgentUsageSummary(period);
  });
  registerHandler("cli:refreshUsage", async (_event, rawPeriod: unknown) => {
    const period = normalizeAgentUsagePeriod(rawPeriod);
    await reconcileAgentUsage(period);
    return getAgentUsageSummary(period);
  });
  registerHandler("cli:cursorUsageStatus", () => getCursorUsageStatus());
  registerHandler("cli:connectCursorUsage", (_event, rawInput: unknown) => {
    const input = rawInput && typeof rawInput === "object"
      ? rawInput as Record<string, unknown>
      : {};
    return connectCursorUsage({
      token: typeof input.token === "string" ? input.token : "",
      accountName: typeof input.accountName === "string" ? input.accountName : undefined
    });
  });
  registerHandler("cli:disconnectCursorUsage", () => disconnectCursorUsage());
  registerHandler("cli:openCursorUsageSettings", () =>
    shell.openExternal("https://www.cursor.com/settings")
  );

  registerHandler("cli:listOverrides", () => listOverrides());
  registerHandler(
    "cli:upsertOverride",
    (_e, override: CLIExecutorOverride) => upsertOverride(override)
  );
  registerHandler("cli:resetOverride", (_e, id: string) => resetOverride(id));

  registerHandler("cli:listRuntimes", () => listRuntimes());
  registerHandler("cli:codexUsage", () => readCodexUsage());
  registerHandler("cli:probeAuthentication", (_e, args: CliAuthControlArgs) =>
    probeAcpAuthentication(args)
  );
  registerHandler("cli:logout", (_e, args: CliAuthControlArgs) =>
    logoutAcpAgent(args)
  );
  registerHandler(
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
  registerHandler("cli:install", async (_e, args: { adapter: string; command: string }) =>
    cliInstall(args.command, args.adapter)
  );
  registerHandler("cli:installStream", async (event, args: {
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

  registerHandler("cli:run", async (event, args: CliRunArgs) => {
    const win = senderWindow(event);
    if (!win) throw new Error("no sender window");
    const conversation = args.conversationId
      ? requireOwnedConversation(args.conversationId)
      : undefined;
    if (args.conversationId && !conversation) {
      throw new Error("conversation_not_found");
    }
    recordSessionOwner(args.sessionId, conversation?.ownerId ?? getCallerUserId());
    const {
      contextReferences: _rendererContextReferences,
      ...rendererArgs
    } = args;
    // A network caller cannot swap the cwd after a conversation was created.
    // The persisted conversation points at that user's managed clone.
    let runArgs: CliRunArgs = {
      ...rendererArgs,
      cwd: conversation?.cwd ?? rendererArgs.cwd
    };
    const resolvedWorkspaceRoots = conversation
      ? resolveWorkspaceRootsForConversation(conversation)
      : resolveWorkspaceRootsForConversation({
          cwd: runArgs.cwd,
          projectId: undefined
        });
    const workspaceRoots = (
      await Promise.all(
        resolvedWorkspaceRoots.map((root) => isolateRemoteCwdForCaller(root))
      )
    ).filter((root): root is string => Boolean(root));
    // Authoritative roots always overwrite renderer workspaceRoots (empty clears untrusted roots).
    runArgs = { ...runArgs, workspaceRoots };
    const contextReferences = args.conversationId
      ? listResolvedConversationContextPayloads(args.conversationId)
      : [];
    if (contextReferences.length > 0) {
      runArgs = {
        ...runArgs,
        prompt: applyAgentLanguagePreference(
          `${conversationContextPromptPrefix(contextReferences)}` +
            rendererArgs.prompt,
          getLanguage()
        ),
        contextReferences
      };
    }
    // Don't await: spawn returns immediately, streaming continues via events.
    void cliRun(win.webContents, runArgs).catch((error) => {
      const message = (error as Error)?.message || String(error);
      console.error(`[cli] run failed for ${args.sessionId}:`, error);
      safeSendToWebContents(
        win.webContents,
        channelName(args.sessionId),
        { type: "error", message }
      );
      safeSendToWebContents(
        win.webContents,
        channelName(args.sessionId),
        { type: "done", exitCode: -1 }
      );
      clearSessionOwner(args.sessionId);
    });
    return { sessionId: args.sessionId };
  });
  registerHandler(
    "cli:getCachedSessionConfigOptions",
    (_event, args: SessionConfigProbeInput) =>
      getCachedSessionConfigOptions(args)
  );
  registerHandler(
    "cli:inspectSessionConfigOptions",
    (_event, args: SessionConfigProbeInput) =>
      inspectSessionConfigOptions(args)
  );
  registerHandler("cli:kill", (_e, sessionId: string) => {
    if (!callerCanControlSession(sessionId)) return false;
    const killed = cliKill(sessionId);
    // A live run clears its owner after broadcasting its terminal event.
    // Clean up here only when there is no process that can do so.
    if (!killed) clearSessionOwner(sessionId);
    return killed;
  });
  registerHandler(
    "draft-tool:resolve",
    (event, resolution: DraftToolResolution) =>
      resolveDraftToolRequest(event.sender, resolution)
  );

  registerHandler(
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
      if (!callerCanControlSession(args.sessionId)) return false;
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

  registerHandler(
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
      if (!callerCanControlSession(args.sessionId)) return false;
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

  registerHandler(
    "cli:authenticationTerminalInput",
    (_e, args: { sessionId: string; requestId: string; data: string }) =>
      callerCanControlSession(args.sessionId)
        ? writeAuthenticationTerminal(args.sessionId, args.requestId, args.data)
        : false
  );
  registerHandler(
    "cli:authenticationTerminalCancel",
    (_e, args: { sessionId: string; requestId: string }) =>
      callerCanControlSession(args.sessionId)
        ? cancelAuthenticationTerminal(args.sessionId, args.requestId)
        : false
  );

  registerHandler("cli:listTasks", (_e, args: CliTaskListArgs = {}) =>
    listTasks(args)
  );
  registerHandler("cli:getTask", (_e, id: string) => getTask(id));
  registerHandler(
    "cli:readTaskLog",
    (_e, args: { taskId: string; startLine?: number; limit?: number; maxBytes?: number }) =>
      readTaskLog(args.taskId, args)
  );

  registerHandler(
    "cli:getToolSession",
    (_e, args: { agentId: string; workspacePath: string }) =>
      getToolSession(args.agentId, args.workspacePath)
  );
  registerHandler(
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

  registerHandler("cli:resolveDraftEntry", (_e, cwd: string) =>
    resolveDraftEntry(cwd ?? "")
  );

  registerHandler(
    "cli:readDraftMarkdown",
    (_e, args: { cwd?: string; rel?: string }) =>
      readDraftMarkdown(args?.cwd ?? "", args?.rel ?? "")
  );

  registerHandler("cli:openDraftExternal", async (_e, url: string) => {
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

  registerHandler(
    "cli:ensureAgentGuides",
    (
      _e,
      input: { cwd?: string; options?: { nativeDraftTools?: boolean } } | string
    ) =>
      typeof input === "string"
        ? ensureAgentGuides(input)
        : ensureAgentGuides(input?.cwd ?? "", input?.options)
  );

  // ---- Projects ----------------------------------------------------------

  registerHandler("cli:listProjects", () => listProjects());
  registerHandler("cli:getProject", (_e, id: unknown) =>
    getProject(requiredProjectId(id))
  );
  registerHandler("cli:createProject", (_e, input: unknown) =>
    createProject(parseProjectInput(input))
  );
  registerHandler("cli:updateProject", (_e, args: unknown) => {
    if (!args || typeof args !== "object") {
      throw new Error("Project update args are required");
    }
    const raw = args as Record<string, unknown>;
    const id = requiredProjectId(raw.id);
    return updateProject(id, parseProjectInput(raw));
  });
  registerHandler("cli:deleteProject", (_e, id: unknown) => {
    deleteProject(requiredProjectId(id));
    return { ok: true as const };
  });

  // ---- Conversations -----------------------------------------------------

  registerHandler("cli:listConversations", (_e, args: ListConversationsArgs = {}) =>
    listConversations(args)
  );
  registerHandler("cli:getConversation", (_e, id: string) =>
    requireOwnedConversation(id)
  );
  registerHandler(
    "cli:createConversation",
    async (_e, input: CreateConversationInput) => {
      const isolatedCwd = await isolateRemoteCwdForCaller(input.cwd);
      const conversation = createConversation({ ...input, cwd: isolatedCwd });
      trackTelemetryEvent("conversation_created", {
        adapter: normalizeTelemetryAdapter(input.adapter),
        has_workspace: Boolean(isolatedCwd),
        approval_mode: input.approvalMode ?? "default"
      });
      notifyConversationsChanged();
      return conversation;
    }
  );
  registerHandler(
    "cli:importCodexSession",
    async (_e, sessionId: string) => {
      const result = importCodexSession(sessionId);
      trackTelemetryEvent("codex_session_imported", {
        created: result.created,
        turns: result.turns,
        messages: result.messages
      });
      if (result.created) notifyConversationsChanged();
      return result;
    }
  );
  registerHandler(
    "cli:previewHandoffBrief",
    (_e, input: PreviewHandoffBriefInput): PreviewHandoffBriefResult => {
      const conversation = requireOwnedConversation(input.sourceConversationId);
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
  registerHandler(
    "cli:transferConversation",
    (_e, input: TransferConversationInput): TransferConversationResult => {
      const source = requireOwnedConversation(input.sourceConversationId);
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
      if (brief) {
        briefId = nanoid();
      }
      let transcript: HandoffTranscriptRef | undefined;
      if (briefId) {
        try {
          transcript = createHandoffTranscriptSnapshot(
            getDataDir(),
            briefId,
            messages
          );
        } catch {
          transcript = undefined;
        }
      }
      let txResult: { conversation: ReturnType<typeof createConversation> };
      try {
        txResult = getDb().transaction(() => {
          // Order matters: handoff_briefs has FK target_conversation_id REFERENCES
          // conversations(id), so B must exist before the brief row is inserted.
          // conversations.source_brief_id is a plain TEXT column (no FK), so it
          // can reference a brief that doesn't exist yet.
          const conversation = createConversation({
            id: input.targetConversationId,
            title: source.title,
            agentId: input.targetAgentId,
            agentName: input.targetAgentName,
            adapter: input.targetAdapter,
            // Transfers always inherit the source workspace so referenced
            // files and the target agent's execution directory stay aligned.
            cwd: source.cwd,
            skillIds: [],
            titleSource: "default",
            sourceConversationId: source.id,
            sourceAgentId: source.agentId,
            sourceAgentName: source.agentName,
            sourceAdapter: source.adapter,
            sourceBriefId: briefId ?? undefined
          });
          if (brief && briefId) {
            insertConversationContextSnapshot({
              id: briefId,
              brief,
              sourceLastMessageId: messages[messages.length - 1]?.id,
              transcript
            });
            insertConversationContextReference({
              targetConversationId: input.targetConversationId,
              snapshotId: briefId,
              referenceType: "transfer"
            });
          }
          return { conversation };
        })();
      } catch (error) {
        deleteHandoffTranscriptSnapshot(getDataDir(), transcript?.path);
        throw error;
      }

      notifyConversationsChanged();
      return {
        conversation: txResult.conversation,
        briefId,
        seedPrompt: buildTransferSeedPrompt(source, brief),
        warning: brief ? undefined : "brief_extraction_failed"
      };
    }
  );  registerHandler(
    "cli:createConversationShare",
    (
      _e,
      input: CreateConversationShareInput
    ): CreateConversationShareResult => {
      const source = requireOwnedConversation(input.sourceConversationId);
      if (!source) throw new Error("Source conversation not found");
      const messages = listMessages(source.id);
      const brief = extractHandoffBrief({ conversation: source, messages });
      const snapshotId = nanoid();
      let transcript: HandoffTranscriptRef | undefined;
      try {
        transcript = createHandoffTranscriptSnapshot(
          getDataDir(),
          snapshotId,
          messages
        );
      } catch {
        transcript = undefined;
      }
      try {
        const link = getDb().transaction(() => {
          insertConversationContextSnapshot({
            id: snapshotId,
            brief,
            sourceLastMessageId: messages[messages.length - 1]?.id,
            transcript
          });
          return createConversationShareToken(snapshotId);
        })();
        return {
          link,
          snapshotId,
          source: brief.source,
          transcriptAvailable: Boolean(transcript),
          transcriptTruncated: transcript?.truncated ?? false
        };
      } catch (error) {
        deleteHandoffTranscriptSnapshot(getDataDir(), transcript?.path);
        throw error;
      }
    }
  );
  registerHandler(
    "cli:attachConversationShares",
    (
      _e,
      input: AttachConversationSharesInput
    ): AttachConversationSharesResult => {
      if (!requireOwnedConversation(input.targetConversationId)) {
        throw new Error("Target conversation not found");
      }
      return attachConversationSharesFromText(
        input.targetConversationId,
        input.text
      );
    }
  );
  registerHandler(
    "cli:listConversationContextReferences",
    (_e, conversationId: string) =>
      requireOwnedConversation(conversationId)
        ? listConversationContextReferences(conversationId)
        : []
  );
  registerHandler(
    "cli:removeConversationContextReference",
    (
      _e,
      input: { targetConversationId: string; referenceId: string }
    ) => {
      if (!requireOwnedConversation(input.targetConversationId)) return [];
      return removeConversationContextReference(
        input.targetConversationId,
        input.referenceId
      );
    }
  );
  registerHandler(
    "cli:renameConversation",
    (
      _e,
      args: {
        id: string;
        title: string;
        titleSource?: ConversationTitleSource | null;
      }
    ) => {
      if (!requireOwnedConversation(args.id)) return;
      renameConversation(args.id, args.title, args.titleSource);
      notifyConversationsChanged();
    }
  );
  registerHandler(
    "cli:updateConversationAgentName",
    (_e, args: { agentId: string; agentName: string }) =>
      updateConversationAgentName(args.agentId, args.agentName)
  );
  registerHandler(
    "cli:archiveConversation",
    (_e, args: { id: string; archived: boolean }) => {
      if (!requireOwnedConversation(args.id)) return;
      archiveConversation(args.id, args.archived);
      notifyConversationsChanged();
    }
  );
  registerHandler("cli:deleteConversation", (_e, id: string) => {
    if (!requireOwnedConversation(id)) return;
    const transcriptPath = getHandoffBriefByTarget(id)?.transcript?.path;
    deleteConversation(id);
    deleteHandoffTranscriptSnapshot(getDataDir(), transcriptPath);
    for (const orphanPath of deleteUnreferencedConversationContextSnapshots()) {
      deleteHandoffTranscriptSnapshot(getDataDir(), orphanPath);
    }
    notifyConversationsChanged();
  });

  registerHandler(
    "cli:setConversationApprovalMode",
    (_e, args: { id: string; approvalMode: "auto" | "ask" | null }) => {
      if (!requireOwnedConversation(args.id)) return;
      setConversationApprovalMode(args.id, args.approvalMode);
    }
  );

  registerHandler(
    "cli:setConversationConfigOptionOverrides",
    (
      _e,
      args: { id: string; overrides: Record<string, string> | null }
    ) => {
      if (!requireOwnedConversation(args.id)) return undefined;
      setConversationConfigOptionOverrides(args.id, args.overrides);
      return getConversation(args.id);
    }
  );
  registerHandler(
    "cli:setConversationSkills",
    (_e, args: { id: string; skillIds: string[] }) => {
      if (!requireOwnedConversation(args.id)) return undefined;
      return setConversationSkills(
        args.id,
        Array.isArray(args.skillIds) ? args.skillIds : []
      );
    }
  );

  registerHandler("cli:listMessages", (_e, conversationId: string) =>
    requireOwnedConversation(conversationId) ? listMessages(conversationId) : []
  );
  registerHandler("cli:listMessage", (_e, id: string) =>
    callerCanAccessMessage(id) ? listMessage(id) : undefined
  );
  registerHandler("cli:appendMessage", (_e, input: AppendMessageInput) => {
    if (!requireOwnedConversation(input.conversationId)) return undefined;
    return appendMessage(input);
  });
  registerHandler("cli:updateMessage", (_e, input: UpdateMessageInput) => {
    if (!callerCanAccessMessage(input.id)) return;
    updateMessage(input);
  });

  registerHandler("settings:get", (_e, key: string) => getSetting(key));
  registerHandler("settings:set", (_e, args: { key: string; value: string }) => {
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

  registerHandler("feed:listSources", () => listFeedSources());
  registerHandler("feed:addSource", (_e, input: AddFeedSourceInput) =>
    addFeedSource(input)
  );
  registerHandler("feed:updateSource", (_e, input: UpdateFeedSourceInput) =>
    updateFeedSource(input)
  );
  registerHandler("feed:deleteSource", (_e, id: string) =>
    deleteFeedSource(id)
  );
  registerHandler("feed:listItems", (_e, args: { limit?: number; offset?: number } = {}) =>
    listFeedItems(args)
  );
  registerHandler("feed:refreshSource", (_e, id: string) =>
    refreshFeedSource(id)
  );
  registerHandler("feed:refreshAll", () => refreshAllFeedSources());
  registerHandler("feed:markInterpreted", (_e, id: string) =>
    markFeedItemInterpreted(id)
  );

  registerHandler("infoCards:list", () => listInfoCards());
  registerHandler("infoCards:create", (_e, input: CreateInfoCardInput) =>
    createInfoCard(input)
  );
  registerHandler("infoCards:update", (_e, input: UpdateInfoCardInput) =>
    updateInfoCard(input)
  );
  registerHandler("infoCards:delete", (_e, id: string) => deleteInfoCard(id));
  registerHandler("infoCards:reorder", (_e, ids: string[]) =>
    reorderInfoCards(ids)
  );
  registerHandler("infoCards:snapshot", (_e, id: string) =>
    getInfoCardSnapshot(id)
  );
  registerHandler("infoCards:refresh", (_e, id: string, timeZone?: string) =>
    refreshInfoCard(id, timeZone)
  );
  registerHandler("infoCards:marketProvider", () => getMarketProviderConfig());
  registerHandler("infoCards:searchMarketSymbols", (_e, query: string) =>
    searchMarketSymbols(query)
  );

  registerWorkflowIpc();
  registerScheduledTaskIpc();
}
