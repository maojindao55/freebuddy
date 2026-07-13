import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { ensureAgentGuides } from "../dist-electron/agentGuides.js";
import { setActiveBridgePort } from "../dist-electron/agentBridge.js";
import {
  handleDraftToolHttpRequest,
  registerDraftToolSession,
  resolveDraftToolRequest,
  unregisterDraftToolSession
} from "../dist-electron/draftToolService.js";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("native Draft tools do not write agent guide files into the workspace", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-draft-native-"));
  try {
    assert.deepEqual(
      await ensureAgentGuides(cwd, { nativeDraftTools: true }),
      []
    );
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Draft tool contract stays bound across ACP, preload, and renderer", () => {
  const runtime = read("../electron/cli/acpRuntime.ts");
  const preload = read("../electron/preload.ts");
  const listener = read(
    "../src/components/AgentBridge/AgentBridgeListener.tsx"
  );
  const store = read("../src/store/draftPreviewStore.ts");

  assert.match(runtime, /registerDraftToolSession/);
  assert.match(runtime, /conversationId: args\.conversationId/);
  assert.match(runtime, /if \(args\.conversationId\) \{/);
  assert.doesNotMatch(runtime, /args\.conversationId && args\.cwd/);
  assert.match(runtime, /cwd: args\.cwd \?\? ""/);
  assert.match(runtime, /mcp servers=/);
  assert.match(preload, /freebuddy:\/\/draft-tool/);
  assert.match(preload, /draft-tool:resolve/);
  assert.match(listener, /event\.conversationId|conversationId/);
  assert.match(listener, /waitForDraft/);
  assert.match(store, /loadState: DraftLoadState/);
  assert.match(store, /setLoadState/);
});

test("Draft MCP remains available without a selected workspace", async () => {
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
          resolveDraftToolRequest(webContents, {
            requestId: payload.requestId,
            result: {
              ok: true,
              conversationId: payload.conversationId,
              cwd: payload.cwd,
              target: payload.params.target,
              resolvedUrl: payload.params.target,
              loadState: "ready",
              visible: true
            }
          });
        });
      }
    }
  };

  const config = await registerDraftToolSession({
    taskSessionId: "task-no-workspace",
    conversationId: "conv-no-workspace",
    cwd: "",
    webContents
  });
  const token = config.env.find(
    (entry) => entry.name === "FREEBUDDY_DRAFT_TOKEN"
  )?.value;
  assert.ok(token);

  let statusCode = 0;
  let responseBody = "";
  const request = Readable.from([
    JSON.stringify({
      action: "show",
      params: { target: "https://example.com/preview" }
    })
  ]);
  Object.assign(request, {
    url: "/freebuddy/draft-tool",
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
    assert.equal(await handleDraftToolHttpRequest(request, response), true);
    assert.equal(statusCode, 200);
    assert.equal(
      JSON.parse(responseBody).resolvedUrl,
      "https://example.com/preview"
    );
    assert.equal(sent[0].payload.cwd, "");
    assert.equal(sent[0].payload.action, "show");
  } finally {
    unregisterDraftToolSession("task-no-workspace");
  }
});

test("Draft tool capability token routes a request to its bound conversation", async () => {
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
      toPNG: () => Buffer.from("draft-png")
    }),
    mainFrame: {
      isDestroyed: () => false,
      send(channel, payload) {
        sent.push({ channel, payload });
        setImmediate(() => {
          resolveDraftToolRequest(webContents, {
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

  const config = await registerDraftToolSession({
    taskSessionId: "task-1",
    conversationId: "conv-1",
    cwd: "/tmp/project",
    webContents
  });
  const token = config.env.find(
    (entry) => entry.name === "FREEBUDDY_DRAFT_TOKEN"
  )?.value;
  assert.ok(token);
  assert.equal(config.name, "freebuddy-draft");
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
    url: "/freebuddy/draft-tool",
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
      await handleDraftToolHttpRequest(request, response),
      true
    );
    assert.equal(statusCode, 200);
    const parsedResponse = JSON.parse(responseBody);
    assert.equal(parsedResponse.conversationId, "conv-1");
    assert.equal(parsedResponse.screenshot.mimeType, "image/png");
    assert.equal(parsedResponse.screenshot.data, Buffer.from("draft-png").toString("base64"));
    assert.equal(parsedResponse.diagnostics.console.length, 1);
    assert.equal(parsedResponse.diagnostics.console[0].level, "error");
    assert.match(parsedResponse.diagnostics.console[0].message, /demo is not defined/);
    assert.equal(parsedResponse.captureRect, undefined);
    assert.equal(sent[0].channel, "freebuddy://draft-tool");
    assert.equal(sent[0].payload.conversationId, "conv-1");
  } finally {
    unregisterDraftToolSession("task-1");
  }
});
