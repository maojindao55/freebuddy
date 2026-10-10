import { fileURLToPath } from "node:url";

import { getSetting } from "./cli/settings.js";
import { isOfficeEngineFile } from "./officeEngineCore.js";
import { ensureOfficeEnginePort } from "./officeEngine.js";
import type { AcpStdioMcpServer } from "./shared/browserToolProtocol.js";

/**
 * Registers the office engine's MCP tools (doc/sheet/slide families) as a stdio
 * MCP server for DocStudio copilot conversations. Keep the setting key in sync
 * with CONVERSATION_MAP_SETTING in src/components/DocStudio/DocStudioCopilot.tsx.
 */
const DOC_STUDIO_CONVERSATION_MAP_SETTING = "docStudio.conversationByFile";

function serverPath(): string {
  return fileURLToPath(new URL("./mcp/officeEngineMcpServer.js", import.meta.url));
}

/** Resolve the office-engine file behind a DocStudio copilot conversation, if any. */
export function resolveDocStudioOfficeFile(conversationId: string): string | null {
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
  officeFile: string
): Promise<AcpStdioMcpServer | null> {
  const port = await ensureOfficeEnginePort();
  if (!port) return null;
  return {
    name: "office-engine",
    command: process.execPath,
    args: [serverPath()],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: "FREEBUDDY_OFFICE_MCP_URL", value: `http://127.0.0.1:${port}/mcp` },
      { name: "FREEBUDDY_OFFICE_TASK_SESSION", value: taskSessionId },
      { name: "FREEBUDDY_OFFICE_FILE", value: officeFile },
      { name: "FB_APP_VERSION", value: process.env.FB_APP_VERSION || "0.1.0" }
    ]
  };
}
