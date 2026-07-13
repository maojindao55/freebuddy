import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type DraftToolAction = "show" | "inspect" | "report";

interface DraftToolResponse {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

function bridgeEnvironment(): { endpoint: string; token: string } {
  const endpoint = process.env.FREEBUDDY_DRAFT_ENDPOINT?.trim();
  const token = process.env.FREEBUDDY_DRAFT_TOKEN?.trim();
  if (!endpoint || !token) {
    throw new Error("FreeBuddy Draft tool environment is incomplete.");
  }
  return { endpoint, token };
}

export async function invokeDraftBridge(
  action: DraftToolAction,
  params: Record<string, unknown>
): Promise<DraftToolResponse> {
  const { endpoint, token } = bridgeEnvironment();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action, params }),
    signal: AbortSignal.timeout(20_000)
  });
  const result = (await response.json().catch(() => ({
    ok: false,
    error: `Draft bridge returned HTTP ${response.status}`
  }))) as DraftToolResponse;
  if (!response.ok) {
    throw new Error(result.error || `Draft bridge returned HTTP ${response.status}`);
  }
  return result;
}

function toolResult(result: DraftToolResponse) {
  const screenshot =
    result.screenshot && typeof result.screenshot === "object"
      ? (result.screenshot as {
          mimeType?: unknown;
          data?: unknown;
          width?: unknown;
          height?: unknown;
        })
      : undefined;
  const structuredContent = screenshot
    ? {
        ...result,
        screenshot: {
          mimeType: screenshot.mimeType,
          width: screenshot.width,
          height: screenshot.height
        }
      }
    : result;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2)
      },
      ...(typeof screenshot?.data === "string" &&
      typeof screenshot?.mimeType === "string"
        ? [
            {
              type: "image" as const,
              data: screenshot.data,
              mimeType: screenshot.mimeType
            }
          ]
        : [])
    ],
    structuredContent,
    ...(result.ok === false ? { isError: true } : {})
  };
}

function toolError(error: unknown) {
  return toolResult({
    ok: false,
    error: (error as Error)?.message || String(error)
  });
}

export function createDraftMcpServer(): McpServer {
  const server = new McpServer({
    name: "freebuddy-draft",
    version: process.env.FB_APP_VERSION || "0.1.0"
  });

  server.registerTool(
    "draft_show",
    {
      title: "Show Draft Preview",
      description:
        "Open or update FreeBuddy Draft for the current conversation. Use after creating or changing a web page, Markdown document, image, PDF, or localhost dev server.",
      inputSchema: {
        target: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Workspace-relative file (requires a selected working directory), absolute local preview file, freebuddy-file URL, or http(s) URL. Omit to open the existing target."
          ),
        open: z
          .boolean()
          .optional()
          .default(true)
          .describe("Open the Draft panel when this conversation is active."),
        waitForReady: z
          .boolean()
          .optional()
          .default(true)
          .describe("Wait briefly for the preview to load before returning.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeDraftBridge("show", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "draft_inspect",
    {
      title: "Inspect Draft Preview",
      description:
        "Inspect the current Draft target, visibility, load state, recent preview console messages, and optionally capture the visible Draft as an image. Use after draft_show to verify visual output and diagnose runtime errors.",
      inputSchema: {
        screenshot: z
          .boolean()
          .optional()
          .default(false)
          .describe("Capture the visible Draft preview and return it as image content."),
        console: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include recent console messages from the preview iframe.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeDraftBridge("inspect", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "draft_report",
    {
      title: "Report Draft Status",
      description:
        "Show a concise preview, build, or dev-server status message inside FreeBuddy.",
      inputSchema: {
        level: z
          .enum(["status", "success", "error"])
          .optional()
          .default("status"),
        message: z.string().trim().min(1).max(1000)
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeDraftBridge("report", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  return server;
}

export async function runDraftMcpServer(): Promise<void> {
  const server = createDraftMcpServer();
  await server.connect(new StdioServerTransport());
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runDraftMcpServer().catch((error) => {
    console.error("[FreeBuddy Draft MCP]", error);
    process.exitCode = 1;
  });
}
