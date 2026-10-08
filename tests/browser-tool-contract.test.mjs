import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { ensureAgentGuides } from "../dist-electron/agentGuides.js";
import { setActiveBridgePort } from "../dist-electron/agentBridge.js";
import {
  handleBrowserToolHttpRequest,
  registerBrowserToolSession,
  resolveBrowserToolRequest,
  unregisterBrowserToolSession,
  rebindBrowserToolSession,
  suspendBrowserToolSession
} from "../dist-electron/browserToolService.js";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("native Browser tools do not write agent guide files into the workspace", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-browser-native-"));
  try {
    assert.deepEqual(
      await ensureAgentGuides(cwd, { nativeBrowserTools: true }),
      []
    );
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Browser tool contract stays bound across ACP, preload, and renderer", () => {
  const runtime = read("../electron/cli/acpRuntime.ts");
  const preload = read("../electron/preload.ts");
  const listener = read(
    "../src/components/AgentBridge/AgentBridgeListener.tsx"
  );
  const store = read("../src/store/browserStore.ts");

  assert.match(runtime, /registerBrowserToolSession/);
  assert.match(runtime, /conversationId: args\.conversationId/);
  assert.match(runtime, /if \(args\.conversationId && !remoteIsolated\) \{/);
  assert.doesNotMatch(runtime, /args\.conversationId && args\.cwd/);
  assert.match(runtime, /cwd: args\.cwd \?\? ""/);
  assert.match(runtime, /mcp servers=/);
  assert.match(preload, /freebuddy:\/\/browser-tool/);
  assert.match(preload, /browser-tool:resolve/);
  assert.match(listener, /event\.conversationId|conversationId/);
  assert.match(store, /loadState: BrowserLoadState/);
  assert.match(store, /setLoadState/);
});

test("Browser MCP remains available without a selected workspace", async () => {
  setActiveBridgePort(17880);
  const sent = [];
  let webContents;
  webContents = {
    id: 43,
    isDestroyed: () => false,
    on: () => webContents,
    once: () => webContents,
    mainFrame: {
      isDestroyed: () => false,
      send(channel, payload) {
        sent.push({ channel, payload });
        setImmediate(() => {
          resolveBrowserToolRequest(webContents, {
            requestId: payload.requestId,
            result: {
              ok: true,
              conversationId: payload.conversationId,
              cwd: payload.cwd,
              target: payload.params.target || payload.params.url,
              resolvedUrl: payload.params.target || payload.params.url,
              loadState: "ready",
              visible: true
            }
          });
        });
      }
    }
  };

  const config = await registerBrowserToolSession({
    taskSessionId: "task-no-workspace",
    conversationId: "conv-no-workspace",
    cwd: "",
    webContents
  });
  const token = config.env.find(
    (entry) => entry.name === "FREEBUDDY_BROWSER_TOKEN"
  )?.value;
  assert.ok(token);

  let statusCode = 0;
  let responseBody = "";
  const request = Readable.from([
    JSON.stringify({
      action: "navigate",
      params: { url: "https://example.com/preview" }
    })
  ]);
  Object.assign(request, {
    url: "/freebuddy/browser-tool",
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  const response = {
    writeHead(code) {
      statusCode = code;
    },
    end(body = "") {
      responseBody = String(body);
    }
  };

  try {
    assert.equal(await handleBrowserToolHttpRequest(request, response), true);
    assert.equal(statusCode, 200);
    assert.equal(
      JSON.parse(responseBody).resolvedUrl,
      "https://example.com/preview"
    );
    assert.equal(sent[0].payload.cwd, "");
    assert.equal(sent[0].payload.action, "navigate");
  } finally {
    unregisterBrowserToolSession("task-no-workspace");
  }
});

test("Browser tool resolve accepts remote callers without a matching WebContents sender", async () => {
  setActiveBridgePort(17878);
  let webContents;
  webContents = {
    id: 99,
    isDestroyed: () => false,
    on: () => webContents,
    once: () => webContents,
    mainFrame: {
      isDestroyed: () => false,
      send(channel, payload) {
        setImmediate(() => {
          assert.equal(
            resolveBrowserToolRequest(undefined, {
              requestId: payload.requestId,
              result: {
                ok: true,
                conversationId: payload.conversationId,
                cwd: payload.cwd,
                loadState: "ready",
                visible: true
              }
            }),
            true
          );
        });
      }
    }
  };

  const config = await registerBrowserToolSession({
    taskSessionId: "task-remote-resolve",
    conversationId: "conv-remote-resolve",
    cwd: "/tmp/project",
    webContents
  });
  const token = config.env.find(
    (entry) => entry.name === "FREEBUDDY_BROWSER_TOKEN"
  )?.value;

  let statusCode = 0;
  const request = Readable.from([
    JSON.stringify({ action: "navigate", params: { url: "/tmp/photo.png" } })
  ]);
  Object.assign(request, {
    url: "/freebuddy/browser-tool",
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  const response = {
    writeHead(code) {
      statusCode = code;
    },
    end() {}
  };

  try {
    assert.equal(await handleBrowserToolHttpRequest(request, response), true);
    assert.equal(statusCode, 200);
  } finally {
    unregisterBrowserToolSession("task-remote-resolve");
  }
});

test("Browser tool capability token routes a request to its bound conversation", async () => {
  setActiveBridgePort(17879);
  const sent = [];
  let consoleListener;
  let webContents;
  webContents = {
    id: 42,
    isDestroyed: () => false,
    on(event, listener) {
      if (event === "console-message") consoleListener = listener;
      return webContents;
    },
    once: () => webContents,
    capturePage: async () => ({
      getSize: () => ({ width: 120, height: 90 }),
      toPNG: () => Buffer.from("browser-png")
    }),
    mainFrame: {
      isDestroyed: () => false,
      send(channel, payload) {
        sent.push({ channel, payload });
        setImmediate(() => {
          resolveBrowserToolRequest(webContents, {
            requestId: payload.requestId,
            result: {
              ok: true,
              conversationId: payload.conversationId,
              cwd: payload.cwd,
              loadState: "ready",
              visible: true,
              captureRect: { x: 10, y: 20, width: 120, height: 90 }
            }
          });
        });
      }
    }
  };

  const config = await registerBrowserToolSession({
    taskSessionId: "task-1",
    conversationId: "conv-1",
    cwd: "/tmp/project",
    webContents
  });
  const token = config.env.find(
    (entry) => entry.name === "FREEBUDDY_BROWSER_TOKEN"
  )?.value;
  assert.ok(token);
  assert.equal(config.name, "freebuddy-browser");
  assert.equal(path.isAbsolute(config.command), true);
  assert.equal(path.isAbsolute(config.args[0]), true);
  consoleListener?.({
    frame: { url: "http://127.0.0.1:5173/" },
    level: "error",
    message: "ReferenceError: demo is not defined",
    sourceId: "http://127.0.0.1:5173/src/main.ts",
    lineNumber: 12
  });

  let statusCode = 0;
  let responseBody = "";
  const request = Readable.from([
    JSON.stringify({
      action: "inspect",
      params: { screenshot: true, console: true }
    })
  ]);
  Object.assign(request, {
    url: "/freebuddy/browser-tool",
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  const response = {
    writeHead(code) {
      statusCode = code;
    },
    end(body = "") {
      responseBody = String(body);
    }
  };

  try {
    assert.equal(
      await handleBrowserToolHttpRequest(request, response),
      true
    );
    assert.equal(statusCode, 200);
    const parsedResponse = JSON.parse(responseBody);
    assert.equal(parsedResponse.conversationId, "conv-1");
    assert.equal(parsedResponse.screenshot.mimeType, "image/png");
    assert.equal(parsedResponse.screenshot.data, Buffer.from("browser-png").toString("base64"));
    assert.equal(parsedResponse.diagnostics.console.length, 1);
    assert.equal(parsedResponse.diagnostics.console[0].level, "error");
    assert.match(parsedResponse.diagnostics.console[0].message, /demo is not defined/);
    assert.equal(parsedResponse.captureRect, undefined);
    assert.equal(sent[0].channel, "freebuddy://browser-tool");
    assert.equal(sent[0].payload.conversationId, "conv-1");
  } finally {
    unregisterBrowserToolSession("task-1");
  }
});


test("warm Browser credentials suspend between runs and rebind only within the same conversation", async () => {
  setActiveBridgePort(17880);
  const sent = [];
  const webContents = { id: 99, isDestroyed: () => false, on: () => {}, once: () => {},
    mainFrame: { isDestroyed: () => false, send: (_channel, event) => {
      sent.push(event);
      setImmediate(() => resolveBrowserToolRequest(webContents, { requestId: event.requestId, result: { ok: true, conversationId: event.conversationId } }));
    } } };
  const input = { taskSessionId: "warm-old", conversationId: "warm-chat", cwd: "", webContents };
  const config = await registerBrowserToolSession(input);
  const token = config.env.find(e => e.name === "FREEBUDDY_BROWSER_TOKEN").value;
  const call = async () => {
    const req = Readable.from([JSON.stringify({ action: "navigate", params: { url: "https://example.com" } })]);
    Object.assign(req, { url: "/freebuddy/browser-tool", method: "POST", headers: { authorization: `Bearer ${token}` } });
    let status;
    await handleBrowserToolHttpRequest(req, { writeHead: code => { status = code; }, end: () => {} });
    return status;
  };
  try {
    const slowRequest = new Readable({ read() {} });
    Object.assign(slowRequest, { url: "/freebuddy/browser-tool", method: "POST", headers: { authorization: `Bearer ${token}` } });
    let slowStatus;
    const slowResponse = handleBrowserToolHttpRequest(slowRequest, { writeHead: code => { slowStatus = code; }, end: () => {} });
    suspendBrowserToolSession("warm-old");
    assert.equal(await call(), 401);
    assert.equal(rebindBrowserToolSession("warm-old", { ...input, taskSessionId: "warm-new", conversationId: "another-chat" }), false);
    assert.equal(rebindBrowserToolSession("warm-old", { ...input, taskSessionId: "warm-new", cwd: "/another" }), false);
    assert.equal(rebindBrowserToolSession("warm-old", { ...input, taskSessionId: "warm-new" }), true);
    slowRequest.push(JSON.stringify({ action: "navigate", params: { url: "https://example.com" } }));
    slowRequest.push(null);
    await slowResponse;
    assert.equal(slowStatus, 410);
    unregisterBrowserToolSession("warm-old");
    assert.equal(await call(), 200);
    assert.equal(sent.at(-1).conversationId, "warm-chat");
    unregisterBrowserToolSession("warm-new");
    assert.equal(await call(), 401);
  } finally { unregisterBrowserToolSession("warm-old"); unregisterBrowserToolSession("warm-new"); }
});
