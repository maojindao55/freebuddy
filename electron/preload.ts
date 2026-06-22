import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const cli = {
  listAdapters: () => ipcRenderer.invoke("cli:listAdapters"),
  listOverrides: () => ipcRenderer.invoke("cli:listOverrides"),
  upsertOverride: (o: unknown) => ipcRenderer.invoke("cli:upsertOverride", o),
  resetOverride: (id: string) => ipcRenderer.invoke("cli:resetOverride", id),

  listRuntimes: () => ipcRenderer.invoke("cli:listRuntimes"),
  check: (adapter: string, binary?: string) =>
    ipcRenderer.invoke("cli:check", { adapter, binary }),
  install: (command: string) => ipcRenderer.invoke("cli:install", command),

  run: (args: unknown) => ipcRenderer.invoke("cli:run", args),
  kill: (sessionId: string) => ipcRenderer.invoke("cli:kill", sessionId),
  permissionDecision: (args: unknown) =>
    ipcRenderer.invoke("cli:permissionDecision", args),

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
  renameConversation: (id: string, title: string) =>
    ipcRenderer.invoke("cli:renameConversation", { id, title }),
  archiveConversation: (id: string, archived: boolean) =>
    ipcRenderer.invoke("cli:archiveConversation", { id, archived }),
  deleteConversation: (id: string) =>
    ipcRenderer.invoke("cli:deleteConversation", id),
  setConversationApprovalMode: (
    id: string,
    approvalMode: "auto" | "ask" | null
  ) => ipcRenderer.invoke("cli:setConversationApprovalMode", { id, approvalMode }),
  listMessages: (conversationId: string) =>
    ipcRenderer.invoke("cli:listMessages", conversationId),
  appendMessage: (input: unknown) =>
    ipcRenderer.invoke("cli:appendMessage", input),
  updateMessage: (input: unknown) =>
    ipcRenderer.invoke("cli:updateMessage", input),

  selectDirectory: () => ipcRenderer.invoke("cli:selectDirectory"),
  selectAttachments: () => ipcRenderer.invoke("cli:selectAttachments"),

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
  getRun: (runId: string) => ipcRenderer.invoke("workflow:getRun", runId),
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

contextBridge.exposeInMainWorld("freebuddy", {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node
  },
  cli,
  workflow,
  workflowTeams,
  settings,
  window
});
