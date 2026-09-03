import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  type Rectangle,
  type Session
} from "electron";

import { safeSendToWebContents } from "./cli/ipcSend.js";
import {
  buildBrowserAcceptLanguages,
  buildBrowserCompatibleUserAgent
} from "./shared/browserUserAgent.js";
import type {
  BrowserConsoleEntry,
  BrowserToolAction,
  BrowserToolResult
} from "./shared/browserToolProtocol.js";

const BROWSER_PARTITION = "persist:freebuddy-browser";
const STATE_CHANNEL = "freebuddy://native-browser-state";
const MAX_DOM_CHARS = 200_000;
const MAX_TEXT_CHARS = 80_000;
const MAX_EVAL_CHARS = 10_000;

export interface NativeBrowserViewState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  visible: boolean;
}

export interface NativeBrowserViewBounds extends Rectangle {}

let browserView: WebContentsView | null = null;
let ownerWindow: BrowserWindow | null = null;
let isVisible = false;
let sessionConfigured = false;
let consoleEntries: BrowserConsoleEntry[] = [];
let pendingNavigationUrl: string | null = null;

function parseAllowedUrl(rawUrl: string): URL {
  const url = new URL(rawUrl.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The isolated browser only supports HTTP and HTTPS pages.");
  }
  if (url.username || url.password) {
    throw new Error("Browser URLs cannot contain credentials.");
  }
  return url;
}

function normalizeBounds(bounds: NativeBrowserViewBounds): Rectangle {
  const x = Math.max(0, Math.floor(Number(bounds.x) || 0));
  const y = Math.max(0, Math.floor(Number(bounds.y) || 0));
  const width = Math.max(1, Math.min(8192, Math.floor(Number(bounds.width) || 1)));
  const height = Math.max(1, Math.min(8192, Math.floor(Number(bounds.height) || 1)));
  return { x, y, width, height };
}

function currentState(): NativeBrowserViewState {
  const contents = browserView?.webContents;
  const currentUrl = contents && !contents.isDestroyed() ? contents.getURL() : "";
  const isLoading = Boolean(contents && !contents.isDestroyed() && contents.isLoading());
  const effectiveUrl = isLoading && pendingNavigationUrl ? pendingNavigationUrl : currentUrl;
  return {
    url: effectiveUrl,
    title: contents && !contents.isDestroyed() ? contents.getTitle() : "",
    canGoBack:
      Boolean(contents && !contents.isDestroyed()) &&
      Boolean(contents?.navigationHistory.canGoBack()),
    canGoForward:
      Boolean(contents && !contents.isDestroyed()) &&
      Boolean(contents?.navigationHistory.canGoForward()),
    isLoading,
    visible: isVisible
  };
}

function emitState(): NativeBrowserViewState {
  const state = currentState();
  if (ownerWindow && !ownerWindow.isDestroyed()) {
    safeSendToWebContents(ownerWindow.webContents, STATE_CHANNEL, state);
  }
  return state;
}

function activeBrowserContents() {
  const contents = browserView?.webContents;
  if (!contents || contents.isDestroyed() || !contents.getURL()) {
    throw new Error("The isolated browser view is not open.");
  }
  return contents;
}

function requiredStringParam(
  params: Record<string, unknown>,
  key: string,
  maxLength: number
): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${key}.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${key} is too long.`);
  }
  return value.trim();
}

async function waitForSelector(selector: string, timeoutMs = 12_000): Promise<void> {
  const contents = activeBrowserContents();
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = await contents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      true
    );
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for selector: ${selector}`);
}

function configureSession(ses: Session): void {
  if (sessionConfigured) return;
  sessionConfigured = true;
  const userAgent = buildBrowserCompatibleUserAgent(
    ses.getUserAgent(),
    app.getName()
  );
  const acceptLanguages = buildBrowserAcceptLanguages(
    app.getLocale(),
    app.getPreferredSystemLanguages()
  );
  ses.setUserAgent(userAgent, acceptLanguages);
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.on("will-download", (event) => event.preventDefault());
}

function destroyBrowserView(): void {
  const view = browserView;
  const owner = ownerWindow;
  browserView = null;
  isVisible = false;
  pendingNavigationUrl = null;
  if (view && owner && !owner.isDestroyed()) {
    owner.contentView.removeChildView(view);
  }
  if (view && !view.webContents.isDestroyed()) {
    view.webContents.close();
  }
  ownerWindow = null;
}

function ensureBrowserView(win: BrowserWindow): WebContentsView {
  if (browserView && ownerWindow === win && !browserView.webContents.isDestroyed()) {
    return browserView;
  }
  destroyBrowserView();

  const browserSession = session.fromPartition(BROWSER_PARTITION, { cache: true });
  configureSession(browserSession);

  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  browserView = view;
  ownerWindow = win;
  isVisible = false;
  view.setVisible(false);
  view.setBackgroundColor("#ffffff");
  win.contentView.addChildView(view);

  const contents = view.webContents;
  const updateState = () => emitState();
  contents.on("console-message", (details) => {
    consoleEntries.push({
      level: details.level,
      message: details.message,
      source: details.sourceId || undefined,
      line: details.lineNumber || undefined,
      timestamp: new Date().toISOString()
    });
    if (consoleEntries.length > 100) {
      consoleEntries.splice(0, consoleEntries.length - 100);
    }
  });
  contents.on("did-start-loading", updateState);
  contents.on("did-stop-loading", () => {
    pendingNavigationUrl = null;
    updateState();
  });
  contents.on("did-navigate", () => {
    pendingNavigationUrl = null;
    updateState();
  });
  contents.on("did-navigate-in-page", () => {
    pendingNavigationUrl = null;
    updateState();
  });
  contents.on("page-title-updated", updateState);
  contents.on("render-process-gone", () => {
    pendingNavigationUrl = null;
    updateState();
  });
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const target = parseAllowedUrl(url);
      void contents.loadURL(target.toString());
    } catch {
      // Block non-HTTP/HTTPS popups and unsupported schemes.
    }
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    try {
      parseAllowedUrl(url);
    } catch {
      event.preventDefault();
    }
  });
  contents.on("will-redirect", (event, url) => {
    try {
      parseAllowedUrl(url);
    } catch {
      event.preventDefault();
    }
  });

  win.once("closed", destroyBrowserView);
  return view;
}

export async function showNativeBrowserView(
  win: BrowserWindow,
  input: { url: string; bounds: NativeBrowserViewBounds }
): Promise<NativeBrowserViewState> {
  const url = parseAllowedUrl(input.url);
  const view = ensureBrowserView(win);
  view.setBounds(normalizeBounds(input.bounds));
  view.setVisible(true);
  isVisible = true;

  if (view.webContents.getURL() !== url.toString()) {
    consoleEntries = [];
    pendingNavigationUrl = url.toString();
    emitState();
    try {
      await view.webContents.loadURL(url.toString());
    } finally {
      pendingNavigationUrl = null;
    }
  }
  return emitState();
}

export function setNativeBrowserViewBounds(
  win: BrowserWindow,
  bounds: NativeBrowserViewBounds
): NativeBrowserViewState {
  const view = ensureBrowserView(win);
  view.setBounds(normalizeBounds(bounds));
  return emitState();
}

export function hideNativeBrowserView(): NativeBrowserViewState {
  if (browserView && !browserView.webContents.isDestroyed()) {
    browserView.setVisible(false);
  }
  isVisible = false;
  return emitState();
}

export async function navigateNativeBrowserView(url: string): Promise<NativeBrowserViewState> {
  const target = parseAllowedUrl(url);
  if (!browserView || browserView.webContents.isDestroyed()) {
    throw new Error("The isolated browser view is not open.");
  }
  consoleEntries = [];
  pendingNavigationUrl = target.toString();
  emitState();
  try {
    await browserView.webContents.loadURL(target.toString());
  } finally {
    pendingNavigationUrl = null;
  }
  return emitState();
}

export function goBackNativeBrowserView(): NativeBrowserViewState {
  const contents = browserView?.webContents;
  if (contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack()) {
    contents.navigationHistory.goBack();
  }
  return emitState();
}

export function goForwardNativeBrowserView(): NativeBrowserViewState {
  const contents = browserView?.webContents;
  if (contents && !contents.isDestroyed() && contents.navigationHistory.canGoForward()) {
    contents.navigationHistory.goForward();
  }
  return emitState();
}

export function reloadNativeBrowserView(): NativeBrowserViewState {
  const contents = browserView?.webContents;
  if (contents && !contents.isDestroyed()) contents.reload();
  return emitState();
}

export async function runNativeBrowserTool(input: {
  action: BrowserToolAction;
  params?: Record<string, unknown>;
}): Promise<Partial<BrowserToolResult>> {
  const contents = activeBrowserContents();
  const params = input.params ?? {};
  const currentUrl = contents.getURL();
  let toolResult: Partial<BrowserToolResult>;

  if (input.action === "screenshot") {
    const image = await contents.capturePage();
    const size = image.getSize();
    toolResult = {
      screenshot: {
        mimeType: "image/png",
        data: image.toPNG().toString("base64"),
        width: size.width,
        height: size.height
      },
      diagnostics: { console: consoleEntries.slice(-20) }
    };
  } else if (input.action === "inspect") {
    const inspected = (await contents.executeJavaScript(
      `(() => {
        const compact = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const selectorFor = (element) => {
          if (element.id) return "#" + CSS.escape(element.id);
          const name = element.getAttribute("name");
          if (name) return element.tagName.toLowerCase() + "[name=" + JSON.stringify(name) + "]";
          const parent = element.parentElement;
          if (!parent) return element.tagName.toLowerCase();
          const siblings = Array.from(parent.children).filter((item) => item.tagName === element.tagName);
          return element.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(element) + 1) + ")";
        };
        const interactive = Array.from(document.querySelectorAll("a,button,input,select,textarea,[contenteditable='true'],[role='button'],[role='link']"))
          .slice(0, 200)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            selector: selectorFor(element),
            role: element.getAttribute("role") || undefined,
            name: element.getAttribute("name") || undefined,
            ariaLabel: element.getAttribute("aria-label") || undefined,
            text: compact(element.textContent).slice(0, 320)
          }));
        return {
          url: location.href,
          title: document.title,
          text: compact(document.body?.innerText).slice(0, ${MAX_TEXT_CHARS}),
          html: ${params.includeHtml === true ? `document.documentElement?.outerHTML.slice(0, ${MAX_DOM_CHARS})` : "undefined"},
          interactive
        };
      })()`,
      true
    )) as Record<string, unknown>;
    const result: Partial<BrowserToolResult> = {
      result: inspected,
      diagnostics: { console: consoleEntries.slice(-20) }
    };
    if (typeof inspected.html === "string") result.dom = inspected.html;
    if (params.screenshot === true) {
      const image = await contents.capturePage();
      const size = image.getSize();
      result.screenshot = {
        mimeType: "image/png",
        data: image.toPNG().toString("base64"),
        width: size.width,
        height: size.height
      };
    }
    toolResult = result;
  } else if (input.action === "get_dom") {
    const mode = typeof params.mode === "string" ? params.mode : "markdown";
    const dom = (await contents.executeJavaScript(
      `(() => {
        const mode = ${JSON.stringify(mode)};
        if (mode === "html") return String(document.documentElement?.outerHTML || "").slice(0, ${MAX_DOM_CHARS});
        if (mode === "accessibility_tree") {
          const nodes = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,a,button,input,select,textarea,[role],[aria-label]"))
            .slice(0, 500)
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role") || undefined,
              ariaLabel: element.getAttribute("aria-label") || undefined,
              text: String(element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500)
            }));
          return JSON.stringify(nodes, null, 2).slice(0, ${MAX_DOM_CHARS});
        }
        return String(document.body?.innerText || "").slice(0, ${MAX_TEXT_CHARS});
      })()`,
      true
    )) as string;
    toolResult = { dom, result: dom };
  } else if (input.action === "click") {
    const selector = requiredStringParam(params, "selector", 500);
    const clicked = await contents.executeJavaScript(
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return false;
        element.scrollIntoView({ block: "center", inline: "center" });
        if (typeof element.click === "function") element.click();
        else element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      })()`,
      true
    );
    if (!clicked) throw new Error(`Element not found: ${selector}`);
    toolResult = { result: { clicked: true, selector } };
  } else if (input.action === "fill" || input.action === "type") {
    const selector = requiredStringParam(params, "selector", 500);
    const rawValue = typeof params.value === "string" ? params.value : params.text;
    if (typeof rawValue !== "string" || rawValue.length > 4000) {
      throw new Error("Missing or invalid text value.");
    }
    const filled = await contents.executeJavaScript(
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) return false;
        element.focus();
        const value = ${JSON.stringify(rawValue)};
        if (element.isContentEditable) {
          element.textContent = value;
        } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          if (setter) setter.call(element, value);
          else element.value = value;
        } else {
          return false;
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`,
      true
    );
    if (!filled) throw new Error(`Input not found: ${selector}`);
    toolResult = { result: { filled: true, selector } };
  } else if (input.action === "scroll") {
    const y = Math.max(-5000, Math.min(5000, Math.round(Number(params.y) || 700)));
    const result = await contents.executeJavaScript(
      `(() => {
        window.scrollBy({ top: ${y}, behavior: "instant" });
        return { x: window.scrollX, y: window.scrollY };
      })()`,
      true
    );
    toolResult = { result };
  } else if (input.action === "eval") {
    const script = requiredStringParam(params, "script", MAX_EVAL_CHARS);
    toolResult = { result: await contents.executeJavaScript(script, true) };
  } else if (input.action === "extract") {
    const waitSelector = typeof params.waitForSelector === "string"
      ? params.waitForSelector.trim()
      : "";
    if (waitSelector) await waitForSelector(waitSelector);
    const rowSelector = requiredStringParam(params, "rowSelector", 500);
    const rawFields = params.fields;
    if (!rawFields || typeof rawFields !== "object" || Array.isArray(rawFields)) {
      throw new Error("Extraction fields must be an object of CSS selectors.");
    }
    const fields = Object.fromEntries(
      Object.entries(rawFields)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => [key.trim(), value.trim()])
        .filter(([key, value]) => key && value)
    );
    if (!Object.keys(fields).length) {
      throw new Error("At least one extraction field is required.");
    }
    const maxItems = Math.max(1, Math.min(Math.round(Number(params.maxItems) || 8), 20));
    const rows = (await contents.executeJavaScript(
      `(() => {
        const rowSelector = ${JSON.stringify(rowSelector)};
        const fields = ${JSON.stringify(fields)};
        const text = (element) => String(element?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500);
        return Array.from(document.querySelectorAll(rowSelector))
          .slice(0, ${maxItems})
          .map((row) => Object.fromEntries(
            Object.entries(fields).map(([name, selector]) => [name, text(row.querySelector(selector))])
          ));
      })()`,
      true
    )) as unknown[];
    toolResult = { rows, result: rows };
  } else {
    throw new Error(`Unsupported native browser action: ${input.action}`);
  }

  const inspectedUrl =
    toolResult?.result &&
    typeof toolResult.result === "object" &&
    "url" in toolResult.result &&
    typeof (toolResult.result as { url?: unknown }).url === "string"
      ? ((toolResult.result as { url: string }).url.trim() || undefined)
      : undefined;
  const resolvedUrl = inspectedUrl || currentUrl;

  return {
    resolvedUrl,
    target: resolvedUrl,
    ...toolResult
  };
}

export function getNativeBrowserViewState(): NativeBrowserViewState {
  return currentState();
}
