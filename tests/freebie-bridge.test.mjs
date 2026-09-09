import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
}

function importInline(code) {
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

async function loadProtocol() {
  return importInline(transpile(read("../src/services/freebie/protocol.ts")));
}

async function loadPresetToOverride() {
  // Type-only imports are erased by transpilation; only the nanoid runtime import
  // needs a deterministic stand-in.
  const source = read("../src/services/freebie/presetToOverride.ts").replace(
    /import \{ customAlphabet \} from "nanoid";/,
    "const customAlphabet = () => () => 'abc123';"
  );
  return importInline(transpile(source));
}

const validPreset = {
  id: "zhipu",
  name: "智谱 BigModel",
  region: "cn",
  homepage: "https://bigmodel.cn",
  consoleUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
  freeTierSummary: { "zh-CN": "GLM-4-Flash 永久免费", en: "GLM-4-Flash is free" },
  protocol: "openai-chat",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
  envKey: "OPENAI_API_KEY",
  models: [
    { id: "glm-4-flash", name: "GLM-4-Flash", contextWindow: 128000 },
    { id: "glm-4.1v-thinking-flash", supportsVision: true }
  ],
  verifiedAt: "2026-09-09",
  somethingUnknown: { nested: true }
};

test("validateFreebiePreset accepts a valid preset and strips unknown fields", async () => {
  const { validateFreebiePreset } = await loadProtocol();
  const result = validateFreebiePreset(validPreset);
  assert.equal(result.ok, true);
  assert.equal(result.value.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(result.value.models.length, 2);
  assert.equal(result.value.models[1].supportsVision, true);
  assert.equal("somethingUnknown" in result.value, false);
  assert.deepEqual(result.value.freeTierSummary, validPreset.freeTierSummary);
});

test("validateFreebiePreset rejects unsafe or malformed presets", async () => {
  const { validateFreebiePreset } = await loadProtocol();
  const cases = [
    [{ ...validPreset, baseUrl: "http://api.example.com/v1" }, /https/],
    [{ ...validPreset, baseUrl: "https://user:pw@api.example.com/v1" }, /https/],
    [{ ...validPreset, protocol: "grpc" }, /protocol/],
    [{ ...validPreset, models: [] }, /models/],
    [{ ...validPreset, models: [{ name: "no id" }] }, /models/],
    [{ ...validPreset, id: "Bad Id!" }, /provider id/],
    [{ ...validPreset, name: "" }, /name/],
    ["not-an-object", /object/]
  ];
  for (const [input, pattern] of cases) {
    const result = validateFreebiePreset(input);
    assert.equal(result.ok, false, JSON.stringify(input).slice(0, 60));
    assert.match(result.error, pattern);
  }
});

test("validateFreebiePreset tolerates loopback http for local development and drops bad optional fields", async () => {
  const { validateFreebiePreset } = await loadProtocol();
  const result = validateFreebiePreset({
    ...validPreset,
    baseUrl: "http://localhost:8080/v1",
    homepage: "javascript:alert(1)",
    envKey: "lowercase",
    verifiedAt: "yesterday",
    region: "mars",
    models: [{ id: "a" }, { id: "a" }, { id: 42 }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.baseUrl, "http://localhost:8080/v1");
  assert.equal(result.value.homepage, undefined);
  assert.equal(result.value.envKey, undefined);
  assert.equal(result.value.verifiedAt, undefined);
  assert.equal(result.value.region, undefined);
  assert.deepEqual(result.value.models, [{ id: "a" }]);
});

test("parseFreebiePageMessage ignores unrelated traffic and validates bridge messages", async () => {
  const { parseFreebiePageMessage, FREEBIE_BRIDGE_SOURCE, FREEBIE_PROTOCOL_VERSION } =
    await loadProtocol();
  const envelope = (message) => ({
    source: FREEBIE_BRIDGE_SOURCE,
    protocolVersion: FREEBIE_PROTOCOL_VERSION,
    ...message
  });

  assert.equal(parseFreebiePageMessage({ type: "GAME_CANVAS_READY" }), null);
  assert.equal(parseFreebiePageMessage("hello"), null);

  const wrongVersion = parseFreebiePageMessage({ ...envelope({ type: "ready" }), protocolVersion: 99 });
  assert.equal(wrongVersion.ok, false);

  assert.deepEqual(parseFreebiePageMessage(envelope({ type: "ready" })), {
    ok: true,
    value: { type: "ready" }
  });

  const external = parseFreebiePageMessage(envelope({ type: "openExternal", url: "http://evil.example" }));
  assert.equal(external.ok, false);
  const externalOk = parseFreebiePageMessage(envelope({ type: "openExternal", url: "https://groq.com" }));
  assert.equal(externalOk.ok, true);

  const missingId = parseFreebiePageMessage(envelope({ type: "importAgent", preset: validPreset }));
  assert.equal(missingId.ok, false);

  const imported = parseFreebiePageMessage(
    envelope({ type: "importAgent", requestId: "r1", preset: validPreset })
  );
  assert.equal(imported.ok, true);
  assert.equal(imported.value.type, "importAgent");
  assert.equal(imported.value.requestId, "r1");
  assert.equal(imported.value.preset.id, "zhipu");

  assert.equal(parseFreebiePageMessage(envelope({ type: "deleteEverything" })).ok, false);
});

test("pickFreebieSummary prefers exact locale, then language, then English", async () => {
  const { pickFreebieSummary } = await loadProtocol();
  const summary = { "zh-CN": "中文", en: "English", fr: "Français" };
  assert.equal(pickFreebieSummary(summary, "zh-CN"), "中文");
  assert.equal(pickFreebieSummary(summary, "zh-TW"), "中文");
  assert.equal(pickFreebieSummary(summary, "de"), "English");
  assert.equal(pickFreebieSummary(undefined, "en"), undefined);
});

test("buildFreebieOverride maps protocols to base adapters and BYOK blocks", async () => {
  const mod = await loadPresetToOverride();
  const { validateFreebiePreset } = await loadProtocol();
  const preset = validateFreebiePreset(validPreset).value;

  const codex = mod.buildFreebieOverride({ preset, apiKey: " sk-test ", label: "智谱（白嫖）" });
  assert.equal(codex.id, "freebie-zhipu-abc123");
  assert.equal(codex.baseAdapter, "codex-acp");
  assert.equal(codex.label, "智谱（白嫖）");
  assert.equal(codex.enabled, true);
  assert.deepEqual(codex.extraArgs, ["--model=glm-4-flash"]);
  assert.equal(codex.codexByok.enabled, true);
  assert.equal(codex.codexByok.wireApi, "chat");
  assert.equal(codex.codexByok.apiKey, "sk-test");
  assert.equal(codex.codexByok.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(codex.codexByok.envKey, "OPENAI_API_KEY");
  assert.equal(codex.codexByok.providerId, "zhipu");
  assert.equal(codex.codexByok.models.length, 2);
  assert.equal(codex.claudeByok, undefined);
  assert.equal(codex.deepseekByok, undefined);

  const responses = mod.buildFreebieOverride({
    preset: { ...preset, protocol: "openai-responses" },
    apiKey: "k",
    label: "x"
  });
  assert.equal(responses.codexByok.wireApi, "responses");

  const claude = mod.buildFreebieOverride({
    preset: { ...preset, protocol: "anthropic", envKey: undefined },
    apiKey: "k",
    modelIds: ["glm-4.1v-thinking-flash"],
    label: "x"
  });
  assert.equal(claude.baseAdapter, "claude-agent-acp");
  assert.equal(claude.claudeByok.envKey, "ANTHROPIC_API_KEY");
  assert.deepEqual(claude.extraArgs, ["--model=glm-4.1v-thinking-flash"]);
  assert.equal(claude.claudeByok.models.length, 1);
  assert.equal(claude.codexByok, undefined);

  const deepseek = mod.buildFreebieOverride({
    preset: { ...preset, protocol: "deepseek", envKey: undefined },
    apiKey: "k",
    label: "x"
  });
  assert.equal(deepseek.baseAdapter, "dsh-acp");
  assert.equal(deepseek.deepseekByok.wireApi, "chat");
  assert.equal(deepseek.deepseekByok.envKey, "DEEPSEEK_API_KEY");

  assert.throws(() => mod.buildFreebieOverride({ preset, apiKey: "   ", label: "x" }), /apiKey/);
  assert.throws(
    () => mod.buildFreebieOverride({ preset, apiKey: "k", modelIds: ["nope"], label: "x" }),
    /model/
  );
});

test("freebie override ids round-trip the provider slug", async () => {
  const mod = await loadPresetToOverride();
  assert.equal(mod.freebieProviderIdFromOverrideId("freebie-zhipu-abc123"), "zhipu");
  assert.equal(mod.freebieProviderIdFromOverrideId("freebie-google-ai-studio-9z8y7x"), "google-ai-studio");
  assert.equal(mod.freebieProviderIdFromOverrideId("codex-acp-clone-abcdefgh"), null);
  assert.equal(mod.freebieProviderIdFromOverrideId("freebie-zhipu"), null);
  assert.deepEqual(
    mod.importedFreebieProviderIds(["freebie-zhipu-abc123", "freebie-zhipu-def456", "codex-acp", "freebie-groq-000000"]),
    ["groq", "zhipu"]
  );
});

test("bundled providers.json validates and has unique ids", async () => {
  const { validateFreebiePreset } = await loadProtocol();
  const catalog = JSON.parse(read("../src/services/freebie/providers.json"));
  assert.match(catalog.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(catalog.providers) && catalog.providers.length >= 5);
  const ids = new Set();
  for (const provider of catalog.providers) {
    const result = validateFreebiePreset(provider);
    assert.equal(result.ok, true, `${provider.id}: ${result.ok ? "" : result.error}`);
    assert.ok(!ids.has(provider.id), `duplicate provider id ${provider.id}`);
    ids.add(provider.id);
    assert.ok(provider.consoleUrl, `${provider.id} needs a consoleUrl so users can get a key`);
    assert.ok(provider.freeTierSummary?.["zh-CN"] && provider.freeTierSummary?.en, `${provider.id} needs zh-CN and en summaries`);
    assert.match(provider.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, `${provider.id} needs verifiedAt`);
  }
  assert.ok(fs.existsSync(new URL("../src/services/freebie/providers.schema.json", import.meta.url)));
});

test("freebie is wired as a first-class workspace with a hardened bridge", () => {
  const app = read("../src/App.tsx");
  const sidebar = read("../src/components/CLI/SidebarNavigation.tsx");
  const bridge = read("../src/components/Freebie/useFreebieBridge.ts");
  const dialog = read("../src/components/Freebie/FreebieImportDialog.tsx");
  const page = read("../src/components/Freebie/FreebiePage.tsx");
  const presence = read("../electron/uiPresence.ts");
  const css = read("../styles.css");
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));

  assert.match(sidebar, /WorkspaceView = [^;]*"freebie"/);
  assert.match(sidebar, /const freebieActive = workspaceView === "freebie"/);
  assert.match(sidebar, /<Gift \/>/);
  assert.match(app, /onOpenFreebie=\{openFreebie\}/);
  assert.match(app, /setWorkspaceView\("freebie"\)/);
  assert.match(app, /<FreebiePage/);
  assert.match(presence, /"freebie"/);

  // Origin + source checks and payload validation must all be present.
  assert.match(bridge, /event\.origin !== FREEBIE_PAGE_ORIGIN/);
  assert.match(bridge, /event\.source !== iframeRef\.current\?\.contentWindow/);
  assert.match(bridge, /parseFreebiePageMessage\(event\.data\)/);
  assert.match(bridge, /postMessage\(wrapHostMessage\(message\), FREEBIE_PAGE_ORIGIN\)/);

  // The API key is typed natively and never comes from the page.
  assert.match(dialog, /type="password"/);
  assert.match(dialog, /autoComplete="off"/);
  assert.match(dialog, /preset\.baseUrl/);
  assert.doesNotMatch(read("../src/services/freebie/protocol.ts"), /apiKey/);
  assert.match(page, /sandbox="allow-scripts allow-same-origin allow-forms allow-popups"/);
  assert.match(page, /FREEBIE_BUNDLED_PROVIDERS/);

  assert.equal(zh.sidebar.freebie, "白嫖");
  assert.ok(en.sidebar.freebie);
  for (const key of ["title", "loading", "agentLabel"]) {
    assert.ok(en.freebie[key], `missing en freebie.${key}`);
    assert.ok(zh.freebie[key], `missing zh-CN freebie.${key}`);
  }
  assert.match(css, /\.freebie-page\s*\{/);
  assert.match(css, /\.freebie-import-dialog\s*\{/);
});
