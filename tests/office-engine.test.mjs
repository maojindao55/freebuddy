import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Personal-learning integration: reuses the locally installed WorkBuddy
// Tencent Docs engine. See electron/officeEngineCore.ts for the design notes.
const {
  OFFICE_ENGINE_FILE_TYPES,
  fileExtensionOf,
  getOfficeEngineDocType,
  isOfficeEngineFile,
  buildOfficeEnginePreviewUrl,
  buildOfficeEngineEditorStatusUrl,
  buildOfficeEngineCandidatePaths,
  findOfficeEngineBinary
} = await import("../dist-electron/officeEngineCore.js");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), "utf8");

test("office engine file types map doc/sheet/slide/pdf families", () => {
  assert.equal(getOfficeEngineDocType("C:\\work\\报告.docx"), "doc");
  assert.equal(getOfficeEngineDocType("C:\\work\\slides.PPTX"), "slide");
  assert.equal(getOfficeEngineDocType("/tmp/manual.pdf"), "pdf");
  assert.equal(getOfficeEngineDocType("C:\\work\\data.xlsx"), "sheet");
  assert.equal(getOfficeEngineDocType("C:\\work\\预算.xlsm"), "sheet");
  // .csv/.tsv keep the built-in lightweight editor.
  assert.equal(getOfficeEngineDocType("C:\\work\\data.csv"), null);
  assert.equal(getOfficeEngineDocType("C:\\work\\data.tsv"), null);
  assert.equal(isOfficeEngineFile("C:\\work\\a.wps"), true);
  assert.equal(isOfficeEngineFile("C:\\work\\a.png"), false);
  assert.equal(fileExtensionOf("C:\\a.b\\合同_#7#8.docx"), ".docx");
  // Every engine extension round-trips through the type table.
  for (const fileType of OFFICE_ENGINE_FILE_TYPES) {
    for (const ext of fileType.extensions) {
      assert.equal(getOfficeEngineDocType(`x${ext}`), fileType.engineType);
    }
  }
});

test("office engine preview URL mirrors the WorkBuddy recipe", () => {
  const port = 39100;
  const docPath = "C:\\Users\\demo\\Documents\\发布说明.docx";
  const url = buildOfficeEnginePreviewUrl(port, docPath);
  assert.ok(url.startsWith(`http://127.0.0.1:${port}/static/doc/pc.html?`));
  const params = new URL(url).searchParams;
  assert.equal(params.get("localFilePath"), docPath);
  assert.equal(params.get("title"), "发布说明.docx");
  assert.equal(
    params.get("globalPadId"),
    crypto.createHash("md5").update(docPath).digest("hex")
  );
  assert.equal(params.get("local_edit"), "1");
  assert.equal(params.get("editorSdkUrl"), `http://127.0.0.1:${port}`);

  const slideUrl = buildOfficeEnginePreviewUrl(port, "D:\\deck.pptx");
  assert.ok(slideUrl.startsWith(`http://127.0.0.1:${port}/static/slide/pc.html?`));
  assert.ok(slideUrl.includes("client=sdk_local_wb"));
  assert.ok(!slideUrl.includes("editorSdkUrl"));

  const sheetUrl = buildOfficeEnginePreviewUrl(port, "D:\\预算表.xlsx");
  assert.ok(sheetUrl.startsWith(`http://127.0.0.1:${port}/static/sheet/pc.html?`));
  assert.ok(sheetUrl.includes("client=sdk_local_pure"));
  assert.ok(sheetUrl.includes("local_edit=1"));
  assert.ok(!sheetUrl.includes("editorSdkUrl"));

  assert.throws(() => buildOfficeEnginePreviewUrl(port, "C:\\a.png"), /Unsupported office engine file/);
});

test("office engine binary candidates prefer override, then userData, then WorkBuddy", () => {
  const candidates = buildOfficeEngineCandidatePaths({
    envOverride: "D:\\custom\\editor_sdk.exe",
    userDataDir: "C:\\Users\\demo\\AppData\\Roaming\\freebuddy-dev",
    localProgramsDir: "C:\\Users\\demo\\AppData\\Local\\Programs"
  });
  assert.equal(candidates[0], "D:\\custom\\editor_sdk.exe");
  assert.ok(
    candidates[1].includes(path.join("office-engine", "editor_sdk.exe")),
    "userData candidate missing"
  );
  assert.ok(
    candidates.some((c) => c.includes("WorkBuddy") && c.includes(path.join("@tencent", "tencent-docs-ai-engine"))),
    "WorkBuddy unpacked candidate missing"
  );
  assert.ok(candidates.some((c) => c.includes("WorkBuddyAI")));

  assert.equal(findOfficeEngineBinary(["a", "b", "c"], (c) => c === "b"), "b");
  assert.equal(findOfficeEngineBinary(["a"], () => false), null);
});

test("office engine preview IPC is sender- and path-guarded", () => {
  const bridge = read("electron/docStudioBridge.ts");
  const idx = bridge.indexOf('"docStudio:officePreview"');
  assert.ok(idx >= 0, "docStudio:officePreview handler missing");
  const body = bridge.slice(idx, idx + 600);
  assert.match(body, /isDocStudioWindowSender\(event\.sender\)/, "officePreview lacks sender check");
  assert.match(body, /isAllowedOfficeEnginePath/, "officePreview lacks path check");
  // openWindow must accept engine files too.
  const openIdx = bridge.indexOf('"docStudio:openWindow"');
  const openBody = bridge.slice(openIdx, openIdx + 400);
  assert.match(openBody, /isAllowedOfficeEnginePath/);

  // Routing uses the combined openable check.
  const mainTs = read("electron/main.ts");
  assert.ok(mainTs.includes("isDocStudioOpenableFile"));
  const menuTs = read("electron/menu.ts");
  assert.ok(menuTs.includes("isDocStudioOpenableFile"));

  // Renderer hosts engine tabs in an iframe and skips its own save flow.
  const app = read("src/components/DocStudio/DocStudioApp.tsx");
  assert.match(app, /getEnginePreview/);
  assert.match(app, /kind: "office"/);
  assert.match(app, /ds-office-frame/);
  assert.match(app, /activeTab\.kind === "office"/);

  const preload = read("electron/preload.ts");
  assert.match(preload, /getEnginePreview/);
  const types = read("src/types/freebuddy.d.ts");
  assert.match(types, /getEnginePreview/);
  const fixture = read("tests/fixtures/doc-studio-preview.tsx");
  assert.match(fixture, /getEnginePreview/);
});

test("chat-side doc clickability includes engine extensions", () => {
  const kinds = read("src/components/DocStudio/utils/docFileKinds.ts");
  assert.match(kinds, /\.docx/);
  assert.match(kinds, /\.pptx/);
  assert.match(kinds, /\.pdf/);
});

test("office engine MCP bridge relays stdio JSON-RPC to a streamable HTTP endpoint", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({
        url: req.url,
        session: req.headers["mcp-session-id"] || null,
        body: body.slice(0, 400)
      });
      let message = null;
      try {
        message = JSON.parse(body);
      } catch {
        /* ignore */
      }
      const isInitialize = message && message.method === "initialize";
      if (isInitialize) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "mcp-session-id": "sess-1"
        });
        res.end(
          `event: message\n` +
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0" } }
            })}\n\n`
        );
        return;
      }
      if (message && message.method === "tools/list") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `event: message\n` +
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { tools: [{ name: "open_file" }, { name: "doc_get_outline" }] }
            })}\n\n`
        );
        return;
      }
      res.writeHead(202, { "content-type": "text/plain" });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const child = spawn(process.execPath, ["dist-electron/mcp/officeEngineMcpServer.js"], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      FREEBUDDY_OFFICE_MCP_URL: `http://127.0.0.1:${port}/mcp`
    },
    stdio: ["pipe", "pipe", "ignore"]
  });

  const stdout = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) stdout.push(line.trim());
    }
  });

  const send = (payload) =>
    new Promise((resolve) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`, () => resolve());
    });

  await send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill();
  await new Promise((resolve) => server.close(() => resolve()));

  assert.ok(stdout.length >= 2, `expected >= 2 relayed responses, got: ${stdout.join(" | ")}`);
  const init = JSON.parse(stdout[0]);
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, "2024-11-05");
  const tools = JSON.parse(stdout[stdout.length - 1]);
  assert.equal(tools.id, 2);
  assert.deepEqual(
    tools.result.tools.map((t) => t.name),
    ["open_file", "doc_get_outline"]
  );
  // The session id from the initialize response must be sent on later requests.
  const initializeCall = seen.find((entry) => entry.body.includes("initialize"));
  const toolsCall = seen.find((entry) => entry.body.includes("tools/list"));
  assert.ok(initializeCall && toolsCall, "bridge did not forward both requests");
  assert.equal(initializeCall.session, null);
  assert.equal(toolsCall.session, "sess-1");
});

test("office engine preview reloads via the file watcher after agent saves", () => {
  assert.match(
    buildOfficeEngineEditorStatusUrl(39100, "C:\\Users\\demo\\a.docx"),
    /^http:\/\/127\.0\.0\.1:39100\/localapi\/editor\/status\?file_path=/
  );

  const bridge = read("electron/docStudioBridge.ts");
  assert.match(bridge, /docStudio:engineEditorStatus/);
  assert.match(bridge, /isAllowedOfficeEnginePath/);
  // The file watcher must cover office-engine files so agent saves reload the preview.
  const watchIdx = bridge.indexOf('"docStudio:watchFile"');
  const watchBody = bridge.slice(watchIdx, watchIdx + 500);
  assert.match(watchBody, /isDocStudioOpenableFile/);

  const app = read("src/components/DocStudio/DocStudioApp.tsx");
  assert.match(app, /officeReloads/);
  assert.match(app, /kind === "office"\) \{\s*setOfficeReloads/);
  // Every open file is watched, including office-engine tabs.
  assert.match(app, /const paths = new Set\(tabs\.map\(\(tb\) => tb\.filePath\)\)/);

  const preload = read("electron/preload.ts");
  assert.match(preload, /getEngineEditorStatus/);
  const fixture = read("tests/fixtures/doc-studio-preview.tsx");
  assert.match(fixture, /getEngineEditorStatus/);
});

test("office engine MCP wiring reaches agent runs and the copilot prompt", () => {
  const bridge = read("electron/mcp/officeEngineMcpServer.ts");
  assert.match(bridge, /FREEBUDDY_OFFICE_MCP_URL/);
  assert.match(bridge, /mcp-session-id/);
  assert.match(bridge, /text\/event-stream/);

  const service = read("electron/officeEngineToolService.ts");
  assert.match(service, /docStudio\.conversationByFile/);
  assert.match(service, /isOfficeEngineFile/);
  assert.match(service, /name: "office-engine"/);

  const runtime = read("electron/cli/acpRuntime.ts");
  assert.match(runtime, /resolveDocStudioOfficeFile/);
  assert.match(runtime, /registerOfficeEngineToolSession/);

  const copilot = read("src/components/DocStudio/DocStudioCopilot.tsx");
  assert.match(copilot, /office-engine MCP/);
  assert.match(copilot, /open_file/);
});

