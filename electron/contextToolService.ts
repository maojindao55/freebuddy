import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDataDir } from "./cli/db.js";
import type { HandoffBrief } from "./shared/handoffTypes.js";
import type { AcpStdioMcpServer } from "./shared/draftToolProtocol.js";

const manifests = new Map<string, string>();

function serverPath(): string {
  return fileURLToPath(new URL("./mcp/contextMcpServer.js", import.meta.url));
}

export function registerContextToolSession(
  taskSessionId: string,
  brief: HandoffBrief,
  briefId: string
): AcpStdioMcpServer {
  unregisterContextToolSession(taskSessionId);
  const directory = path.join(getDataDir(), "context-sessions");
  fs.mkdirSync(directory, { recursive: true });
  const manifest = path.join(directory, `${taskSessionId}.json`);
  // Manifest source directly from brief.source (5 required fields; cwd/messageCount not in manifest)
  const source = {
    conversationId: brief.source.conversationId,
    agentId: brief.source.agentId,
    agentName: brief.source.agentName,
    adapter: brief.source.adapter,
    title: brief.source.title
  };
  fs.writeFileSync(
    manifest,
    JSON.stringify({ version: 1, brief, briefId, source }),
    { encoding: "utf8", mode: 0o600 }
  );
  manifests.set(taskSessionId, manifest);
  return {
    name: "freebuddy-context",
    command: process.execPath,
    args: [serverPath()],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: "FREEBUDDY_HANDOFF_MANIFEST", value: manifest },
      { name: "FB_APP_VERSION", value: process.env.FB_APP_VERSION || "0.1.0" }
    ]
  };
}

export function unregisterContextToolSession(taskSessionId: string): void {
  const manifest = manifests.get(taskSessionId);
  manifests.delete(taskSessionId);
  if (!manifest) return;
  try {
    fs.unlinkSync(manifest);
  } catch {
    // best-effort cleanup
  }
}
