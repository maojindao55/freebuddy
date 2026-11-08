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
  assert.match(
    wrapperSource,
    /script\.replace\(\/\\r\?\\n\/g,\s*["']\\r\\n["']\)/,
    "Windows wrapper must normalize line endings to CRLF"
  );
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
    try {
      ({ buildCodexAppServerWrapperContent } = await import(
        "../electron/cli/codexByokWrapper.ts"
      ));
    } catch {
      t.skip("dist-electron wrapper not built yet");
      return;
    }
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
  assert.equal(
    win.script.includes("\r\n"),
    true,
    "Windows wrapper must use CRLF line endings for cmd.exe compatibility"
  );
  assert.equal(
    /(?<!\r)\n/.test(win.script),
    false,
    "Windows wrapper must not contain bare LF line endings"
  );

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

test("Codex BYOK wrapper repeats the provider in the codex config layer", () => {
  // codex 0.166.0 added a per-turn `modelProviderMismatch` check: the provider
  // recorded on the thread must equal the provider the config layer resolves.
  // FreeBuddy only sent it in the thread/start request, so codex resolved
  // "openai" and rejected every prompt. The wrapper must therefore repeat the
  // provider through `-c`.
  assert.match(
    wrapperSource,
    /export function buildCodexProviderConfigArgs/,
    "wrapper module must expose the provider -c builder"
  );
  assert.match(
    wrapperSource,
    /model_provider=\$\{tomlLiteral\(providerId\)\}/,
    "model_provider must be written as a TOML literal"
  );
  assert.match(
    wrapperSource,
    /model_providers=\{\$\{tomlLiteral\(providerId\)\}/,
    "model_providers entry must use the provider id as the table key"
  );
  assert.match(
    wrapperSource,
    /providerWords[\s\S]*?` -c \$\{shellSingleQuote\(arg\)\}`/,
    "Unix wrapper must give every provider value its own -c flag"
  );
  assert.match(
    wrapperSource,
    /providerArgsCmd[\s\S]*?` -c "\$\{arg/,
    "Windows wrapper must give every provider value its own -c flag"
  );
  assert.match(
    storeSource,
    /createCodexAppServerWrapper\(modelCatalogPath,\s*\{[\s\S]*?providerId/,
    "resolveCodexByokEnv must pass the provider into the wrapper"
  );
});

test("Codex provider -c payload contains no double quotes and keeps TOML literals", async (t) => {
  let buildCodexProviderConfigArgs;
  try {
    ({ buildCodexProviderConfigArgs } = await import(
      "../dist-electron/cli/codexByokWrapper.js"
    ));
  } catch {
    try {
      ({ buildCodexProviderConfigArgs } = await import(
        "../electron/cli/codexByokWrapper.ts"
      ));
    } catch {
      t.skip("dist-electron wrapper not built yet");
      return;
    }
  }

  const args = buildCodexProviderConfigArgs({
    providerId: "provider-longcat-7h89mc",
    providerName: "美团 LongCat 开放平台",
    baseUrl: "https://api.longcat.chat/openai/v1",
    envKey: "OPENAI_API_KEY"
  });
  assert.equal(args.length, 2);
  assert.equal(args[0], "model_provider='provider-longcat-7h89mc'");
  assert.match(args[1], /^model_providers=\{'provider-longcat-7h89mc'=\{/);
  assert.match(args[1], /name='美团 LongCat 开放平台'/);
  assert.match(args[1], /wire_api='responses'/);
  // No double quote anywhere: the payload is safe for cmd.exe and sh alike.
  for (const arg of args) assert.equal(arg.includes('"'), false, arg);

  // Dots/spaces in the id stay a valid TOML literal key.
  const dotted = buildCodexProviderConfigArgs({
    providerId: "weird.id x",
    baseUrl: "https://example.test/v1"
  });
  assert.equal(dotted[0], "model_provider='weird.id x'");
  assert.match(dotted[1], /\{'weird\.id x'=\{/);
  // A missing base_url cannot describe a provider, so nothing is injected.
  assert.deepEqual(
    buildCodexProviderConfigArgs({ providerId: "provider-x" }),
    []
  );
  assert.deepEqual(buildCodexProviderConfigArgs(undefined), []);
  // A single quote in a value is doubled, never escaping out of the literal.
  const quoted = buildCodexProviderConfigArgs({
    providerId: "provider-q",
    providerName: "Bob's API",
    baseUrl: "https://example.test/v1"
  });
  assert.match(quoted[1], /name='Bob''s API'/);
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

test("Codex BYOK model catalog template merges fallback to keep required fields", () => {
  // The ~/.codex/models_cache.json template lacks required catalog fields
  // (base_instructions, truncation_policy, …) and may carry Responses-Lite /
  // code-mode flags that hide all tools from custom providers
  // (openai/codex#34758). The merged template must fall back for missing
  // fields and force plain shell tools.
  assert.match(
    storeSource,
    /\.\.\.fallbackCodexModelTemplate\(\),\s*\.\.\.cached/,
    "cached model template must be merged over the fallback, not used as-is"
  );
  assert.match(
    storeSource,
    /merged\.shell_type = "shell_command"/,
    "merged template must force shell_type shell_command so exec tools are exposed"
  );
  assert.match(
    storeSource,
    /merged\.use_responses_lite = false/,
    "merged template must disable responses-lite so tools stay in the top-level tools array"
  );
  assert.match(
    storeSource,
    /delete merged\.tool_mode/,
    "merged template must drop code-mode tool_mode overrides"
  );
});

test("Codex BYOK model catalog advertises per-model image input capability", () => {
  assert.match(
    storeSource,
    /input_modalities:\s*\n?\s*model\.supportsVision === false\s*\? \["text"\]\s*:\s*\["text", "image"\]/,
    "vision-capable BYOK models must enable view_image as well as direct attachments"
  );
  assert.match(
    storeSource,
    /defaultSupportsVision: true/,
    "legacy Codex BYOK models should match the existing direct-image behavior"
  );
  assert.match(
    storeSource,
    /model\.supportsVision === false \? "text" : "vision"/,
    "the catalog cache key must change when image capability changes"
  );
});

test("Codex BYOK model catalog is written even for gpt-* model ids", () => {
  // The old guard skipped catalog creation for gpt-*/o-series ids, so BYOK
  // sessions on those models never got a catalog, fell back to codex's
  // bundled gpt-5.6* metadata, and lost all tools via Responses-Lite
  // (openai/codex#34758).
  assert.doesNotMatch(
    storeSource,
    /o\[1345\]/,
    "the gpt-*/o-series guard must not skip BYOK catalog creation"
  );
  assert.match(
    storeSource,
    /function readCachedCodexModelSlugs/,
    "cached codex model slugs feed the BYOK catalog"
  );
  assert.match(
    storeSource,
    /\.\.\.readCachedCodexModelSlugs\(\)\.map\(\(slug\) => \(\{ id: slug \}\)\)/,
    "BYOK catalog must cover every cached codex model because the in-session picker selects models via ACP after env resolution"
  );
  assert.match(
    storeSource,
    /models_cache\.json/,
    "cached slugs come from codex's models_cache.json"
  );
});
