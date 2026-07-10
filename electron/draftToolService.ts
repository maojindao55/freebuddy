import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { WebContents } from "electron";

import { waitForActiveBridgePort } from "./agentBridge.js";
import { safeSendToWebContents } from "./cli/ipcSend.js";
import type {
  AcpStdioMcpServer,
  DraftCaptureRect,
  DraftConsoleEntry,
  DraftToolAction,
  DraftToolEvent,
  DraftToolResolution,
  DraftToolResult
} from "./shared/draftToolProtocol.js";

const DRAFT_TOOL_PATH = "/freebuddy/draft-tool";
const MAX_REQUEST_BYTES = 64 * 1024;
const RENDERER_TIMEOUT_MS = 15_000;

interface DraftToolBinding {
  token: string;
  taskSessionId: string;
  conversationId: string;
  cwd: string;
  webContents: WebContents;
}

interface PendingDraftToolRequest {
  binding: DraftToolBinding;
  action: DraftToolAction;
  params: Record<string, unknown>;
  resolve: (result: DraftToolResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const bindingsByToken = new Map<string, DraftToolBinding>();
const tokensByTaskSession = new Map<string, string>();
const pendingRequests = new Map<string, PendingDraftToolRequest>();
const consoleEntriesByWebContents = new Map<number, DraftConsoleEntry[]>();
const observedWebContents = new Set<number>();

function isDraftToolAction(value: unknown): value is DraftToolAction {
  return value === "show" || value === "inspect" || value === "report";
}

function createCapabilityToken(): string {
  return randomBytes(32).toString("base64url");
}

function draftMcpServerPath(): string {
  return fileURLToPath(new URL("./mcp/draftMcpServer.js", import.meta.url));
}

function rejectPendingForToken(token: string, message: string): void {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.binding.token !== token) continue;
    clearTimeout(pending.timeout);
    pendingRequests.delete(requestId);
    pending.reject(new Error(message));
  }
}

function observePreviewConsole(webContents: WebContents): void {
  if (observedWebContents.has(webContents.id)) return;
  observedWebContents.add(webContents.id);
  consoleEntriesByWebContents.set(webContents.id, []);
  webContents.on("console-message", (details) => {
    if (!details.frame || details.frame === webContents.mainFrame) return;
    const entries = consoleEntriesByWebContents.get(webContents.id);
    if (!entries) return;
    entries.push({
      level: details.level,
      message: details.message,
      source: details.sourceId || details.frame.url || undefined,
      line: details.lineNumber || undefined,
      timestamp: new Date().toISOString()
    });
    if (entries.length > 100) entries.splice(0, entries.length - 100);
  });
  webContents.once("destroyed", () => {
    observedWebContents.delete(webContents.id);
    consoleEntriesByWebContents.delete(webContents.id);
  });
}

function sanitizedCaptureRect(rect: DraftCaptureRect): DraftCaptureRect | undefined {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const width = Math.min(4096, Math.ceil(rect.width));
  const height = Math.min(4096, Math.ceil(rect.height));
  if (width < 1 || height < 1) return undefined;
  return { x, y, width, height };
}

async function enrichDraftToolResult(
  pending: Pick<PendingDraftToolRequest, "binding" | "action" | "params">,
  result: DraftToolResult
): Promise<DraftToolResult> {
  const { captureRect, ...publicResult } = result;
  if (pending.action !== "inspect") return publicResult;

  const enriched: DraftToolResult = { ...publicResult };
  if (pending.params.console !== false) {
    enriched.diagnostics = {
      console: (consoleEntriesByWebContents.get(pending.binding.webContents.id) ?? [])
        .slice(-20)
    };
  }

  if (pending.params.screenshot === true) {
    const rect = captureRect ? sanitizedCaptureRect(captureRect) : undefined;
    if (!rect || !publicResult.visible) {
      enriched.screenshotError =
        "Draft must be visible in the active conversation before it can be captured.";
    } else {
      try {
        const image = await pending.binding.webContents.capturePage(rect);
        const size = image.getSize();
        enriched.screenshot = {
          mimeType: "image/png",
          data: image.toPNG().toString("base64"),
          width: size.width,
          height: size.height
        };
      } catch (error) {
        enriched.screenshotError =
          (error as Error)?.message || "Failed to capture Draft preview.";
      }
    }
  }

  return enriched;
}

export async function registerDraftToolSession(input: {
  taskSessionId: string;
  conversationId: string;
  cwd: string;
  webContents: WebContents;
}): Promise<AcpStdioMcpServer> {
  unregisterDraftToolSession(input.taskSessionId);

  const port = await waitForActiveBridgePort();
  const token = createCapabilityToken();
  const binding: DraftToolBinding = { ...input, token };
  observePreviewConsole(input.webContents);
  bindingsByToken.set(token, binding);
  tokensByTaskSession.set(input.taskSessionId, token);

  return {
    name: "freebuddy-draft",
    command: process.execPath,
    args: [draftMcpServerPath()],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      {
        name: "FREEBUDDY_DRAFT_ENDPOINT",
        value: `http://127.0.0.1:${port}${DRAFT_TOOL_PATH}`
      },
      { name: "FREEBUDDY_DRAFT_TOKEN", value: token },
      {
        name: "FB_APP_VERSION",
        value: process.env.FB_APP_VERSION || "0.1.0"
      }
    ]
  };
}

export function unregisterDraftToolSession(taskSessionId: string): void {
  const token = tokensByTaskSession.get(taskSessionId);
  if (!token) return;
  tokensByTaskSession.delete(taskSessionId);
  bindingsByToken.delete(token);
  rejectPendingForToken(token, "Draft tool session ended before the request completed.");
}

async function dispatchDraftToolRequest(
  binding: DraftToolBinding,
  action: DraftToolAction,
  params: Record<string, unknown>
): Promise<DraftToolResult> {
  if (action === "show") {
    consoleEntriesByWebContents.set(binding.webContents.id, []);
  }
  const requestId = randomUUID();
  const event: DraftToolEvent = {
    requestId,
    conversationId: binding.conversationId,
    cwd: binding.cwd,
    action,
    params
  };

  const rendererResult = await new Promise<DraftToolResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Timed out waiting for the Draft preview renderer."));
    }, RENDERER_TIMEOUT_MS);

    pendingRequests.set(requestId, {
      binding,
      action,
      params,
      resolve,
      reject,
      timeout
    });
    const sent = safeSendToWebContents(
      binding.webContents,
      "freebuddy://draft-tool",
      event
    );
    if (!sent) {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      reject(new Error("FreeBuddy renderer is not available."));
    }
  });
  return enrichDraftToolResult({ binding, action, params }, rendererResult);
}

export function resolveDraftToolRequest(
  sender: WebContents,
  resolution: DraftToolResolution
): boolean {
  if (!resolution || typeof resolution.requestId !== "string") return false;
  const pending = pendingRequests.get(resolution.requestId);
  if (!pending || pending.binding.webContents.id !== sender.id) return false;
  if (
    !resolution.result ||
    resolution.result.conversationId !== pending.binding.conversationId
  ) {
    return false;
  }

  clearTimeout(pending.timeout);
  pendingRequests.delete(resolution.requestId);
  pending.resolve(resolution.result);
  return true;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Draft tool request body is too large.");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function bearerToken(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  if (!value?.startsWith("Bearer ")) return undefined;
  return value.slice("Bearer ".length).trim() || undefined;
}

export async function handleDraftToolHttpRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return false;
  }
  if (url.pathname !== DRAFT_TOOL_PATH) return false;

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }

  const token = bearerToken(req);
  const binding = token ? bindingsByToken.get(token) : undefined;
  if (!binding) {
    sendJson(res, 401, { ok: false, error: "invalid_capability_token" });
    return true;
  }

  try {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    if (!body || !isDraftToolAction(body.action)) {
      sendJson(res, 400, { ok: false, error: "invalid_action" });
      return true;
    }
    const params =
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};
    if (!token || bindingsByToken.get(token) !== binding) {
      sendJson(res, 410, { ok: false, error: "draft_tool_session_ended" });
      return true;
    }
    const result = await dispatchDraftToolRequest(binding, body.action, params);
    sendJson(res, 200, result as unknown as Record<string, unknown>);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: (error as Error)?.message || String(error)
    });
  }
  return true;
}
