import { ipcMain, BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";

import { cliAdapterDefinitions } from "./adapters.js";
import { cliCheck, cliInstall, listRuntimes } from "./check.js";
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
import { takePermissionResolver } from "./runtimeShared.js";
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
  listMessages,
  renameConversation,
  setConversationApprovalMode,
  updateMessage,
  type AppendMessageInput,
  type CreateConversationInput,
  type ListConversationsArgs,
  type UpdateMessageInput
} from "./conversations.js";
import { getSetting, setSetting } from "./settings.js";

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
        { name: "Supported attachments", extensions: ATTACHMENT_EXTENSIONS },
        { name: "All files", extensions: ["*"] }
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

  ipcMain.handle("cli:listAdapters", () => cliAdapterDefinitions);

  ipcMain.handle("cli:listOverrides", () => listOverrides());
  ipcMain.handle(
    "cli:upsertOverride",
    (_e, override: CLIExecutorOverride) => upsertOverride(override)
  );
  ipcMain.handle("cli:resetOverride", (_e, id: string) => resetOverride(id));

  ipcMain.handle("cli:listRuntimes", () => listRuntimes());
  ipcMain.handle(
    "cli:check",
    async (_e, args: { adapter: string; binary?: string }) =>
      cliCheck(args.adapter, args.binary)
  );
  ipcMain.handle("cli:install", async (_e, command: string) =>
    cliInstall(command)
  );

  ipcMain.handle("cli:run", async (event, args: CliRunArgs) => {
    const win = senderWindow(event);
    if (!win) throw new Error("no sender window");
    // Don't await: spawn returns immediately, streaming continues via events.
    void cliRun(win.webContents, args);
    return { sessionId: args.sessionId };
  });
  ipcMain.handle("cli:kill", (_e, sessionId: string) => cliKill(sessionId));

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

  // ---- Conversations -----------------------------------------------------

  ipcMain.handle("cli:listConversations", (_e, args: ListConversationsArgs = {}) =>
    listConversations(args)
  );
  ipcMain.handle("cli:getConversation", (_e, id: string) => getConversation(id));
  ipcMain.handle(
    "cli:createConversation",
    (_e, input: CreateConversationInput) => createConversation(input)
  );
  ipcMain.handle(
    "cli:renameConversation",
    (_e, args: { id: string; title: string }) =>
      renameConversation(args.id, args.title)
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

  ipcMain.handle("cli:listMessages", (_e, conversationId: string) =>
    listMessages(conversationId)
  );
  ipcMain.handle("cli:appendMessage", (_e, input: AppendMessageInput) =>
    appendMessage(input)
  );
  ipcMain.handle("cli:updateMessage", (_e, input: UpdateMessageInput) =>
    updateMessage(input)
  );

  ipcMain.handle("settings:get", (_e, key: string) => getSetting(key));
  ipcMain.handle("settings:set", (_e, args: { key: string; value: string }) => {
    setSetting(args.key, args.value);
  });
}
