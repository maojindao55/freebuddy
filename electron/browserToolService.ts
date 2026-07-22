import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import {
  clickBrowserSession,
  closeBrowserSession,
  extractBrowserSession,
  inspectBrowserSession,
  openBrowserSession,
  scrollBrowserSession,
  typeBrowserSession
} from "./browserCollector.js";
import { waitForActiveBridgePort } from "./agentBridge.js";
import type { AcpStdioMcpServer } from "./shared/draftToolProtocol.js";
import type { BrowserExtractionRecipe } from "./shared/infoCardProtocol.js";

const BROWSER_TOOL_PATH = "/freebuddy/browser-tool";
const MAX_REQUEST_BYTES = 256 * 1024;
const bindingsByToken = new Map<string, { taskSessionId: string }>();
const tokensByTaskSession = new Map<string, string>();

type BrowserAction =
  | "open"
  | "inspect"
  | "click"
  | "type"
  | "scroll"
  | "extract"
  | "close";

function browserMcpServerPath(): string {
  return fileURLToPath(new URL("./mcp/browserMcpServer.js", import.meta.url));
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

async function dispatch(
  taskSessionId: string,
  action: BrowserAction,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (action === "open") {
    return {
      ok: true,
      ...(await openBrowserSession(
        taskSessionId,
        stringParam(params, "url"),
        params.visible === true
      ))
    };
  }
  if (action === "inspect") {
    return {
      ok: true,
      ...(await inspectBrowserSession(taskSessionId, {
        screenshot: params.screenshot === true,
        includeHtml: params.includeHtml !== false
      }))
    };
  }
  if (action === "click") {
    await clickBrowserSession(taskSessionId, stringParam(params, "selector"));
    return { ok: true };
  }
  if (action === "type") {
    await typeBrowserSession(
      taskSessionId,
      stringParam(params, "selector"),
      typeof params.value === "string" ? params.value : ""
    );
    return { ok: true };
  }
  if (action === "scroll") {
    await scrollBrowserSession(taskSessionId, Number(params.y) || 700);
    return { ok: true };
  }
  if (action === "extract") {
    const rows = await extractBrowserSession(
      taskSessionId,
      recipeFromParams(params)
    );
    return { ok: true, rows };
  }
  closeBrowserSession(taskSessionId);
  return { ok: true };
}

export async function registerBrowserToolSession(
  taskSessionId: string
): Promise<AcpStdioMcpServer> {
  unregisterBrowserToolSession(taskSessionId);
  const port = await waitForActiveBridgePort();
  const token = randomBytes(32).toString("base64url");
  bindingsByToken.set(token, { taskSessionId });
  tokensByTaskSession.set(taskSessionId, token);
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
      { name: "FB_APP_VERSION", value: process.env.FB_APP_VERSION || "0.1.0" }
    ]
  };
}

export function unregisterBrowserToolSession(taskSessionId: string): void {
  const token = tokensByTaskSession.get(taskSessionId);
  if (token) bindingsByToken.delete(token);
  tokensByTaskSession.delete(taskSessionId);
  closeBrowserSession(taskSessionId);
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Browser tool request is too large.");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function isAction(value: unknown): value is BrowserAction {
  return [
    "open",
    "inspect",
    "click",
    "type",
    "scroll",
    "extract",
    "close"
  ].includes(String(value));
}

export async function handleBrowserToolHttpRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname !== BROWSER_TOOL_PATH) return false;
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const binding = token ? bindingsByToken.get(token) : undefined;
  if (!binding) {
    sendJson(res, 401, { ok: false, error: "invalid_capability_token" });
    return true;
  }
  try {
    const body = await readJsonBody(req);
    if (!isAction(body.action)) {
      sendJson(res, 400, { ok: false, error: "invalid_action" });
      return true;
    }
    const params =
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};
    sendJson(res, 200, await dispatch(binding.taskSessionId, body.action, params));
  } catch (error) {
    sendJson(res, 500, { ok: false, error: (error as Error)?.message || String(error) });
  }
  return true;
}
