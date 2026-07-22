import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { BrowserWindow } from "electron";

import type { BrowserExtractionRecipe } from "./shared/infoCardProtocol.js";

const sessions = new Map<string, BrowserWindow>();
const MAX_TEXT_CHARS = 40_000;
const MAX_HTML_CHARS = 60_000;

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isBlockedHostname(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return true;
  }
  if (isIP(hostname) === 4) return isPrivateIpv4(hostname);
  if (isIP(hostname) === 6) {
    return (
      hostname === "::" ||
      hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      /^fe[89ab]/.test(hostname)
    );
  }
  return false;
}

function validateRemoteUrl(value: string): URL {
  const url = new URL(value.trim());
  if (url.protocol !== "https:") {
    throw new Error("Browser collection only supports HTTPS sources.");
  }
  if (url.username || url.password) {
    throw new Error("Browser collection URLs cannot contain credentials.");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error("Browser collection cannot access local or private-network hosts.");
  }
  return url;
}

function page(sessionId: string): BrowserWindow {
  const win = sessions.get(sessionId);
  if (!win || win.isDestroyed()) {
    throw new Error("Browser session is not open.");
  }
  return win;
}

async function waitForSelector(
  win: BrowserWindow,
  selector: string,
  timeoutMs = 12_000
): Promise<void> {
  const trimmed = selector.trim();
  if (!trimmed) return;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = await win.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(trimmed)}))`,
      true
    );
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for selector: ${trimmed}`);
}

export async function openBrowserSession(
  sessionId: string,
  rawUrl: string,
  visible = false
): Promise<{ url: string; title: string }> {
  closeBrowserSession(sessionId);
  const requestedUrl = validateRemoteUrl(rawUrl);
  const allowedOrigin = requestedUrl.origin;
  const partition = `freebuddy-browser-${randomUUID()}`;
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      partition
    }
  });
  sessions.set(sessionId, win);
  win.once("closed", () => {
    if (sessions.get(sessionId) === win) sessions.delete(sessionId);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const restrictNavigation = (event: Electron.Event, target: string) => {
    try {
      const parsed = validateRemoteUrl(target);
      if (parsed.origin !== allowedOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  win.webContents.on("will-navigate", restrictNavigation);
  win.webContents.on("will-redirect", restrictNavigation);
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  win.webContents.session.on("will-download", (event) => event.preventDefault());

  try {
    await win.loadURL(requestedUrl.toString());
    if (visible && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
    return {
      url: win.webContents.getURL(),
      title: win.webContents.getTitle()
    };
  } catch (error) {
    closeBrowserSession(sessionId);
    throw error;
  }
}

export async function inspectBrowserSession(
  sessionId: string,
  options: { screenshot?: boolean; includeHtml?: boolean } = {}
): Promise<Record<string, unknown>> {
  const win = page(sessionId);
  const inspected = (await win.webContents.executeJavaScript(
    `(() => {
      const compact = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const interactive = Array.from(document.querySelectorAll("a,button,input,select,textarea,[role='button'],[role='link'],table"))
        .slice(0, 160)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          id: element.id || undefined,
          className: typeof element.className === "string" ? element.className.slice(0, 240) : undefined,
          role: element.getAttribute("role") || undefined,
          name: element.getAttribute("name") || undefined,
          ariaLabel: element.getAttribute("aria-label") || undefined,
          text: compact(element.textContent).slice(0, 320)
        }));
      return {
        url: location.href,
        title: document.title,
        text: compact(document.body?.innerText).slice(0, ${MAX_TEXT_CHARS}),
        html: ${options.includeHtml === false ? "undefined" : `document.body?.innerHTML.slice(0, ${MAX_HTML_CHARS})`},
        interactive
      };
    })()`,
    true
  )) as Record<string, unknown>;
  if (options.screenshot) {
    const image = await win.webContents.capturePage();
    inspected.screenshot = {
      mimeType: "image/png",
      data: image.toPNG().toString("base64"),
      width: image.getSize().width,
      height: image.getSize().height
    };
  }
  return inspected;
}

export async function clickBrowserSession(
  sessionId: string,
  selector: string
): Promise<void> {
  const win = page(sessionId);
  const clicked = await win.webContents.executeJavaScript(
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector.trim())});
      if (!(element instanceof HTMLElement)) return false;
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return true;
    })()`,
    true
  );
  if (!clicked) throw new Error(`Element not found: ${selector}`);
}

export async function typeBrowserSession(
  sessionId: string,
  selector: string,
  value: string
): Promise<void> {
  const win = page(sessionId);
  const typed = await win.webContents.executeJavaScript(
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector.trim())});
      if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return false;
      element.focus();
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
    true
  );
  if (!typed) throw new Error(`Input not found: ${selector}`);
}

export async function scrollBrowserSession(
  sessionId: string,
  y = 700
): Promise<void> {
  const win = page(sessionId);
  await win.webContents.executeJavaScript(
    `window.scrollBy({ top: ${Math.max(-5000, Math.min(5000, Math.round(y)))}, behavior: "instant" })`,
    true
  );
}

export async function extractBrowserSession(
  sessionId: string,
  recipe: BrowserExtractionRecipe
): Promise<Array<Record<string, string>>> {
  const win = page(sessionId);
  if (recipe.waitForSelector) {
    await waitForSelector(win, recipe.waitForSelector);
  }
  const maxItems = Math.max(1, Math.min(recipe.maxItems ?? 8, 30));
  const rows = (await win.webContents.executeJavaScript(
    `(() => {
      const recipe = ${JSON.stringify({
        rowSelector: recipe.rowSelector.trim(),
        fields: recipe.fields,
        maxItems
      })};
      const text = (element) => String(element?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500);
      return Array.from(document.querySelectorAll(recipe.rowSelector))
        .slice(0, recipe.maxItems)
        .map((row) => Object.fromEntries(
          Object.entries(recipe.fields).map(([name, selector]) => [name, text(row.querySelector(selector))])
        ));
    })()`,
    true
  )) as Array<Record<string, unknown>>;
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, String(value ?? "").trim()])
    )
  );
}

export function closeBrowserSession(sessionId: string): void {
  const win = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (win && !win.isDestroyed()) win.destroy();
}

export async function collectBrowserRecipe(
  recipe: BrowserExtractionRecipe
): Promise<Array<Record<string, string>>> {
  const sessionId = `card-${randomUUID()}`;
  try {
    await openBrowserSession(sessionId, recipe.url);
    return await extractBrowserSession(sessionId, recipe);
  } finally {
    closeBrowserSession(sessionId);
  }
}
