import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type {
  HandoffBrief,
  HandoffTranscriptMessage,
  HandoffTranscriptRef
} from "../shared/handoffTypes.js";
import { readHandoffTranscriptSnapshot } from "../shared/handoffTranscript.js";

const MAX_PAGE_RESULT_BYTES = 512 * 1024;
const MAX_SEARCH_EXCERPT = 800;

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
  transcript?: HandoffTranscriptRef;
  manifestPath: string;
}

function loadManifest(): LoadedManifest | null {
  const file = process.env.FREEBUDDY_HANDOFF_MANIFEST?.trim();
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !parsed ||
      (parsed.version !== 1 && parsed.version !== 2) ||
      !parsed.brief ||
      !parsed.source
    ) {
      return null;
    }
    return { ...parsed, manifestPath: file } as LoadedManifest;
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

function transcriptDataDir(manifest: LoadedManifest): string {
  return path.dirname(path.dirname(path.resolve(manifest.manifestPath)));
}

function loadTranscript(manifest: LoadedManifest | null): HandoffTranscriptMessage[] {
  if (!manifest?.transcript) return [];
  return readHandoffTranscriptSnapshot(
    transcriptDataDir(manifest),
    manifest.transcript
  );
}

function historyMetadata(
  manifest: LoadedManifest,
  messages: HandoffTranscriptMessage[]
) {
  return {
    available: Boolean(manifest.transcript && messages.length > 0),
    messageCount: messages.length,
    sourceMessageCount: manifest.brief.source.messageCount,
    truncated: manifest.transcript?.truncated ?? false
  };
}

function messageSearchText(message: HandoffTranscriptMessage): string {
  return [
    message.role,
    message.agentName,
    message.roleLabel,
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content),
    ...(message.attachments?.map((attachment) => attachment.name) ?? [])
  ]
    .filter(Boolean)
    .join("\n");
}

function messageExcerpt(message: HandoffTranscriptMessage): string {
  const text =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_SEARCH_EXCERPT
    ? compact
    : `${compact.slice(0, MAX_SEARCH_EXCERPT)}…`;
}

export function createContextMcpServer(): McpServer {
  const manifest = loadManifest();
  const transcriptMessages = loadTranscript(manifest);
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
        "previous agent. Use read_handoff_messages or search_handoff_history " +
        "when the summary is not sufficient. Returns an empty result if no handoff exists.",
      inputSchema: { format: z.enum(["full", "compact"]).default("full").optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ format }: { format?: "full" | "compact" } = {}) => {
      if (!manifest) return emptyResult("No handoff brief for this session");
      const brief = format === "compact" ? toCompact(manifest.brief) : manifest.brief;
      return result(JSON.stringify(brief, null, 2), {
        brief,
        source: manifest.source,
        history: historyMetadata(manifest, transcriptMessages)
      });
    }
  );

  server.registerTool(
    "read_handoff_messages",
    {
      title: "Read Handoff Messages",
      description:
        "Read a bounded page of the transferred conversation's sanitized " +
        "message snapshot. Use cursor pagination for additional messages. " +
        "No filesystem path or database access is exposed.",
      inputSchema: {
        cursor: z.number().int().min(0).default(0).optional(),
        limit: z.number().int().min(1).max(25).default(10).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ cursor = 0, limit = 10 }: { cursor?: number; limit?: number } = {}) => {
      if (!manifest?.transcript || transcriptMessages.length === 0) {
        return emptyResult("No handoff transcript for this session");
      }
      const page: HandoffTranscriptMessage[] = [];
      let bytes = 0;
      const end = Math.min(transcriptMessages.length, cursor + limit);
      for (let index = cursor; index < end; index += 1) {
        const message = transcriptMessages[index];
        const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
        if (page.length > 0 && bytes + messageBytes > MAX_PAGE_RESULT_BYTES) break;
        page.push(message);
        bytes += messageBytes;
      }
      const nextCursor = cursor + page.length;
      const payload = {
        messages: page,
        nextCursor,
        hasMore: nextCursor < transcriptMessages.length,
        total: transcriptMessages.length,
        sourceMessageCount: manifest.brief.source.messageCount,
        truncated: manifest.transcript.truncated
      };
      return result(JSON.stringify(payload, null, 2), payload);
    }
  );

  server.registerTool(
    "search_handoff_history",
    {
      title: "Search Handoff History",
      description:
        "Search the sanitized transferred conversation snapshot and return " +
        "bounded matching excerpts. Use read_handoff_messages with the returned " +
        "message positions when more surrounding context is needed.",
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(20).default(10).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ query, limit = 10 }: { query: string; limit?: number }) => {
      if (!manifest?.transcript || transcriptMessages.length === 0) {
        return emptyResult("No handoff transcript for this session");
      }
      const needle = query.toLocaleLowerCase();
      const matchingMessages = transcriptMessages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) =>
          messageSearchText(message).toLocaleLowerCase().includes(needle)
        );
      const matches = matchingMessages
        .slice(0, limit)
        .map(({ message, index }) => ({
          index,
          messageId: message.id,
          role: message.role,
          createdAt: message.createdAt,
          excerpt: messageExcerpt(message)
        }));
      const payload = {
        query,
        matches,
        hasMoreMatches: matchingMessages.length > limit
      };
      return result(JSON.stringify(payload, null, 2), payload);
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
