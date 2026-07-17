import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { HandoffBrief } from "../shared/handoffTypes.js";

interface ManifestSource {
  conversationId: string;
  agentId: string;
  agentName: string;
  adapter: string;
  title: string;
}

interface LoadedManifest {
  brief: HandoffBrief;
  briefId: string;
  source: ManifestSource;
}

function loadManifest(): LoadedManifest | null {
  const file = process.env.FREEBUDDY_HANDOFF_MANIFEST?.trim();
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== 1 || !parsed.brief || !parsed.source) return null;
    return parsed as LoadedManifest;
  } catch {
    return null;
  }
}

function emptyResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function result(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {})
  };
}

function toCompact(brief: HandoffBrief) {
  return {
    originalGoal: brief.originalGoal,
    recentUserMessages: brief.recentUserMessages,
    fileChanges: brief.fileChanges.map((c) => c.path)
  };
}

export function createContextMcpServer(): McpServer {
  const manifest = loadManifest();
  const server = new McpServer({
    name: "freebuddy-context",
    version: process.env.FB_APP_VERSION || "0.1.0"
  });

  server.registerTool(
    "read_handoff_brief",
    {
      title: "Read Handoff Brief",
      description:
        "Load the structured handoff brief for this FreeBuddy conversation, " +
        "if it was transferred from another agent. Returns origin metadata, " +
        "the original goal, recent messages, and file changes from the " +
        "previous agent. Returns an empty result if no handoff exists.",
      inputSchema: { format: z.enum(["full", "compact"]).default("full").optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ format }: { format?: "full" | "compact" } = {}) => {
      if (!manifest) return emptyResult("No handoff brief for this session");
      const brief = format === "compact" ? toCompact(manifest.brief) : manifest.brief;
      return result(JSON.stringify(brief, null, 2), {
        brief: manifest.brief,
        source: manifest.source
      });
    }
  );

  server.registerTool(
    "get_handoff_origin",
    {
      title: "Get Handoff Origin",
      description:
        "Return only the originating agent metadata for this conversation " +
        "(agent name, adapter, conversation id, title). Cheaper than " +
        "read_handoff_brief when you just need to know where this came from.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () =>
      manifest
        ? result(JSON.stringify(manifest.source, null, 2), { source: manifest.source })
        : emptyResult("No handoff origin for this session")
  );

  return server;
}

export async function runContextMcpServer(): Promise<void> {
  await createContextMcpServer().connect(new StdioServerTransport());
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runContextMcpServer().catch((error) => {
    console.error("[FreeBuddy Context MCP]", error);
    process.exitCode = 1;
  });
}
