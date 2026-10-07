import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { WebContents } from "electron";

import { waitForActiveBridgePort } from "./agentBridge.js";
import { safeSendToWebContents } from "./cli/ipcSend.js";
import type {
  AcpStdioMcpServer,
  BrowserCaptureRect,
  BrowserConsoleEntry,
  BrowserToolAction,
  BrowserToolEvent,
  BrowserToolResolution,
  BrowserToolResult
} from "./shared/browserToolProtocol.js";
import type { BrowserExtractionRecipe } from "./shared/infoCardProtocol.js";

const BROWSER_TOOL_PATH = "/freebuddy/browser-tool";
const MAX_REQUEST_BYTES = 256 * 1024;
const RENDERER_TIMEOUT_MS = 20_000;

interface BrowserToolBinding {
  token: string;
  taskSessionId: string;
  conversationId?: string;
  cwd?: string;
  webContents?: WebContents;
  suspended?: boolean;
  epoch?: number;
}

interface PendingBrowserToolRequest {
  binding: BrowserToolBinding;
  action: BrowserToolAction;
  params: Record<string, unknown>;
  resolve: (result: BrowserToolResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const bindingsByToken = new Map<string, BrowserToolBinding>();
const tokensByTaskSession = new Map<string, string>();
const pendingRequests = new Map<string, PendingBrowserToolRequest>();
const consoleEntriesByWebContents = new Map<number, BrowserConsoleEntry[]>();
const observedWebContents = new Set<number>();

function isBrowserToolAction(value: unknown): value is BrowserToolAction {
  return [
    "navigate",
    "inspect",
    "screenshot",
    "click",
    "fill",
    "type",
    "scroll",
    "eval",
    "get_dom",
    "extract",
    "report",
    "open",
    "close",
    "show"
  ].includes(String(value));
}

function createCapabilityToken(): string {
  return randomBytes(32).toString("base64url");
}

function browserMcpServerPath(): string {
  return fileURLToPath(new URL("./mcp/browserMcpServer.js", import.meta.url));
}

function rejectPendingForToken(token: string, message: string): void {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.binding.token !== token) continue;
    clearTimeout(pending.timeout);
    pendingRequests.delete(requestId);
    pending.reject(new Error(message));
  }
}

function observeBrowserConsole(webContents: WebContents): void {
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

function sanitizedCaptureRect(rect: BrowserCaptureRect): BrowserCaptureRect | undefined {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const width = Math.min(4096, Math.ceil(rect.width));
  const height = Math.min(4096, Math.ceil(rect.height));
  if (width < 1 || height < 1) return undefined;
  return { x, y, width, height };
}

async function enrichBrowserToolResult(
  pending: Pick<PendingBrowserToolRequest, "binding" | "action" | "params">,
  result: BrowserToolResult
): Promise<BrowserToolResult> {
  const { captureRect, ...publicResult } = result;
  if (pending.action !== "inspect" && pending.action !== "screenshot") return publicResult;

  const enriched: BrowserToolResult = { ...publicResult };
  if (
    pending.binding.webContents &&
    pending.params.console !== false &&
    !enriched.diagnostics
  ) {
    enriched.diagnostics = {
      console: (consoleEntriesByWebContents.get(pending.binding.webContents.id) ?? []).slice(-20)
    };
  }

  if (pending.params.screenshot === true || pending.action === "screenshot") {
    if (enriched.screenshot) return enriched;
    if (!pending.binding.webContents) {
      enriched.screenshotError = "No active browser renderer available to capture screenshot.";
    } else {
      const rect = captureRect ? sanitizedCaptureRect(captureRect) : undefined;
      if (!rect || !publicResult.visible) {
        enriched.screenshotError =
          "Browser must be visible in the active conversation before it can be captured.";
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
            (error as Error)?.message || "Failed to capture Browser preview.";
        }
      }
    }
  }

  return enriched;
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${name}.`);
  }
  return value.trim();
}

function recipeFromParams(
  params: Record<string, unknown>,
  fallbackUrl?: string
): BrowserExtractionRecipe {
  const fieldsInput = params.fields;
  if (!fieldsInput || typeof fieldsInput !== "object" || Array.isArray(fieldsInput)) {
    throw new Error("Extraction fields must be an object of CSS selectors.");
  }
  const fields = Object.fromEntries(
    Object.entries(fieldsInput)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key.trim(), value.trim()])
      .filter(([key, value]) => key && value)
  );
  if (!Object.keys(fields).length) throw new Error("At least one extraction field is required.");
  return {
    url:
      typeof params.url === "string" && params.url.trim()
        ? params.url.trim()
        : fallbackUrl || "https://invalid.local",
    rowSelector: stringParam(params, "rowSelector"),
    fields,
    ...(typeof params.waitForSelector === "string" && params.waitForSelector.trim()
      ? { waitForSelector: params.waitForSelector.trim() }
      : {}),
    maxItems: Math.max(1, Math.min(Number(params.maxItems) || 8, 20))
  };
}

async function dispatchBrowserToolRequest(
  binding: BrowserToolBinding,
  action: BrowserToolAction,
  params: Record<string, unknown>
): Promise<BrowserToolResult> {
  // If we have a bound Desktop WebContents (visual browser in active conversation)
  if (binding.webContents) {
    if (action === "navigate" || action === "show" || action === "open") {
      consoleEntriesByWebContents.set(binding.webContents.id, []);
    }
    const requestId = randomUUID();
    const event: BrowserToolEvent = {
      requestId,
      conversationId: binding.conversationId || "",
      cwd: binding.cwd || "",
      action,
      params
    };

    const rendererResult = await new Promise<BrowserToolResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error("Timed out waiting for the Browser preview renderer."));
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
        binding.webContents!,
        "freebuddy://browser-tool",
        event
      );
      if (!sent) {
        clearTimeout(timeout);
        pendingRequests.delete(requestId);
        reject(new Error("FreeBuddy renderer is not available."));
      }
    });
    return enrichBrowserToolResult({ binding, action, params }, rendererResult);
  }

  // Headless fallback using browserCollector
  const collector = await import("./browserCollector.js");
  const taskSessionId = binding.taskSessionId;
  if (action === "open" || action === "navigate" || action === "show") {
    const rawUrl = typeof params.url === "string" ? params.url : typeof params.target === "string" ? params.target : "";
    if (!rawUrl) throw new Error("Missing url parameter.");
    const res = await collector.openBrowserSession(taskSessionId, rawUrl, params.visible === true);
    return { ok: true, conversationId: binding.conversationId || "", cwd: binding.cwd || "", ...res };
  }
  if (action === "inspect") {
    const res = await collector.inspectBrowserSession(taskSessionId, {
      screenshot: params.screenshot === true,
      includeHtml: params.includeHtml !== false
    });
    return { ok: true, conversationId: binding.conversationId || "", cwd: binding.cwd || "", ...res };
  }
  if (action === "click") {
    await collector.clickBrowserSession(taskSessionId, stringParam(params, "selector"));
    return { ok: true, conversationId: binding.conversationId || "", cwd: binding.cwd || "" };
  }
  if (action === "type" || action === "fill") {
    const val = typeof params.value === "string" ? params.value : typeof params.text === "string" ? params.text : "";
    await collector.typeBrowserSession(taskSessionId, stringParam(params, "selector"), val);
    return { ok: true, conversationId: binding.conversationId || "", cwd: binding.cwd || "" };
  }
  if (action === "scroll") {
    await collector.scrollBrowserSession(taskSessionId, Number(params.y) || 700);
    return { ok: true, conversationId: binding.conversationId || "", cwd: binding.cwd || "" };
  }
  if (action === "extract") {
    const rows = await collector.extractBrowserSession(taskSessionId, recipeFromParams(params));
    return { ok: true, conversationId: binding.conversationId || "", cwd: binding.cwd || "", rows };
  }
  if (action === "close") {
    collector.closeBrowserSession(taskSessionId);
    return { ok: true, conversationId: binding.conversationId || "", cwd: binding.cwd || "" };
  }
  return { ok: true, conversationId: binding.conversationId || "", cwd: binding.cwd || "" };
}

export async function registerBrowserToolSession(input: {
  taskSessionId: string;
  conversationId?: string;
  cwd?: string;
  webContents?: WebContents;
} | string): Promise<AcpStdioMcpServer> {
  const options = typeof input === "string" ? { taskSessionId: input } : input;
  unregisterBrowserToolSession(options.taskSessionId);

  const port = await waitForActiveBridgePort();
  const token = createCapabilityToken();
  const binding: BrowserToolBinding = { ...options, token };
  if (options.webContents) {
    observeBrowserConsole(options.webContents);
  }
  bindingsByToken.set(token, binding);
  tokensByTaskSession.set(options.taskSessionId, token);

  return {
    name: "freebuddy-browser",
    command: process.execPath,
    args: [browserMcpServerPath()],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      {
        name: "FREEBUDDY_BROWSER_ENDPOINT",
        value: `http://127.0.0.1:${port}${BROWSER_TOOL_PATH}`
      },
      { name: "FREEBUDDY_BROWSER_TOKEN", value: token },
      {
        name: "FB_APP_VERSION",
        value: process.env.FB_APP_VERSION || "0.1.0"
      }
    ]
  };
}

export function unregisterBrowserToolSession(taskSessionId: string): void {
  const token = tokensByTaskSession.get(taskSessionId);
  if (!token) return;
  tokensByTaskSession.delete(taskSessionId);
  bindingsByToken.delete(token);
  rejectPendingForToken(token, "Browser tool session ended before the request completed.");
  void import("./browserCollector.js")
    .then((c) => c.closeBrowserSession(taskSessionId))
    .catch(() => {});
}

/** Keep a native MCP connection's credential while rebinding it to the next run. */
export function rebindBrowserToolSession(previousRunId: string, input: {
  taskSessionId: string; conversationId?: string; cwd?: string; webContents?: WebContents;
}): boolean {
  const token = tokensByTaskSession.get(previousRunId);
  const binding = token ? bindingsByToken.get(token) : undefined;
  if (!token || !binding || !binding.suspended || binding.conversationId !== input.conversationId ||
      binding.cwd !== input.cwd || binding.webContents !== input.webContents) return false;
  rejectPendingForToken(token, "Browser tool run changed.");
  tokensByTaskSession.delete(previousRunId);
  Object.assign(binding, input, { suspended: false, epoch: (binding.epoch ?? 0) + 1 });
  tokensByTaskSession.set(input.taskSessionId, token);
  void import("./browserCollector.js").then(c => c.closeBrowserSession(previousRunId)).catch(() => {});
  return true;
}

export function suspendBrowserToolSession(taskSessionId: string): void {
  const token = tokensByTaskSession.get(taskSessionId);
  const binding = token ? bindingsByToken.get(token) : undefined;
  if (!token || !binding) return;
  binding.suspended = true;
  binding.epoch = (binding.epoch ?? 0) + 1;
  rejectPendingForToken(token, "Browser tool turn completed.");
}

export function resolveBrowserToolRequest(
  sender: WebContents | null | undefined,
  resolution: BrowserToolResolution
): boolean {
  if (!resolution || typeof resolution.requestId !== "string") return false;
  const pending = pendingRequests.get(resolution.requestId);
  if (!pending) return false;
  if (sender && pending.binding.webContents && pending.binding.webContents.id !== sender.id) {
    return false;
  }
  if (
    resolution.result &&
    pending.binding.conversationId &&
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
      throw new Error("Payload too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export async function handleBrowserToolHttpRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  if (!req.url) return false;
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== BROWSER_TOOL_PATH) {
    return false;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return true;
  }

  const auth = req.headers.authorization;
  const match = typeof auth === "string" ? /^Bearer\s+(\S+)$/i.exec(auth) : null;
  const token = match?.[1]?.trim();
  const binding = token ? bindingsByToken.get(token) : undefined;
  const epoch = binding?.epoch;
  if (!token || !binding || binding.suspended) {
    sendJson(res, 401, { ok: false, error: "invalid_capability_token" });
    return true;
  }

  try {
    const body = (await readJsonBody(req)) as {
      action?: string;
      params?: Record<string, unknown>;
    };
    if (!body || typeof body.action !== "string") {
      sendJson(res, 400, { ok: false, error: "invalid_action" });
      return true;
    }
    const params = body.params && typeof body.params === "object" ? body.params : {};
    if (!token || bindingsByToken.get(token) !== binding || binding.suspended || binding.epoch !== epoch) {
      sendJson(res, 410, { ok: false, error: "browser_tool_session_ended" });
      return true;
    }
    const result = await dispatchBrowserToolRequest(binding, body.action as BrowserToolAction, params);
    sendJson(res, 200, result as unknown as Record<string, unknown>);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: (error as Error)?.message || String(error)
    });
  }
  return true;
}
