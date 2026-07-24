import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type {
  ConversationContextPayload,
  HandoffTranscriptMessage
} from "../shared/handoffTypes.js";
import { readHandoffTranscriptSnapshot } from "../shared/handoffTranscript.js";

const MAX_PAGE_RESULT_BYTES = 512 * 1024;
const MAX_SEARCH_EXCERPT = 800;

interface LoadedManifest {
  version: 4;
  references: ConversationContextPayload[];
  manifestPath: string;
}

function loadManifest(): LoadedManifest | null {
  const file = process.env.FREEBUDDY_CONTEXT_MANIFEST?.trim();
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !parsed ||
      parsed.version !== 4 ||
      !Array.isArray(parsed.references) ||
      parsed.references.length === 0
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

function toCompact(brief: ConversationContextPayload["brief"]) {
  return {
    originalGoal: brief.originalGoal,
    recentUserMessages: brief.recentUserMessages,
    fileChanges: brief.fileChanges.map((c) => c.path)
  };
}

function transcriptDataDir(manifest: LoadedManifest): string {
  return path.dirname(path.dirname(path.resolve(manifest.manifestPath)));
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
  const contextReferences = manifest?.references ?? [];
  const messagesByContext = new Map(
    contextReferences.map((reference) => [
      reference.id,
      reference.transcript && manifest
        ? readHandoffTranscriptSnapshot(
            transcriptDataDir(manifest),
            reference.transcript
          )
        : []
    ])
  );
  const selectContext = (contextId?: string) =>
    contextId
      ? contextReferences.find((reference) => reference.id === contextId)
      : contextReferences[0];
  const server = new McpServer({
    name: "freebuddy-context",
    version: process.env.FB_APP_VERSION || "0.1.0"
  });

  server.registerTool(
    "list_context_sources",
    {
      title: "List Conversation Context Sources",
      description:
        "List every FreeBuddy conversation reference attached to this conversation. " +
        "Use the returned context id with the context read and search tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => {
      const sources = contextReferences.map((reference) => ({
        contextId: reference.id,
        referenceType: reference.referenceType,
        source: reference.source,
        history: {
          available: Boolean(
            reference.transcript &&
              (messagesByContext.get(reference.id)?.length ?? 0) > 0
          ),
          messageCount: messagesByContext.get(reference.id)?.length ?? 0,
          sourceMessageCount: reference.brief.source.messageCount,
          truncated: reference.transcript?.truncated ?? false
        }
      }));
      return sources.length
        ? result(JSON.stringify({ sources }, null, 2), { sources })
        : emptyResult("No conversation context sources for this session");
    }
  );

  server.registerTool(
    "read_context_brief",
    {
      title: "Read Conversation Context Brief",
      description:
        "Read the structured brief for an attached FreeBuddy conversation context.",
      inputSchema: {
        contextId: z.string().optional(),
        format: z.enum(["full", "compact"]).default("full").optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({
      contextId,
      format = "full"
    }: {
      contextId?: string;
      format?: "full" | "compact";
    } = {}) => {
      const reference = selectContext(contextId);
      if (!reference) return emptyResult("Conversation context not found");
      const brief =
        format === "compact" ? toCompact(reference.brief) : reference.brief;
      return result(JSON.stringify(brief, null, 2), {
        contextId: reference.id,
        brief,
        source: reference.source
      });
    }
  );

  server.registerTool(
    "read_context_messages",
    {
      title: "Read Conversation Context Messages",
      description:
        "Read a bounded page of a referenced conversation's sanitized message snapshot.",
      inputSchema: {
        contextId: z.string().optional(),
        cursor: z.number().int().min(0).default(0).optional(),
        limit: z.number().int().min(1).max(25).default(10).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({
      contextId,
      cursor = 0,
      limit = 10
    }: {
      contextId?: string;
      cursor?: number;
      limit?: number;
    } = {}) => {
      const reference = selectContext(contextId);
      if (!reference) return emptyResult("Conversation context not found");
      const messages = messagesByContext.get(reference.id) ?? [];
      if (!reference.transcript || messages.length === 0) {
        return emptyResult("No conversation context transcript");
      }
      const page: HandoffTranscriptMessage[] = [];
      let bytes = 0;
      const end = Math.min(messages.length, cursor + limit);
      for (let index = cursor; index < end; index += 1) {
        const message = messages[index];
        const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
        if (page.length > 0 && bytes + messageBytes > MAX_PAGE_RESULT_BYTES) break;
        page.push(message);
        bytes += messageBytes;
      }
      const nextCursor = cursor + page.length;
      const payload = {
        contextId: reference.id,
        messages: page,
        nextCursor,
        hasMore: nextCursor < messages.length,
        total: messages.length,
        sourceMessageCount: reference.brief.source.messageCount,
        truncated: reference.transcript.truncated
      };
      return result(JSON.stringify(payload, null, 2), payload);
    }
  );

  server.registerTool(
    "search_context_history",
    {
      title: "Search Conversation Context History",
      description:
        "Search one attached conversation snapshot and return bounded matching excerpts.",
      inputSchema: {
        contextId: z.string().optional(),
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(20).default(10).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({
      contextId,
      query,
      limit = 10
    }: {
      contextId?: string;
      query: string;
      limit?: number;
    }) => {
      const reference = selectContext(contextId);
      if (!reference) return emptyResult("Conversation context not found");
      const messages = messagesByContext.get(reference.id) ?? [];
      if (!reference.transcript || messages.length === 0) {
        return emptyResult("No conversation context transcript");
      }
      const needle = query.toLocaleLowerCase();
      const matchingMessages = messages
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
        contextId: reference.id,
        query,
        matches,
        hasMoreMatches: matchingMessages.length > limit
      };
      return result(JSON.stringify(payload, null, 2), payload);
    }
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
