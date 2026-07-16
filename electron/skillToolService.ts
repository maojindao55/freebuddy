import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDataDir } from "./cli/db.js";
import type { SkillSnapshot } from "./cli/skillTypes.js";
import type { AcpStdioMcpServer } from "./shared/draftToolProtocol.js";

const manifests = new Map<string, string>();

function serverPath(): string {
  return fileURLToPath(new URL("./mcp/skillMcpServer.js", import.meta.url));
}

export function registerSkillToolSession(
  taskSessionId: string,
  skills: readonly SkillSnapshot[]
): AcpStdioMcpServer {
  unregisterSkillToolSession(taskSessionId);
  const directory = path.join(getDataDir(), "skill-sessions");
  fs.mkdirSync(directory, { recursive: true });
  const manifest = path.join(directory, `${taskSessionId}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, skills }), {
    encoding: "utf8",
    mode: 0o600
  });
  manifests.set(taskSessionId, manifest);
  return {
    name: "freebuddy-skills",
    command: process.execPath,
    args: [serverPath()],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: "FREEBUDDY_SKILL_MANIFEST", value: manifest },
      { name: "FB_APP_VERSION", value: process.env.FB_APP_VERSION || "0.1.0" }
    ]
  };
}

export function unregisterSkillToolSession(taskSessionId: string): void {
  const manifest = manifests.get(taskSessionId);
  manifests.delete(taskSessionId);
  if (!manifest) return;
  try {
    fs.unlinkSync(manifest);
  } catch {
    // Best-effort cleanup after the MCP child has read its allowlist.
  }
}
