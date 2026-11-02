import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const chromePath = process.env.CHROME_BINARY ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromeAvailable = await fs.access(chromePath).then(() => true, () => false);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("DocStudio resizes across an Office iframe, releases the drag and retains the width", {
  skip: chromeAvailable ? false : "Chrome unavailable; set CHROME_BINARY to run this browser regression",
  timeout: 120000
}, async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "freebuddy-doc-resize-"));
  const server = await createServer({
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  let chrome;
  let ws;
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    chrome = spawn(chromePath, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"
    ], { stdio: "ignore" });
    let launchError;
    chrome.once("error", (error) => { launchError = error; });
    let debugPort;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw launchError;
      if (chrome.exitCode !== null) throw new Error("Chrome exited before its debugging endpoint was ready");
      const activePort = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => null);
      if (activePort) {
        debugPort = Number(activePort.split("\n")[0]);
        break;
      }
      await sleep(100);
    }
    assert.ok(debugPort, "Chrome debugging endpoint is ready");
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}`));
      }, 10000);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, `Browser evaluation failed: ${expression}`);
      return result.result.value;
    };
    const waitFor = async (expression) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await evaluate(expression)) return;
        await sleep(100);
      }
      assert.fail(`Browser condition not reached: ${expression}`);
    };
    const panelWidth = () => evaluate("document.querySelector('.ds-copilot-panel').getBoundingClientRect().width");
    const move = async (x, y) => {
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      await sleep(50);
    };
    await cdp("Page.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/tests/fixtures/doc-studio-preview.html?view=empty` });
    await waitFor("!!document.querySelector('.ds-resize-handle') && typeof window.onOpenDocStudioFile === 'function'");

    // An opaque-origin iframe reproduces the engine's event boundary without
    // needing an installed engine or touching any real document.
    const preview = "data:text/html," + encodeURIComponent("<!doctype html><html><body style='margin:0;height:100vh;background:#eee'>Office preview<button>Editor control</button></body></html>");
    await evaluate(`window.freebuddy.docStudio.getEnginePreview = async () => ({ success: true, url: ${JSON.stringify(preview)} }); window.onOpenDocStudioFile('/fixture/report.docx');`);
    await waitFor("!!document.querySelector('.ds-office-frame[data-active=\"true\"]')");
    await sleep(250);
    assert.equal(await panelWidth(), 400);
    const handle = await evaluate("(() => { const r = document.querySelector('.ds-resize-handle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; })()");
    assert.equal(await evaluate(`document.elementFromPoint(${handle.x}, ${handle.y}).classList.contains('ds-resize-handle')`), true);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x, y: handle.y, buttons: 0 });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", buttons: 1, clickCount: 1 });
    await move(handle.x - 150, handle.y);
    assert.equal(await panelWidth(), 550, "dragging left over the iframe expands the message panel");
    await move(handle.x - 500, handle.y);
    assert.equal(await panelWidth(), 640, "the message panel respects its maximum width");
    await move(handle.x + 150, handle.y);
    assert.equal(await panelWidth(), 320, "dragging right respects the minimum width");
    await move(handle.x - 150, handle.y);
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x - 150, y: handle.y, button: "left", buttons: 0, clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x - 300, y: handle.y, buttons: 0 });
    await sleep(50);
    assert.equal(await panelWidth(), 550, "releasing over the iframe ends the drag");
    assert.equal(await evaluate("document.body.classList.contains('ds-resizing')"), false);
    assert.equal(await evaluate(`document.elementFromPoint(${handle.x - 300}, ${handle.y}).tagName`), "IFRAME", "the Office preview receives input again after dragging");
    assert.equal(await evaluate("localStorage.getItem('docStudio.copilotWidth')"), "550");
    await evaluate("window.__beforeResizeReload = true");
    await cdp("Page.reload");
    await waitFor("!window.__beforeResizeReload && !!document.querySelector('.ds-copilot-panel')");
    assert.equal(await panelWidth(), 550, "reopening retains the chosen width");
    const reopenedHandle = await evaluate("(() => { const r = document.querySelector('.ds-resize-handle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; })()");
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: reopenedHandle.x, y: reopenedHandle.y, buttons: 0 });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: reopenedHandle.x, y: reopenedHandle.y, button: "left", buttons: 1, clickCount: 1 });
    await move(reopenedHandle.x - 80, reopenedHandle.y);
    assert.equal(await panelWidth(), 630);
    await evaluate("window.dispatchEvent(new Event('blur'))");
    await move(reopenedHandle.x - 120, reopenedHandle.y);
    assert.equal(await panelWidth(), 630, "losing window focus ends the drag");
    assert.equal(await evaluate("document.body.classList.contains('ds-resizing')"), false);
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: reopenedHandle.x - 120, y: reopenedHandle.y, button: "left", buttons: 0, clickCount: 1 });
  } finally {
    ws?.close();
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill("SIGKILL");
      await exited;
    }
    await server.close();
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
