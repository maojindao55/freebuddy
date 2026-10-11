import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getSetting, setSetting } from "./cli/settings.js";
import { getConversation, markDocStudioConversation } from "./cli/conversations.js";
import { isOfficeEngineFile } from "./officeEngineCore.js";
import { ensureOfficeEnginePort } from "./officeEngine.js";
import type { AcpStdioMcpServer } from "./shared/browserToolProtocol.js";

/**
 * Registers the office engine's MCP tools (doc/sheet/slide families) as a stdio
 * MCP server for DocStudio copilot conversations. Keep the setting key in sync
 * with CONVERSATION_MAP_SETTING in src/components/DocStudio/DocStudioCopilot.tsx.
 */
const DOC_STUDIO_CONVERSATION_MAP_SETTING = "docStudio.conversationByFile";
const savedFileEvents = new Map<string, string>();
let savedFileEventsDirectory: string | null = null;

function savedFileEventPath(conversationId: string): string {
  const existing = savedFileEvents.get(conversationId);
  if (existing) return existing;
  if (!savedFileEventsDirectory) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-office-events-"));
    savedFileEventsDirectory = directory;
    process.once("exit", () => {
      for (const filePath of savedFileEvents.values()) {
        try { fs.unlinkSync(filePath); } catch { /* already removed */ }
      }
      try { fs.rmdirSync(directory); } catch { /* leave an unexpected nonempty directory alone */ }
    });
  }
  const name = createHash("sha256").update(conversationId).digest("hex");
  const filePath = path.join(savedFileEventsDirectory, `${name}.jsonl`);
  fs.writeFileSync(filePath, "");
  savedFileEvents.set(conversationId, filePath);
  return filePath;
}

function drainSavedFileEvents(conversationId: string): string | null {
  const filePath = savedFileEvents.get(conversationId);
  if (!filePath) return null;
  let content: string | null = null;
  try {
    if (fs.statSync(filePath).size <= 64 * 1024) {
      content = fs.readFileSync(filePath, "utf8");
    }
  } catch {
    /* No save event was recorded. */
  }
  try { fs.writeFileSync(filePath, ""); } catch { /* app is shutting down */ }
  return content;
}

/** Consume the MCP relay's successful save-as events when an agent turn ends. */
export function takeSavedOfficeFiles(conversationId: string): string[] {
  const content = drainSavedFileEvents(conversationId);
  if (!content) return [];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const line of content.split(/\r?\n/).slice(0, 50)) {
    try {
      const { filePath } = JSON.parse(line) as { filePath?: unknown };
      if (typeof filePath !== "string" || !path.isAbsolute(filePath) || !isOfficeEngineFile(filePath)) continue;
      const normalized = path.normalize(filePath);
      const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
      if (seen.has(key) || !fs.statSync(normalized).isFile()) continue;
      seen.add(key);
      files.push(normalized);
    } catch {
      /* Ignore malformed events and files removed after the save. */
    }
  }
  return files;
}

/** Keep a newly created tab on the conversation that created it from an empty studio. */
export function associateDocStudioOfficeFile(conversationId: string, filePath: string): void {
  if (!markDocStudioConversation(conversationId, filePath)) return;
  let map: Record<string, string> = {};
  try {
    const raw = getSetting(DOC_STUDIO_CONVERSATION_MAP_SETTING);
    if (raw) map = JSON.parse(raw) as Record<string, string>;
  } catch {
    /* Recover a corrupted mapping. */
  }
  map[filePath] = conversationId;
  setSetting(DOC_STUDIO_CONVERSATION_MAP_SETTING, JSON.stringify(map));
}

/** Upgrade file mappings created before DocStudio had a dedicated conversation kind. */
export function migrateLegacyDocStudioConversations(): void {
  try {
    const raw = getSetting(DOC_STUDIO_CONVERSATION_MAP_SETTING);
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, unknown>;
    if (!map || typeof map !== "object" || Array.isArray(map)) return;
    for (const [filePath, conversationId] of Object.entries(map)) {
      if (!path.isAbsolute(filePath) || !isOfficeEngineFile(filePath) || typeof conversationId !== "string") continue;
      markDocStudioConversation(conversationId, filePath);
    }
  } catch {
    /* A malformed legacy setting must not block startup. */
  }
}

function serverPath(): string {
  return fileURLToPath(new URL("./mcp/officeEngineMcpServer.js", import.meta.url));
}

/** Resolve the office-engine file behind a DocStudio copilot conversation, if any. */
export function resolveDocStudioOfficeFile(conversationId: string): string | null {
  const conversation = getConversation(conversationId);
  const attached = conversation?.kind === "doc-studio" ? conversation.metadata?.docStudioFilePath : undefined;
  if (typeof attached === "string" && path.isAbsolute(attached) && isOfficeEngineFile(attached)) {
    return attached;
  }
  const raw = getSetting(DOC_STUDIO_CONVERSATION_MAP_SETTING);
  if (!raw) return null;
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    for (const [filePath, convId] of Object.entries(map)) {
      if (convId === conversationId && isOfficeEngineFile(filePath)) return filePath;
    }
  } catch {
    /* corrupted mapping setting: ignore */
  }
  return null;
}

export async function registerOfficeEngineToolSession(
  taskSessionId: string,
  conversationId: string,
  officeFile: string
): Promise<AcpStdioMcpServer | null> {
  const port = await ensureOfficeEnginePort();
  if (!port) return null;
  // Persistent ACP connections may keep the same MCP child between turns, so
  // its notification path must remain stable for this conversation.
  const filePath = savedFileEventPath(conversationId);
  return {
    name: "office-engine",
    command: process.execPath,
    args: [serverPath()],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: "FREEBUDDY_OFFICE_MCP_URL", value: `http://127.0.0.1:${port}/mcp` },
      { name: "FREEBUDDY_OFFICE_TASK_SESSION", value: taskSessionId },
      { name: "FREEBUDDY_OFFICE_FILE", value: officeFile },
      { name: "FREEBUDDY_OFFICE_SAVED_FILES_EVENT_PATH", value: filePath },
      { name: "FB_APP_VERSION", value: process.env.FB_APP_VERSION || "0.1.0" }
    ]
  };
}
