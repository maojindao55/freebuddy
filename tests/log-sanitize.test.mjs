import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function load() {
  const source = fs.readFileSync(
    new URL("../electron/shared/logSanitize.ts", import.meta.url),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("redactsecrets masks sk- keys keeping a 6-char prefix", async () => {
  const { redactsecrets } = await load();
  assert.equal(
    redactsecrets("key is sk-ant-abc123def456ghi789"),
    "key is sk-ant…<redacted>"
  );
});

test("redactsecrets masks bearer tokens and key=value secrets", async () => {
  const { redactsecrets } = await load();
  assert.equal(redactsecrets("Bearer abcdef1234567890"), "Bearer <redacted>");
  assert.equal(redactsecrets('api_key="supersecretvalue123"'), 'api_key="<redacted>"');
  assert.equal(redactsecrets("short: abc"), "short: abc"); // < 8 chars untouched
});

test("buildPathMasks sorts longest-first so userData beats home", async () => {
  const { buildPathMasks, maskPaths } = await load();
  const masks = buildPathMasks({
    home: "/Users/alice",
    userData: "/Users/alice/Library/Application Support/freebuddy",
    workspaces: ["/Users/alice/code/proj"]
  });
  assert.equal(
    maskPaths("cwd=/Users/alice/code/proj db in /Users/alice/Library/Application Support/freebuddy/x", masks),
    "cwd=<workspace> db in <appdata>/x"
  );
  assert.equal(maskPaths("home is /Users/alice/other", masks), "home is <home>/other");
});

test("sanitizeLogData redacts content keys with length marker and masks paths", async () => {
  const { sanitizeLogData, buildPathMasks } = await load();
  const masks = buildPathMasks({ home: "/h", userData: "/h/app", workspaces: [] });
  const out = sanitizeLogData(
    { content: "hello world", prompt: 42, cwd: "/h/work", note: "ok" },
    masks
  );
  assert.equal(out.content, "<redacted: 11 chars>");
  assert.equal(out.prompt, 42); // non-string content values pass through
  assert.equal(out.cwd, "<home>/work");
  assert.equal(out.note, "ok");
});

test("filterSessionLogLine full mode only redacts secrets", async () => {
  const { filterSessionLogLine } = await load();
  const line = JSON.stringify({ ts: "t", type: "stdin", content: "sk-ant-abc123def456" });
  const out = JSON.parse(filterSessionLogLine(line, "full", []));
  assert.equal(out.content, "sk-ant…<redacted>");
  assert.equal(out.type, "stdin");
});

test("filterSessionLogLine standard keeps system/stderr with path masks", async () => {
  const { filterSessionLogLine, buildPathMasks } = await load();
  const masks = buildPathMasks({ home: "/h", userData: "/h/app", workspaces: ["/h/w"] });
  const sys = JSON.stringify({ ts: "t", type: "system", content: "start adapter=codex cwd=/h/w" });
  assert.equal(
    JSON.parse(filterSessionLogLine(sys, "standard", masks)).content,
    "start adapter=codex cwd=<workspace>"
  );
  const err = JSON.stringify({ ts: "t", type: "stderr", content: "boom at /h/app/x" });
  assert.equal(JSON.parse(filterSessionLogLine(err, "standard", masks)).content, "boom at <appdata>/x");
});

test("filterSessionLogLine standard strips stdin/stdout payloads but keeps event, error, usage", async () => {
  const { filterSessionLogLine } = await load();
  const payload = JSON.stringify({
    msg: { type: "assistant", text: "private reply", usage: { input_tokens: 1200, output_tokens: 55 } }
  });
  const line = JSON.stringify({ ts: "t", type: "stdout", content: payload });
  const out = JSON.parse(filterSessionLogLine(line, "standard", []));
  assert.equal(out.event, "assistant");
  assert.deepEqual(out.usage, { input_tokens: 1200, output_tokens: 55 });
  assert.equal(out.content, `<redacted: ${payload.length} chars>`);
  assert.ok(!JSON.stringify(out).includes("private reply"));
});

test("filterSessionLogLine standard keeps agent error messages like Compacting failed", async () => {
  const { filterSessionLogLine } = await load();
  const line = JSON.stringify({
    ts: "t",
    type: "stdout",
    content: JSON.stringify({ error: { code: -32603, message: "Compacting failed: aborted" } })
  });
  const out = JSON.parse(filterSessionLogLine(line, "standard", []));
  assert.equal(out.error, "Compacting failed: aborted");
  assert.equal(out.errorCode, -32603);
});

test("filterSessionLogLine standard replaces unparseable lines with a length marker", async () => {
  const { filterSessionLogLine } = await load();
  const out = JSON.parse(filterSessionLogLine("not json at all", "standard", []));
  assert.equal(out.type, "unparsed");
  assert.equal(out.content, "<redacted: 15 chars>");
});

test("filterOwnLogLine standard sanitizes data and msg, full keeps content", async () => {
  const { filterOwnLogLine, buildPathMasks } = await load();
  const masks = buildPathMasks({ home: "/h", userData: "/h/app", workspaces: [] });
  const line = JSON.stringify({ ts: "t", level: "error", scope: "chat", msg: "failed in /h/w", data: { content: "secret text" } });
  const std = JSON.parse(filterOwnLogLine(line, "standard", masks));
  assert.equal(std.msg, "failed in <home>/w");
  assert.equal(std.data.content, "<redacted: 11 chars>");
  const full = JSON.parse(filterOwnLogLine(line, "full", masks));
  assert.equal(full.data.content, "secret text");
});

test("redactsecrets masks Authorization headers including Bearer values", async () => {
  const { redactsecrets } = await load();
  assert.equal(
    redactsecrets("Authorization: abcdef1234567890"),
    "Authorization: <redacted>"
  );
  const out = redactsecrets("Authorization: Bearer abcdef1234567890");
  assert.ok(!out.includes("abcdef1234567890"));
});

test("redactsecrets masks access_token and refresh_token assignments", async () => {
  const { redactsecrets } = await load();
  assert.equal(
    redactsecrets("access_token: tok_abc123456"),
    "access_token: <redacted>"
  );
  assert.equal(
    redactsecrets("refresh_token=ref_abc123456"),
    "refresh_token=<redacted>"
  );
});

test("filterSessionLogLine standard drops unknown extra fields on system lines", async () => {
  const { filterSessionLogLine } = await load();
  const line = JSON.stringify({
    ts: "t",
    type: "system",
    content: "ok",
    command: "rm -rf /Users/alice/x"
  });
  const out = filterSessionLogLine(line, "standard", []);
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed).sort(), ["content", "ts", "type"]);
  assert.ok(!("command" in parsed));
  assert.ok(!out.includes("rm -rf"));
});

test("sanitizeLogData recurses into nested objects and arrays", async () => {
  const { sanitizeLogData, buildPathMasks } = await load();
  const masks = buildPathMasks({ home: "/h", userData: "/h/app", workspaces: [] });
  const nested = "nested secret";
  const out = sanitizeLogData(
    { details: { content: nested }, list: ["path /h/w"] },
    masks
  );
  assert.equal(out.details.content, `<redacted: ${nested.length} chars>`);
  assert.equal(out.list[0], "path <home>/w");
  assert.ok(!JSON.stringify(out).includes(nested));
});

// appendLog 位于文件尾部且只用到 fs 类型；抽出函数体连同依赖常量一起编译
async function loadAppendLog() {
  const sanitizeSource = fs.readFileSync(
    new URL("../electron/shared/logSanitize.ts", import.meta.url), "utf8"
  );
  const sharedSource = fs.readFileSync(
    new URL("../electron/cli/runtimeShared.ts", import.meta.url), "utf8"
  );
  const fnMatch = sharedSource.match(
    /const MAX_LOG_LINE_CHARS[\s\S]*?^export function appendLog[\s\S]*?\n}/m
  );
  assert.ok(
    fnMatch,
    "appendLog extraction regex no longer matches runtimeShared.ts — update the regex in this test"
  );
  const combined = `function formatLocalTimestamp(d){return d.toISOString()}\n${sanitizeSource}\n${fnMatch[0]
    .replace(/^import[^\n]*\n/gm, "")
    .replace("export function appendLog", "function appendLog")
    .replace("fs.WriteStream | null", "unknown")}\nexport { appendLog };`;
  const output = ts.transpileModule(combined, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const { appendLog } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
  const maxMatch = sharedSource.match(/const MAX_LOG_LINE_CHARS = ([\d_]+)/);
  assert.ok(maxMatch, "MAX_LOG_LINE_CHARS constant found");
  return { appendLog, maxLogLineChars: Number(maxMatch[1].replace(/_/g, "")) };
}

function fakeStream(writes) {
  return { writableEnded: false, destroyed: false, write: (s) => writes.push(s) };
}

test("appendLog redacts secrets before writing session log lines", async () => {
  const { appendLog } = await loadAppendLog();
  const writes = [];
  appendLog(fakeStream(writes), "stderr", "auth failed for sk-ant-abc123def456");
  const line = JSON.parse(writes[0]);
  assert.equal(line.content, "auth failed for sk-ant…<redacted>");
});

test("appendLog redacts keys straddling the truncation boundary", async () => {
  const { appendLog, maxLogLineChars } = await loadAppendLog();
  const writes = [];
  // Key starts before the MAX_LOG_LINE_CHARS cut and extends past it.
  const content = "x".repeat(maxLogLineChars - 10) + "sk-ant-abc123def456";
  appendLog(fakeStream(writes), "stderr", content);
  const line = JSON.parse(writes[0]);
  assert.ok(!line.content.includes("abc123def456"), "key fragment must not leak");
  assert.ok(line.content.endsWith("… [log truncated]"), "truncation marker kept");
});
