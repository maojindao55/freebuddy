import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

import { collectPreparedAttachmentsUntilLimit, managedPathsToDiscardAfterPrepare } from "./shared/collectPreparedAttachmentsUntilLimit.js";
import type {
  DraftToolEvent,
  DraftToolResolution
} from "./shared/draftToolProtocol.js";

type CliInstallEvent =
  | { type: "stdout" | "stderr"; content: string }
  | {
      type: "done";
      exitCode: number | null;
      failureCode?:
        | "tool_missing"
        | "node_arch_mismatch"
        | "timeout"
        | "spawn_error";
      failureDetail?: string;
    };

type CliInstallWireEvent = CliInstallEvent & { requestId: string };

let cliInstallRequestSequence = 0;

function nextCliInstallRequestId(): string {
  cliInstallRequestSequence += 1;
  return `cli-install-${Date.now()}-${cliInstallRequestSequence}`;
}

const cli = {
  listAdapters: () => ipcRenderer.invoke("cli:listAdapters"),
  listOverrides: () => ipcRenderer.invoke("cli:listOverrides"),
  upsertOverride: (o: unknown) => ipcRenderer.invoke("cli:upsertOverride", o),
  resetOverride: (id: string) => ipcRenderer.invoke("cli:resetOverride", id),

  listRuntimes: () => ipcRenderer.invoke("cli:listRuntimes"),
  onRuntimeUpdated: (cb: (runtime: unknown) => void): (() => void) => {
    const channel = "cli://runtime";
    const handler = (_e: IpcRendererEvent, runtime: unknown) => cb(runtime);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  },
  codexUsage: () => ipcRenderer.invoke("cli:codexUsage"),
  probeAuthentication: (args: unknown) =>
    ipcRenderer.invoke("cli:probeAuthentication", args),
  logout: (args: unknown) => ipcRenderer.invoke("cli:logout", args),
  check: (
    adapter: string,
    binary?: string,
    env?: Record<string, string>,
    runtimeAdapter?: string
  ) => ipcRenderer.invoke("cli:check", { adapter, binary, env, runtimeAdapter }),
  install: (adapter: string, command: string) =>
    ipcRenderer.invoke("cli:install", { adapter, command }),
  installStream: (
    adapter: string,
    command: string,
    cb: (event: CliInstallEvent) => void
  ): (() => void) => {
    const channel = "cli://install";
    const requestId = nextCliInstallRequestId();
    const handler = (_e: IpcRendererEvent, payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const event = payload as CliInstallWireEvent;
      if (event.requestId !== requestId) return;
      cb(event);
    };
    ipcRenderer.on(channel, handler);
    ipcRenderer.invoke("cli:installStream", { adapter, command, requestId }).catch((err) => {
      cb({ type: "stderr", content: String(err) });
      cb({ type: "done", exitCode: 1 });
    });
    return () => ipcRenderer.off(channel, handler);
  },

  run: (args: unknown) => ipcRenderer.invoke("cli:run", args),
  getCachedSessionConfigOptions: (args: unknown) =>
    ipcRenderer.invoke("cli:getCachedSessionConfigOptions", args),
  inspectSessionConfigOptions: (args: unknown) =>
    ipcRenderer.invoke("cli:inspectSessionConfigOptions", args),
  kill: (sessionId: string) => ipcRenderer.invoke("cli:kill", sessionId),
  permissionDecision: (args: unknown) =>
    ipcRenderer.invoke("cli:permissionDecision", args),
  authenticationDecision: (args: unknown) =>
    ipcRenderer.invoke("cli:authenticationDecision", args),
  authenticationTerminalInput: (args: unknown) =>
    ipcRenderer.invoke("cli:authenticationTerminalInput", args),
  authenticationTerminalCancel: (args: unknown) =>
    ipcRenderer.invoke("cli:authenticationTerminalCancel", args),

  listTasks: (args: unknown) => ipcRenderer.invoke("cli:listTasks", args),
  getTask: (id: string) => ipcRenderer.invoke("cli:getTask", id),
  readTaskLog: (args: unknown) => ipcRenderer.invoke("cli:readTaskLog", args),

  getToolSession: (agentId: string, workspacePath: string) =>
    ipcRenderer.invoke("cli:getToolSession", { agentId, workspacePath }),
  saveToolSession: (args: unknown) =>
    ipcRenderer.invoke("cli:saveToolSession", args),

  listConversations: (args?: unknown) =>
    ipcRenderer.invoke("cli:listConversations", args),
  getConversation: (id: string) => ipcRenderer.invoke("cli:getConversation", id),
  createConversation: (input: unknown) =>
    ipcRenderer.invoke("cli:createConversation", input),
  previewHandoffBrief: (input: unknown) =>
    ipcRenderer.invoke("cli:previewHandoffBrief", input),
  getHandoffBriefByTarget: (targetConversationId: string) =>
    ipcRenderer.invoke("cli:getHandoffBriefByTarget", targetConversationId),
  transferConversation: (input: unknown) =>
    ipcRenderer.invoke("cli:transferConversation", input),
  renameConversation: (
    id: string,
    title: string,
    titleSource?: "default" | "prompt" | "agent" | "user" | null
  ) =>
    ipcRenderer.invoke("cli:renameConversation", { id, title, titleSource }),
  updateConversationAgentName: (agentId: string, agentName: string) =>
    ipcRenderer.invoke("cli:updateConversationAgentName", { agentId, agentName }),
  archiveConversation: (id: string, archived: boolean) =>
    ipcRenderer.invoke("cli:archiveConversation", { id, archived }),
  deleteConversation: (id: string) =>
    ipcRenderer.invoke("cli:deleteConversation", id),
  setConversationApprovalMode: (
    id: string,
    approvalMode: "auto" | "ask" | null
  ) => ipcRenderer.invoke("cli:setConversationApprovalMode", { id, approvalMode }),
  setConversationConfigOptionOverrides: (
    id: string,
    overrides: Record<string, string> | null
  ) =>
    ipcRenderer.invoke("cli:setConversationConfigOptionOverrides", {
      id,
      overrides
    }),
  setConversationSkills: (id: string, skillIds: string[]) =>
    ipcRenderer.invoke("cli:setConversationSkills", { id, skillIds }),
  listMessages: (conversationId: string) =>
    ipcRenderer.invoke("cli:listMessages", conversationId),
  listMessage: (id: string) =>
    ipcRenderer.invoke("cli:listMessage", id),
  appendMessage: (input: unknown) =>
    ipcRenderer.invoke("cli:appendMessage", input),
  updateMessage: (input: unknown) =>
    ipcRenderer.invoke("cli:updateMessage", input),

  selectDirectory: () => ipcRenderer.invoke("cli:selectDirectory"),
  searchWorkspaceFiles: (cwd: string, query: string, limit?: number) =>
    ipcRenderer.invoke("cli:searchWorkspaceFiles", { cwd, query, limit }),
  selectAttachments: () => ipcRenderer.invoke("cli:selectAttachments"),
  prepareAttachmentFiles: async (files: File[], limit?: number, existingPaths?: string[]) => {
    const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
    const createdManagedPaths: string[] = [];

    const trackCreatedManagedFromBatch = (batch: {
      candidates?: Array<{ managed?: boolean; created?: boolean; path?: string }>;
    }) => {
      for (const item of batch?.candidates ?? []) {
        if (item?.created && item?.managed && typeof item.path === "string") {
          createdManagedPaths.push(item.path);
        }
      }
    };

    const prepareFile = async (file: File) => {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) {
        return ipcRenderer.invoke("cli:prepareAttachmentFiles", [
          { kind: "path", path: filePath }
        ]);
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        return {
          candidates: [],
          rejections: [
            {
              name: file.name || "clipboard-image",
              reason: "file_too_large"
            }
          ]
        };
      }
      const data = await file.arrayBuffer();
      const batch = await ipcRenderer.invoke("cli:prepareAttachmentFiles", [
        {
          kind: "buffer",
          name: file.name || "clipboard-image",
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          data
        }
      ]);
      trackCreatedManagedFromBatch(batch);
      return batch;
    };

    try {
      const result = await collectPreparedAttachmentsUntilLimit(
        files,
        limit,
        async (file) => {
          const batch = await prepareFile(file);
          return {
            candidates: batch?.candidates ?? [],
            rejections: batch?.rejections ?? []
          };
        },
        {
          existingPaths,
          getCandidatePath: (candidate: { path?: string }) =>
            typeof candidate?.path === "string" ? candidate.path : null
        }
      );

      for (const managedPath of managedPathsToDiscardAfterPrepare(
        createdManagedPaths,
        result.candidates
      )) {
        await ipcRenderer.invoke("cli:discardManagedAttachment", managedPath);
      }

      return result;
    } catch (error) {
      for (const managedPath of createdManagedPaths) {
        await ipcRenderer.invoke("cli:discardManagedAttachment", managedPath);
      }
      throw error;
    }
  },
  discardManagedAttachment: (filePath: string) =>
    ipcRenderer.invoke("cli:discardManagedAttachment", filePath),
  discardManagedAttachmentIfUnreferenced: (filePath: string) =>
    ipcRenderer.invoke("cli:discardManagedAttachmentIfUnreferenced", filePath),
  discardManagedAttachments: (paths: string[]) =>
    ipcRenderer.send("cli:discardManagedAttachments", paths),

  resolveDraftEntry: (cwd: string) =>
    ipcRenderer.invoke("cli:resolveDraftEntry", cwd),
  readDraftMarkdown: (cwd: string, rel: string) =>
    ipcRenderer.invoke("cli:readDraftMarkdown", { cwd, rel }),
  openDraftExternal: (url: string) =>
    ipcRenderer.invoke("cli:openDraftExternal", url),

  ensureAgentGuides: (cwd: string, options?: { nativeDraftTools?: boolean }) =>
    ipcRenderer.invoke("cli:ensureAgentGuides", { cwd, options }),

  onEvent(sessionId: string, cb: (event: unknown) => void): () => void {
    const channel = `cli://${sessionId}`;
    const handler = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  }
};

const window = {
  onChromeVisible(cb: (visible: boolean) => void): () => void {
    const handler = (_e: IpcRendererEvent, visible: boolean) => cb(visible);
    ipcRenderer.on("window:chrome", handler);
    return () => ipcRenderer.off("window:chrome", handler);
  },
  onBridge(
    cb: (event: { action: string; params: Record<string, string> }) => void
  ): () => void {
    const handler = (
      _e: IpcRendererEvent,
      payload: { action: string; params: Record<string, string> }
    ) => cb(payload);
    ipcRenderer.on("freebuddy://bridge", handler);
    return () => ipcRenderer.off("freebuddy://bridge", handler);
  },
  onDraftTool(cb: (event: DraftToolEvent) => void): () => void {
    const handler = (_e: IpcRendererEvent, payload: DraftToolEvent) => cb(payload);
    ipcRenderer.on("freebuddy://draft-tool", handler);
    return () => ipcRenderer.off("freebuddy://draft-tool", handler);
  },
  resolveDraftTool(resolution: DraftToolResolution): Promise<boolean> {
    return ipcRenderer.invoke("draft-tool:resolve", resolution);
  }
};

const settings: {
  getSetting: (key: string) => Promise<unknown>;
  setSetting: (key: string, value: string) => Promise<unknown>;
} = {
  getSetting: (key) => ipcRenderer.invoke("settings:get", key),
  setSetting: (key, value) =>
    ipcRenderer.invoke("settings:set", { key, value })
};

const feed = {
  listSources: () => ipcRenderer.invoke("feed:listSources"),
  addSource: (input: unknown) => ipcRenderer.invoke("feed:addSource", input),
  updateSource: (input: unknown) => ipcRenderer.invoke("feed:updateSource", input),
  deleteSource: (id: string) => ipcRenderer.invoke("feed:deleteSource", id),
  listItems: (args?: unknown) => ipcRenderer.invoke("feed:listItems", args),
  refreshSource: (id: string) => ipcRenderer.invoke("feed:refreshSource", id),
  refreshAll: () => ipcRenderer.invoke("feed:refreshAll"),
  markInterpreted: (id: string) => ipcRenderer.invoke("feed:markInterpreted", id)
};

const infoCards = {
  list: () => ipcRenderer.invoke("infoCards:list"),
  create: (input: unknown) => ipcRenderer.invoke("infoCards:create", input),
  update: (input: unknown) => ipcRenderer.invoke("infoCards:update", input),
  delete: (id: string) => ipcRenderer.invoke("infoCards:delete", id),
  reorder: (ids: string[]) => ipcRenderer.invoke("infoCards:reorder", ids),
  snapshot: (id: string) => ipcRenderer.invoke("infoCards:snapshot", id),
  refresh: (id: string, timeZone?: string) =>
    ipcRenderer.invoke("infoCards:refresh", id, timeZone),
  marketProvider: () => ipcRenderer.invoke("infoCards:marketProvider"),
  searchMarketSymbols: (query: string) =>
    ipcRenderer.invoke("infoCards:searchMarketSymbols", query),
  onChanged: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("infoCards://changed", handler);
    return () => ipcRenderer.off("infoCards://changed", handler);
  }
};

const workflow = {
  validate: (plan: unknown) => ipcRenderer.invoke("workflow:validate", plan),
  previewReviewLoop: (input: unknown) =>
    ipcRenderer.invoke("workflow:previewReviewLoop", input),
  coordinatorPrompt: (input: unknown) =>
    ipcRenderer.invoke("workflow:coordinatorPrompt", input),
  createRun: (input: unknown) => ipcRenderer.invoke("workflow:createRun", input),
  start: (runId: string) => ipcRenderer.invoke("workflow:start", runId),
  pause: (runId: string) => ipcRenderer.invoke("workflow:pause", runId),
  resume: (runId: string) => ipcRenderer.invoke("workflow:resume", runId),
  stop: (runId: string) => ipcRenderer.invoke("workflow:stop", runId),
  retryStep: (args: unknown) => ipcRenderer.invoke("workflow:retryStep", args),
  approveGate: (args: unknown) =>
    ipcRenderer.invoke("workflow:approveGate", args),
  requestGateChanges: (args: unknown) =>
    ipcRenderer.invoke("workflow:requestGateChanges", args),
  continueImplementReview: (runId: string) =>
    ipcRenderer.invoke("workflow:continueImplementReview", runId),
  getRun: (runId: string) => ipcRenderer.invoke("workflow:getRun", runId),
  listActiveRuns: () => ipcRenderer.invoke("workflow:listActiveRuns"),
  getSteps: (runId: string) => ipcRenderer.invoke("workflow:getSteps", runId),
  listRuns: (conversationId: string) =>
    ipcRenderer.invoke("workflow:listRuns", conversationId),
  previewTeamRun: (input: unknown) =>
    ipcRenderer.invoke("workflow:previewTeamRun", input),
  createTeamRun: (input: unknown) =>
    ipcRenderer.invoke("workflow:createTeamRun", input),
  onStepMessage(
    conversationId: string,
    cb: (event: { type: "appended" | "updated"; messageId: string }) => void
  ): () => void {
    const channel = `workflow://message/${conversationId}`;
    const handler = (_e: IpcRendererEvent, payload: unknown) =>
      cb(payload as any);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  }
};

const workflowTeams = {
  list: () => ipcRenderer.invoke("workflowTeams:list"),
  get: (id: string) => ipcRenderer.invoke("workflowTeams:get", id),
  create: (input: unknown) => ipcRenderer.invoke("workflowTeams:create", input),
  update: (args: unknown) => ipcRenderer.invoke("workflowTeams:update", args),
  delete: (id: string) => ipcRenderer.invoke("workflowTeams:delete", id),
  seedBuiltins: () => ipcRenderer.invoke("workflowTeams:seedBuiltins")
};

const skills = {
  list: () => ipcRenderer.invoke("skills:list"),
  import: (sourcePath: string) => ipcRenderer.invoke("skills:import", sourcePath),
  setEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke("skills:setEnabled", id, enabled),
  setTrusted: (id: string, trusted: boolean) =>
    ipcRenderer.invoke("skills:setTrusted", id, trusted),
  delete: (id: string) => ipcRenderer.invoke("skills:delete", id),
  read: (id: string) => ipcRenderer.invoke("skills:read", id),
  selectDirectory: () => ipcRenderer.invoke("skills:selectDirectory"),
  selectArchive: () => ipcRenderer.invoke("skills:selectArchive"),
  reveal: (id: string) => ipcRenderer.invoke("skills:reveal", id),
  marketProviders: () => ipcRenderer.invoke("skills:marketProviders"),
  getMarketProvider: () => ipcRenderer.invoke("skills:getMarketProvider"),
  setMarketProvider: (provider: string) =>
    ipcRenderer.invoke("skills:setMarketProvider", provider),
  searchMarket: (args: unknown) => ipcRenderer.invoke("skills:searchMarket", args),
  installFromMarket: (request: unknown) =>
    ipcRenderer.invoke("skills:installFromMarket", request),
  openMarketUrl: (url: string) => ipcRenderer.invoke("skills:openMarketUrl", url),
  resolveMarketHomepage: (args: unknown) =>
    ipcRenderer.invoke("skills:resolveMarketHomepage", args)
};

const scheduledTasks = {
  list: () => ipcRenderer.invoke("scheduledTasks:list"),
  listRuns: (taskId: string) => ipcRenderer.invoke("scheduledTasks:listRuns", taskId),
  listAgents: () => ipcRenderer.invoke("scheduledTasks:listAgents"),
  create: (input: unknown) => ipcRenderer.invoke("scheduledTasks:create", input),
  update: (args: unknown) => ipcRenderer.invoke("scheduledTasks:update", args),
  delete: (id: string) => ipcRenderer.invoke("scheduledTasks:delete", id),
  run: (id: string) => ipcRenderer.invoke("scheduledTasks:run", id),
  onChanged: (cb: (task: unknown) => void): (() => void) => {
    const channel = "scheduledTasks://changed";
    const handler = (_e: IpcRendererEvent, task: unknown) => cb(task);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  }
};

const updater = {
  getVersion: () => ipcRenderer.invoke("app:getVersion") as Promise<string>,
  check: () =>
    ipcRenderer.invoke("updater:check") as Promise<
      | { ok: true; available: boolean; version: string | null }
      | { ok: false; error: string }
    >,
  download: () =>
    ipcRenderer.invoke("updater:download") as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  quitAndInstall: () => ipcRenderer.invoke("updater:quitAndInstall") as Promise<boolean>,
  onEvent(cb: (event: unknown) => void): () => void {
    const channel = "updater://event";
    const handler = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  }
};

contextBridge.exposeInMainWorld("freebuddy", {
  platform: process.platform,
  arch: process.arch,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node
  },
  appVersion: process.env.FB_APP_VERSION ?? "",
  cli,
  workflow,
  workflowTeams,
  skills,
  settings,
  scheduledTasks,
  feed,
  infoCards,
  window,
  updater
});
