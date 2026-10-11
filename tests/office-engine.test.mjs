import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Personal-learning integration with a separately downloaded Office engine.
const {
  OFFICE_ENGINE_FILE_TYPES,
  fileExtensionOf,
  getOfficeEngineDocType,
  isOfficeEngineFile,
  buildOfficeEnginePreviewUrl,
  buildOfficeEngineEditorStatusUrl,
  findOfficeEngineEditorStatus
} = await import("../dist-electron/officeEngineCore.js");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), "utf8");
const {
  getManagedOfficeEnginePath,
  validateOfficeEngineDownload,
  OFFICE_ENGINE_DOWNLOAD_URL,
  OFFICE_ENGINE_DOWNLOAD_SHA256,
  getOfficeEngineDownloadConfig,
  validateOfficeEngineExecutableHeader,
  downloadOfficeEngine,
  downloadConfiguredOfficeEngine
} = await import("../dist-electron/officeEngineAddon.js");
const { savedAsOfficeFilePath } = await import("../dist-electron/mcp/officeEngineSaveEvent.js");
const {
  registerDocStudioWindow,
  unregisterDocStudioWindow,
  isDocStudioWindowSender
} = await import("../dist-electron/docStudioWindowRegistry.js");

test("DocStudio window identity is registered and cleared without Electron runtime imports", () => {
  const sender = { id: 987654321 };
  assert.equal(isDocStudioWindowSender(sender), false);
  registerDocStudioWindow(sender.id);
  assert.equal(isDocStudioWindowSender(sender), true);
  unregisterDocStudioWindow(sender.id);
  assert.equal(isDocStudioWindowSender(sender), false);
});

test("only a successful save to a separate Office path can open a new tab", () => {
  const current = path.join(rootDir, "current.docx");
  const created = path.join(rootDir, "created.docx");
  const request = (filePath) => ({
    id: 7,
    method: "tools/call",
    params: { name: "save_file", arguments: { file_id: "new_doc", file_path: filePath } }
  });
  const success = [{ id: 7, result: { content: [{ type: "text", text: "saved" }] } }];
  assert.equal(savedAsOfficeFilePath(request(created), success, current), created);
  assert.equal(savedAsOfficeFilePath(request(current), success, current), null);
  assert.equal(savedAsOfficeFilePath(request(path.join(rootDir, "export.csv")), success, current), null);
  assert.equal(savedAsOfficeFilePath(request("relative.docx"), success, current), null);
  assert.equal(savedAsOfficeFilePath(request(created), [{ id: 7, error: { message: "failed" } }], current), null);
  assert.equal(savedAsOfficeFilePath(request(created), [{ id: 7, result: { isError: true } }], current), null);
  assert.equal(savedAsOfficeFilePath(request(created), [{ id: 8, result: {} }], current), null);
});

test("office engine addon requires HTTPS and a pinned SHA-256", () => {
  const validHash = "a".repeat(64);
  assert.equal(validateOfficeEngineDownload("https://example.com/editor_sdk.exe", validHash).sha256, validHash);
  assert.throws(() => validateOfficeEngineDownload("http://example.com/editor_sdk.exe", validHash), /HTTPS/);
  assert.throws(() => validateOfficeEngineDownload("https://example.com/editor_sdk.exe", "short"), /SHA-256/);
});

test("office engine downloads select pinned Windows, Apple Silicon and Intel resources", () => {
  const base = "https://pub-7b39e9aa06a94f8fa4d856f47eb7b9a4.r2.dev/";
  assert.deepEqual(getOfficeEngineDownloadConfig("win32", "x64"), {
    url: base + "editor_sdk.exe",
    sha256: "aed4b6845a835e1b54f4af9615958d478a9a6cfa689fca107627c3539f4e11f9"
  });
  assert.deepEqual(getOfficeEngineDownloadConfig("darwin", "arm64"), {
    url: base + "editor_sdk-darwin-arm64",
    sha256: "59014a38bb4463167f57a6ecd8cce40fc190bb128a7fd1dabec6933fe03ae83b"
  });
  assert.deepEqual(getOfficeEngineDownloadConfig("darwin", "x64"), {
    url: base + "editor_sdk-darwin-x64",
    sha256: "754a227af47a3bd278aa9efd9af5a38adcb667495c63ec9d76d32a68ad16f47b"
  });
  for (const [platform, arch] of [["linux", "x64"], ["win32", "arm64"], ["darwin", "ia32"]]) {
    assert.equal(getOfficeEngineDownloadConfig(platform, arch), null);
  }
});

test("Mac engine validation rejects non-executables, truncated headers and the wrong architecture", () => {
  const header = (cpuType) => {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(cpuType, 4);
    return bytes;
  };
  const arm64 = header(0x0100000c);
  const x64 = header(0x01000007);
  assert.doesNotThrow(() => validateOfficeEngineExecutableHeader(arm64, "darwin", "arm64"));
  assert.doesNotThrow(() => validateOfficeEngineExecutableHeader(x64, "darwin", "x64"));
  assert.throws(() => validateOfficeEngineExecutableHeader(x64, "darwin", "arm64"), /architecture/);
  assert.throws(() => validateOfficeEngineExecutableHeader(arm64, "darwin", "x64"), /architecture/);
  assert.throws(() => validateOfficeEngineExecutableHeader(arm64.subarray(0, 4), "darwin", "arm64"), /macOS executable/);
  assert.throws(() => validateOfficeEngineExecutableHeader(Buffer.from("MZfake binary"), "darwin", "arm64"), /macOS executable/);
  assert.doesNotThrow(() => validateOfficeEngineExecutableHeader(Buffer.from("MZ"), "win32", "x64"));
  assert.throws(() => validateOfficeEngineExecutableHeader(arm64, "win32", "x64"), /Windows executable/);
});

test("the configured download is pinned and cannot replace the managed engine with different bytes", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-office-addon-hash-"));
  try {
    assert.equal(OFFICE_ENGINE_DOWNLOAD_URL, "https://pub-7b39e9aa06a94f8fa4d856f47eb7b9a4.r2.dev/editor_sdk.exe");
    assert.equal(OFFICE_ENGINE_DOWNLOAD_SHA256, "aed4b6845a835e1b54f4af9615958d478a9a6cfa689fca107627c3539f4e11f9");
    const managedPath = getManagedOfficeEnginePath(userDataDir);
    fs.mkdirSync(path.dirname(managedPath), { recursive: true });
    fs.writeFileSync(managedPath, "previous engine");
    const response = new Response("different binary", { status: 200 });
    Object.defineProperty(response, "url", { value: OFFICE_ENGINE_DOWNLOAD_URL });
    let requestedUrl = null;
    const fetchSource = async (url) => {
      requestedUrl = String(url);
      return response;
    };
    const download = process.platform === "win32" && process.arch === "x64"
      ? downloadConfiguredOfficeEngine(userDataDir, () => {}, fetchSource)
      : downloadOfficeEngine(OFFICE_ENGINE_DOWNLOAD_URL, OFFICE_ENGINE_DOWNLOAD_SHA256, userDataDir, () => {}, fetchSource);
    await assert.rejects(
      download,
      /SHA-256 checksum does not match/
    );
    assert.equal(requestedUrl, OFFICE_ENGINE_DOWNLOAD_URL);
    assert.equal(fs.readFileSync(managedPath, "utf8"), "previous engine");
    assert.equal(fs.readdirSync(path.dirname(managedPath)).filter((name) => name.startsWith(".install-")).length, 0);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("office engine file types map doc/sheet/slide/pdf families", () => {
  assert.equal(getOfficeEngineDocType("C:\\work\\报告.docx"), "doc");
  assert.equal(getOfficeEngineDocType("C:\\work\\slides.PPTX"), "slide");
  assert.equal(getOfficeEngineDocType("/tmp/manual.pdf"), "pdf");
  assert.equal(getOfficeEngineDocType("C:\\work\\data.xlsx"), "sheet");
  assert.equal(getOfficeEngineDocType("C:\\work\\预算.xlsm"), "sheet");
  // These formats are outside DocStudio's engine integration.
  assert.equal(getOfficeEngineDocType("C:\\work\\data.csv"), null);
  assert.equal(getOfficeEngineDocType("C:\\work\\data.tsv"), null);
  assert.equal(getOfficeEngineDocType("C:\\work\\notes.md"), null);
  assert.equal(getOfficeEngineDocType("C:\\work\\notes.txt"), null);
  assert.equal(getOfficeEngineDocType("C:\\work\\config.json"), null);
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

  // Routing uses the engine-only openable check.
  const mainTs = read("electron/main.ts");
  assert.ok(mainTs.includes("isDocStudioOpenableFile"));
  const menuTs = read("electron/menu.ts");
  assert.ok(menuTs.includes("isDocStudioOpenableFile"));

  // Renderer hosts engine tabs in an iframe.
  const app = read("src/components/DocStudio/DocStudioApp.tsx");
  assert.match(app, /getEnginePreview/);
  assert.match(app, /kind: "office"/);
  assert.match(app, /ds-office-frame/);

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
  const officeFile = path.join(rootDir, "preview.xlsx");
  const newFile = path.join(rootDir, "created.xlsx");
  const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-office-relay-test-"));
  const eventFile = path.join(eventDir, "saved-files.jsonl");
  fs.writeFileSync(eventFile, "");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({
        url: req.url,
        session: req.headers["mcp-session-id"] || null,
        body
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
              result: { tools: [
                { name: "open_file" },
                { name: "doc_get_outline" },
                {
                  name: "doc_insert_footer",
                  inputSchema: {
                    type: "object",
                    required: ["text"],
                    properties: {
                      text: { type: "string" },
                      text_format: [
                        ["type", "object"],
                        ["description", "Footer text format"],
                        ["properties", { bold: { type: "boolean" } },
                          ["highlight", { type: "string" }],
                          ["vertical_align", { type: "string", enum: ["baseline", "superscript"] }]]
                      ],
                      parts: {
                        type: "array",
                        items: { type: "object", properties: { text_format: [
                          ["type", "object"], ["properties", { italic: { type: "boolean" } }]
                        ] } }
                      }
                    }
                  }
                }
              ] }
            })}\n\n`
        );
        return;
      }
      if (message?.method === "tools/call" && message.params?.name === "save_file") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message.id === 6
          ? { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "save failed" } }
          : { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "saved" }] } }));
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
      FREEBUDDY_OFFICE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      FREEBUDDY_OFFICE_FILE: officeFile,
      FREEBUDDY_OFFICE_SAVED_FILES_EVENT_PATH: eventFile
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
  await send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "open_file",
      arguments: { file_path: officeFile.replaceAll(path.sep, "/"), open_with_existing: false, wait: false }
    }
  });
  await send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "open_file",
      arguments: { file_path: path.join(rootDir, "other.xlsx"), open_with_existing: false, wait: false }
    }
  });
  await send({ jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "save_file", arguments: { file_id: "new_sheet", file_path: newFile } } });
  await send({ jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "save_file", arguments: { file_id: "new_sheet", file_path: path.join(rootDir, "failed.xlsx") } } });
  await send({ jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "save_file", arguments: { file_id: "current_sheet", file_path: officeFile } } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill();
  await new Promise((resolve) => server.close(() => resolve()));
  const savedEvents = fs.readFileSync(eventFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  fs.unlinkSync(eventFile);
  fs.rmdirSync(eventDir);
  assert.deepEqual(savedEvents, [{ filePath: newFile }]);

  assert.ok(stdout.length >= 2, `expected >= 2 relayed responses, got: ${stdout.join(" | ")}`);
  const init = JSON.parse(stdout[0]);
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, "2024-11-05");
  const tools = stdout.map((line) => JSON.parse(line)).find((message) => message.id === 2);
  assert.equal(tools.id, 2);
  assert.deepEqual(
    tools.result.tools.map((t) => t.name),
    ["open_file", "doc_get_outline", "doc_insert_footer"]
  );
  const footerSchema = tools.result.tools.find((tool) => tool.name === "doc_insert_footer").inputSchema;
  assert.deepEqual(footerSchema.required, ["text"]);
  assert.equal(footerSchema.properties.text_format.type, "object");
  assert.equal(footerSchema.properties.text_format.properties.bold.type, "boolean");
  assert.equal(footerSchema.properties.text_format.properties.highlight.type, "string");
  assert.deepEqual(footerSchema.properties.text_format.properties.vertical_align.enum, ["baseline", "superscript"]);
  assert.equal(footerSchema.properties.parts.items.properties.text_format.properties.italic.type, "boolean");
  // The session id from the initialize response must be sent on later requests.
  const initializeCall = seen.find((entry) => entry.body.includes("initialize"));
  const toolsCall = seen.find((entry) => entry.body.includes("tools/list"));
  assert.ok(initializeCall && toolsCall, "bridge did not forward both requests");
  assert.equal(initializeCall.session, null);
  assert.equal(toolsCall.session, "sess-1");
  const openCalls = seen
    .map((entry) => JSON.parse(entry.body))
    .filter((message) => message.method === "tools/call" && message.params?.name === "open_file");
  assert.equal(openCalls.length, 2);
  assert.deepEqual(openCalls.find((call) => call.id === 3)?.params.arguments, {
    file_path: officeFile,
    open_with_existing: true,
    wait: true
  });
  assert.equal(openCalls.find((call) => call.id === 4)?.params.arguments.open_with_existing, false);
  assert.equal(openCalls.find((call) => call.id === 4)?.params.arguments.wait, false);
});

test("office engine preview reloads via the file watcher after agent saves", () => {
  assert.equal(
    buildOfficeEngineEditorStatusUrl(39100),
    "http://127.0.0.1:39100/localapi/editor/status"
  );

  const bridge = read("electron/docStudioBridge.ts");
  assert.match(bridge, /docStudio:engineEditorStatus/);
  assert.match(bridge, /open_editors/);
  assert.match(bridge, /findOfficeEngineEditorStatus/);
  assert.match(bridge, /isAllowedOfficeEnginePath/);
  // The file watcher must cover office-engine files so agent saves reload the preview.
  const watchIdx = bridge.indexOf('"docStudio:watchFile"');
  const watchBody = bridge.slice(watchIdx, watchIdx + 500);
  assert.match(watchBody, /isAllowedOfficeEnginePath/);

  const app = read("src/components/DocStudio/DocStudioApp.tsx");
  assert.match(app, /officeReloads/);
  // Every open file is watched, including office-engine tabs.
  assert.match(app, /const paths = new Set\(tabs\.map\(\(tb\) => tb\.filePath\)\)/);

  const preload = read("electron/preload.ts");
  assert.match(preload, /getEngineEditorStatus/);
  const fixture = read("tests/fixtures/doc-studio-preview.tsx");
  assert.match(fixture, /getEngineEditorStatus/);
});

test("office engine status matches Unicode paths from the unfiltered editor pool", () => {
  const filePath = path.join(rootDir, "测试预览.docx");
  const editor = { file_path: filePath, is_dirty: true, last_saved_ms: 123 };
  const pool = [null, { file_path: path.join(rootDir, "other.docx") }, editor];
  assert.equal(findOfficeEngineEditorStatus(pool, filePath.replaceAll(path.sep, "/")), editor);
  assert.equal(findOfficeEngineEditorStatus(pool, path.join(rootDir, "missing.docx")), null);
  assert.equal(findOfficeEngineEditorStatus({ open_editors: pool }, filePath), null);
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
