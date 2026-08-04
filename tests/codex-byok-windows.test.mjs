import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const storeSource = fs.readFileSync(
  new URL("../electron/cli/store.ts", import.meta.url),
  "utf8"
);
const runtimeSource = fs.readFileSync(
  new URL("../electron/cli/acpRuntime.ts", import.meta.url),
  "utf8"
);
const wrapperSource = fs.readFileSync(
  new URL("../electron/cli/codexByokWrapper.ts", import.meta.url),
  "utf8"
);

test("Codex BYOK wrapper module is platform-aware for Windows .cmd and Unix .sh", () => {
  assert.match(wrapperSource, /export function buildCodexAppServerWrapperContent/);
  assert.match(wrapperSource, /platform\s*===\s*["']win32["']/);
  assert.match(wrapperSource, /\.cmd/);
  assert.match(wrapperSource, /codex\.cmd/);
  assert.match(wrapperSource, /FREEBUDDY_CODEX_BIN/);
  assert.match(storeSource, /from ["'].\/codexByokWrapper/);
  assert.match(storeSource, /buildCodexAppServerWrapperContent/);
});

test("resolveCodexByokEnv sets FREEBUDDY_CODEX_BIN for the wrapper", () => {
  assert.match(
    storeSource,
    /env\.FREEBUDDY_CODEX_BIN\s*=/,
    "BYOK env must set FREEBUDDY_CODEX_BIN so the wrapper can find the real binary"
  );
  assert.match(
    storeSource,
    /from ["']\.\/codexBinaryHint/,
    "binary hint resolution lives in codexBinaryHint"
  );
  assert.match(
    storeSource,
    /env\.FREEBUDDY_NODE_BIN\s*=/,
    "BYOK env should pass FREEBUDDY_NODE_BIN so the wrapper can run bundled codex.js"
  );
});

test("ACP auth selection uses the agent child env so BYOK keys win over ChatGPT login", () => {
  assert.match(
    runtimeSource,
    /selectAcpAuthMethod\(\s*methods\s*,\s*agentCommand\.env\s*\)/,
    "auth method selection must see BYOK OPENAI_API_KEY from the agent env"
  );
  assert.equal(
    /selectAcpAuthMethod\(\s*methods\s*\)/.test(runtimeSource),
    false,
    "must not call selectAcpAuthMethod(methods) without the agent env"
  );
});

test("buildCodexAppServerWrapperContent emits Windows cmd and Unix sh scripts", async (t) => {
  let buildCodexAppServerWrapperContent;
  try {
    ({ buildCodexAppServerWrapperContent } = await import(
      "../dist-electron/cli/codexByokWrapper.js"
    ));
  } catch {
    t.skip("dist-electron wrapper not built yet");
    return;
  }

  const catalogPath = path.win32.join(
    "C:",
    "Users",
    "demo",
    "AppData",
    "Roaming",
    "FreeBuddy",
    "freebuddy",
    "codex-model-catalogs",
    "demo.json"
  );
  const win = buildCodexAppServerWrapperContent(catalogPath, "win32");
  assert.equal(win.extension, ".cmd");
  assert.match(win.script, /@echo off/i);
  assert.match(win.script, /model_catalog_json=/);
  assert.match(win.script, /%\*/);
  assert.match(win.script, /-c /);
  assert.match(win.script, /FREEBUDDY_CODEX_BIN/);
  assert.match(win.script, /FREEBUDDY_NODE_BIN/);
  assert.match(win.script, /codex\.cmd/);
  assert.match(
    win.script,
    /FREEBUDDY_CODEX_BIN:~-3%"=="\.js"/,
    "Windows wrapper must detect bundled codex.js and run it via node"
  );
  assert.match(
    win.script,
    /set "FREEBUDDY_CATALOG_PATH=C:\\Users\\demo\\/,
    "catalog path must be set without nested JSON quotes that break cmd.exe"
  );
  assert.doesNotMatch(win.script, /#!\/bin\/sh/);

  const unix = buildCodexAppServerWrapperContent(catalogPath, "darwin");
  assert.equal(unix.extension, ".sh");
  assert.match(unix.script, /^#!\/bin\/sh/);
  assert.match(unix.script, /command -v codex/);
  assert.match(unix.script, /\/opt\/homebrew\/bin\/codex/);
  assert.match(
    unix.script,
    /\*\.js\)/,
    "Unix wrapper must run bundled codex.js via node"
  );
  assert.match(unix.script, /FREEBUDDY_NODE_BIN/);
});

test("Claude BYOK compaction preserves window instead of dropping it on persist", () => {
  assert.match(
    storeSource,
    /window = contextWindow \?\? normalizeByokContextWindow\(input\.window\)/,
    "normalizeClaudeCompaction must keep the window field (canonical top-level first)"
  );
  assert.match(
    storeSource,
    /normalizeClaudeCompaction\(\s*input\.compaction \?\? previous\?\.compaction,\s*contextWindow\s*\)/,
    "storage must pass the canonical contextWindow so compaction.window stays synced"
  );
});
