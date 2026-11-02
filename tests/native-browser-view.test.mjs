import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relativePath) =>
  fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("native browser uses an isolated persistent session with hardened web preferences", () => {
  const source = read("electron/nativeBrowserViewService.ts");
  assert.match(source, /persist:freebuddy-browser/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /webSecurity:\s*true/);
  assert.match(source, /allowRunningInsecureContent:\s*false/);
  assert.match(source, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(source, /setPermissionRequestHandler/);
  assert.match(source, /will-download[\s\S]*preventDefault/);
});

test("native browser configures a browser-compatible UA before creating web contents", () => {
  const source = read("electron/nativeBrowserViewService.ts");
  const configureIndex = source.indexOf("configureSession(browserSession)");
  const createIndex = source.indexOf("new WebContentsView");

  assert.match(source, /buildBrowserCompatibleUserAgent/);
  assert.match(source, /buildBrowserAcceptLanguages/);
  assert.match(source, /ses\.setUserAgent\(userAgent, acceptLanguages\)/);
  assert.ok(configureIndex >= 0 && configureIndex < createIndex);
});

test("native browser accepts HTTP and HTTPS", () => {
  const source = read("electron/nativeBrowserViewService.ts");
  assert.match(source, /url\.protocol !== "https:"/);
  assert.match(source, /url\.protocol !== "http:"/);
  assert.match(source, /Browser URLs cannot contain credentials/);
  assert.doesNotMatch(source, /clearNativeBrowserData|clearData\(/);
});

test("agent tools operate on the native browser contents instead of the renderer placeholder", () => {
  const nativeService = read("electron/nativeBrowserViewService.ts");
  const listener = read("src/components/AgentBridge/AgentBridgeListener.tsx");
  const toolService = read("electron/browserToolService.ts");

  assert.match(nativeService, /runNativeBrowserTool/);
  assert.match(nativeService, /contents\.capturePage\(\)/);
  assert.match(nativeService, /contents\.executeJavaScript/);
  for (const action of ["inspect", "get_dom", "click", "fill", "scroll", "eval", "extract"]) {
    assert.ok(nativeService.includes(`input.action === "${action}"`));
  }
  assert.match(listener, /cliClient\.runNativeBrowserTool\(action, params\)/);
  assert.match(toolService, /if \(enriched\.screenshot\) return enriched/);
});

test("native browser IPC stays desktop-only", () => {
  const ipc = read("electron/cli/ipc.ts");
  const policy = read("electron/shared/remoteChannelPolicy.ts");
  for (const channel of [
    "cli:showNativeBrowser",
    "cli:setNativeBrowserBounds",
    "cli:hideNativeBrowser",
    "cli:navigateNativeBrowser",
    "cli:runNativeBrowserTool"
  ]) {
    assert.ok(ipc.includes(`registerHandler(\"${channel}\"`) || ipc.includes(`\"${channel}\"`));
    assert.ok(policy.includes(`\"${channel}\"`));
  }
});

test("browser UI no longer imports system cookies or strips anti-framing headers", () => {
  const toolbar = read("src/components/Browser/BrowserToolbar.tsx");
  const canvas = read("src/components/Browser/BrowserCanvas.tsx");
  const main = read("electron/main.ts");
  assert.doesNotMatch(toolbar, /importCookies|Cookie JSON|syncChrome/);
  assert.doesNotMatch(toolbar, /clearNativeBrowserData|onClearData|showClearData/);
  assert.match(canvas, /sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock allow-same-origin"/);
  assert.doesNotMatch(main, /setupFrameHeaderInterceptors|x-frame-options|frame-ancestors/);
});

test("agent browser tools do not require a second page-level grant", () => {
  const listener = read("src/components/AgentBridge/AgentBridgeListener.tsx");
  const store = read("src/store/browserStore.ts");
  const toolbar = read("src/components/Browser/BrowserToolbar.tsx");
  assert.doesNotMatch(store, /agentAllowedOrigins|setAgentRemoteOriginAllowed/);
  assert.doesNotMatch(listener, /remoteAccessAllowed|browserActionRequiresRemoteGrant/);
  assert.doesNotMatch(listener, /Agent access to this remote site is locked/);
  assert.doesNotMatch(toolbar, /ShieldCheck|ShieldOff|onAgentAccessChange/);
});

test("native browser tool calls return resolvedUrl and update store", () => {
  const nativeService = read("electron/nativeBrowserViewService.ts");
  const listener = read("src/components/AgentBridge/AgentBridgeListener.tsx");
  assert.match(nativeService, /pendingNavigationUrl/);
  assert.match(nativeService, /resolvedUrl,/);
  assert.match(nativeService, /effectiveUrl/);
  assert.match(listener, /useBrowserStore\.getState\(\)\.setNativeBrowserUrl\(conversationId, nativeResult\.resolvedUrl\)/);
});
