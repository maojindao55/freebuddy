import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
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

test("DocStudio synchronizes Office themes across system changes and loading tabs without reloading edits", {
  skip: chromeAvailable ? false : "Chrome unavailable; set CHROME_BINARY to run this browser regression",
  timeout: 120000
}, async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "freebuddy-doc-theme-"));
  const server = await createServer({
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false }
  });
  const themeLibrary = process.env.OFFICE_THEME_LIBRARY
    ? await fs.readFile(process.env.OFFICE_THEME_LIBRARY, "utf8")
    : `let mode = new URL(location.href).searchParams.get("dark_mode") || "system";
       const media = matchMedia("(prefers-color-scheme: dark)");
       const update = () => document.documentElement.classList.toggle("__DARK__", mode === "dark" || (mode === "system" && media.matches));
       media.addEventListener("change", update);
       addEventListener("message", ({data}) => {
         if (data?.name === "dark_mode_setting") { mode = data.content; update(); }
       });
       update();`;
  // Hold the third navigation until the test changes theme, independent of
  // machine speed, to exercise messages sent before the engine is ready.
  let releaseLoadingEditor;
  const loadingEditorReady = new Promise((resolve) => { releaseLoadingEditor = resolve; });
  let parentOrigin;
  const engine = createHttpServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/theme.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(themeLibrary);
      return;
    }
    if (url.searchParams.get("file")?.endsWith(".pptx")) await loadingEditorReady;
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><head><script src="/theme.js"></script></head>
      <body><textarea>Saved document</textarea><script>
        const params = new URL(location.href).searchParams;
        const instance = Math.random().toString(36);
        const report = () => parent.postMessage({
          type: "office-theme-fixture", file: params.get("file"), instance,
          initialTheme: params.get("dark_mode"),
          theme: document.documentElement.classList.contains("__DARK__") ? "dark" : "light",
          text: document.querySelector("textarea").value
        }, ${JSON.stringify(parentOrigin)});
        new MutationObserver(report).observe(document.documentElement, {attributes:true, attributeFilter:["class"]});
        addEventListener("message", ({data}) => {
          if (data?.name === "edit-fixture") { document.querySelector("textarea").value = data.content; report(); }
        });
        report();
      </script></body></html>`);
  });
  let chrome;
  let ws;
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    parentOrigin = `http://127.0.0.1:${port}`;
    await new Promise((resolve) => engine.listen(0, "127.0.0.1", resolve));
    const engineOrigin = `http://127.0.0.1:${engine.address().port}`;
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
    await cdp("Page.enable");
    await cdp("Emulation.setEmulatedMedia", {features:[{name:"prefers-color-scheme", value:"dark"}]});
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/tests/fixtures/doc-studio-preview.html?view=empty` });
    await waitFor("!!document.querySelector('.ds-resize-handle') && typeof window.onOpenDocStudioFile === 'function'");

    await waitFor("document.documentElement.dataset.theme === 'light'");
    await evaluate(`window.__officeReports = {}; window.addEventListener('message', (event) => {
      if (event.origin === ${JSON.stringify(engineOrigin)} && event.data?.type === 'office-theme-fixture') {
        window.__officeReports[event.data.file] = event.data;
      }
    }); window.freebuddy.docStudio.getEnginePreview = async (file) => ({success:true,
      url: ${JSON.stringify(engineOrigin)} + '/editor?title=fixture&file=' + encodeURIComponent(file)
    }); window.onOpenDocStudioFile('/fixture/report.docx');`);
    const report = (file) => evaluate(`window.__officeReports[${JSON.stringify(file)}]`);
    const setTheme = (theme) => evaluate(`import('/src/store/settingsStore.ts').then(({useSettingsStore}) => useSettingsStore.getState().setTheme(${JSON.stringify(theme)}))`);
    const allThemes = (theme) => `document.documentElement.dataset.theme === '${theme}' && Object.values(window.__officeReports).every(r => r.theme === '${theme}')`;
    const emulateSystem = (value) => cdp("Emulation.setEmulatedMedia", {features:[{name:"prefers-color-scheme", value}]});
    await waitFor("window.__officeReports['/fixture/report.docx']?.theme === 'light'");
    assert.equal((await report('/fixture/report.docx')).initialTheme, 'light', "explicit light overrides a dark operating system on first load");
    assert.equal(await evaluate("document.querySelector('.ds-office-frame').contentDocument === null"), true, "the engine is cross-origin");
    await evaluate(`document.querySelector('.ds-office-frame').contentWindow.postMessage({name:'edit-fixture',content:'Unsaved changes'}, ${JSON.stringify(engineOrigin)})`);
    await waitFor("window.__officeReports['/fixture/report.docx'].text === 'Unsaved changes'");

    await setTheme('dark');
    await waitFor(allThemes('dark'));
    await evaluate("window.onOpenDocStudioFile('/fixture/table.xlsx')");
    await waitFor("window.__officeReports['/fixture/table.xlsx']?.theme === 'dark'");
    assert.equal((await report('/fixture/table.xlsx')).initialTheme, 'dark', "new tabs open in the current theme");

    await evaluate("window.onOpenDocStudioFile('/fixture/loading.pptx')");
    await waitFor("document.querySelectorAll('.ds-office-frame').length === 3");
    assert.equal(await report('/fixture/loading.pptx'), undefined, "the third editor is still loading");
    await setTheme('light');
    releaseLoadingEditor();
    await waitFor("Object.keys(window.__officeReports).length === 3 && " + allThemes('light'));
    assert.equal((await report('/fixture/loading.pptx')).initialTheme, 'dark');
    assert.equal((await report('/fixture/loading.pptx')).theme, 'light', "onLoad reapplies a theme changed while the editor was loading");
    await evaluate("window.__originalFrames = [...document.querySelectorAll('.ds-office-frame')]; window.__originalSources = window.__originalFrames.map(f => f.src)");
    const instances = await evaluate("Object.fromEntries(Object.entries(window.__officeReports).map(([file, r]) => [file, r.instance]))");

    await setTheme('dark');
    await waitFor(allThemes('dark'));
    await setTheme('light');
    await waitFor(allThemes('light'));
    await emulateSystem('light');
    await emulateSystem('dark');
    await sleep(100);
    assert.equal(await evaluate(allThemes('light')), true, "fixed light mode ignores system changes");

    await setTheme('system');
    await waitFor(allThemes('dark'));
    await emulateSystem('light');
    await waitFor(allThemes('light'));
    await emulateSystem('dark');
    await waitFor(allThemes('dark'));
    assert.equal(await evaluate("[...document.querySelectorAll('.ds-office-frame')].every((f, i) => f === window.__originalFrames[i] && f.src === window.__originalSources[i])"), true, "theme changes retain every iframe and URL");
    assert.deepEqual(await evaluate("Object.fromEntries(Object.entries(window.__officeReports).map(([file, r]) => [file, r.instance]))"), instances, "active and hidden engine documents never reload");
    assert.equal((await report('/fixture/report.docx')).text, 'Unsaved changes');
  } finally {
    releaseLoadingEditor();
    ws?.close();
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill("SIGKILL");
      await exited;
    }
    await server.close();
    engine.closeAllConnections();
    if (engine.listening) await new Promise((resolve) => engine.close(resolve));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
