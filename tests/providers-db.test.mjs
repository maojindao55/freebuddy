import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
}

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

test("providers CRUD + BYOK reference resolution", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  const providers = await import("../dist-electron/cli/providers.js");
  const store = await import("../dist-electron/cli/store.js");

  const db = new Database(":memory:");
  setDbForTest(db);
  migrate(db);

  // 1. 新建服务商
  const p = providers.upsertProvider({
    name: "硅基流动",
    protocol: "openai-chat",
    baseUrl: "https://api.siliconflow.cn/v1",
    envKey: "OPENAI_API_KEY",
    apiKey: "sk-test-12345678",
    models: [{ id: "Qwen/Qwen2.5-7B-Instruct" }],
  });
  assert.ok(p.id.startsWith("provider-"));
  assert.equal(p.hasKey, true);
  assert.match(p.apiKeyPreview ?? "", /5678/);
  assert.equal(p.apiKey, undefined, "读回不能带明文 Key");

  // 2. 去重：同 presetId + baseUrl 拒绝
  const p1 = providers.upsertProvider({
    name: "硅基流动2", protocol: "openai-chat",
    baseUrl: "https://api.siliconflow.cn/v1", presetId: "siliconflow",
    apiKey: "sk-aaa",
  });
  assert.throws(
    () =>
      providers.upsertProvider({
        name: "重复", protocol: "openai-chat",
        baseUrl: "https://api.siliconflow.cn/v1/", presetId: "siliconflow",
        apiKey: "sk-bbb",
      }),
    /已存在/,
  );
  void p1;

  // 3. Agent BYOK 引用服务商
  store.upsertOverride({
    id: "test-agent",
    codexByok: { enabled: true, providerId: p.id },
  });
  const env = store.resolveCodexByokEnv("cli-test-agent", "codex-acp");
  assert.ok(env, "应解析出 env");
  assert.equal(env?.["OPENAI_API_KEY"], "sk-test-12345678", "Key 应来自服务商");
  assert.match(env?.["CODEX_CONFIG"] ?? "", /siliconflow/, "baseUrl 应来自服务商");

  // 4. 服务商改 Key，Agent 自动生效
  providers.upsertProvider({ id: p.id, name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, apiKey: "sk-rotated-9999" });
  const env2 = store.resolveCodexByokEnv("cli-test-agent", "codex-acp");
  assert.equal(env2?.["OPENAI_API_KEY"], "sk-rotated-9999");

  // 5. 更新空 Key 保持原 Key
  providers.upsertProvider({ id: p.id, name: "改名", protocol: p.protocol, baseUrl: p.baseUrl });
  const env3 = store.resolveCodexByokEnv("cli-test-agent", "codex-acp");
  assert.equal(env3?.["OPENAI_API_KEY"], "sk-rotated-9999", "空 Key 不应清空");

  // 6. 有引用时禁止删除
  assert.throws(() => providers.deleteProvider(p.id), /正在使用/);

  // 7. 停用服务商后回落（raw 无 baseUrl，应无 env）
  providers.setProviderEnabled(p.id, false);
  const rec = providers.getProvider(p.id);
  assert.equal(rec?.enabled, false);

  setDbForTest(null);
});

test("one provider serves several agent kinds, gated by protocol only", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  const providers = await import("../dist-electron/cli/providers.js");
  const store = await import("../dist-electron/cli/store.js");
  const db = new Database(":memory:");
  setDbForTest(db);
  migrate(db);

  // A relay that speaks both OpenAI-compatible chat and DeepSeek.
  const relay = providers.upsertProvider({
    name: "OneRelay",
    protocol: "openai-chat",
    protocols: ["openai-chat", "deepseek"],
    baseUrl: "https://relay.example.com/v1",
    envKey: "OPENAI_API_KEY",
    apiKey: "sk-shared-key",
    models: [{ id: "m-1" }],
  });

  // Same provider referenced by two different agent kinds at once.
  store.upsertOverride({
    id: "agent-codex",
    codexByok: { enabled: true, providerId: relay.id },
  });
  store.upsertOverride({
    id: "agent-dsh",
    baseAdapter: "dsh-acp",
    deepseekByok: { enabled: true, providerId: relay.id },
  });

  const codexEnv = store.resolveCodexByokEnv("cli-agent-codex", "codex-acp");
  assert.ok(codexEnv, "Codex should resolve the shared provider");
  assert.equal(codexEnv?.["OPENAI_API_KEY"], "sk-shared-key");

  // The provider row itself must not carry an adapter binding.
  const record = providers.getProvider(relay.id);
  assert.equal(
    Object.prototype.hasOwnProperty.call(record, "baseAdapter"),
    false,
    "provider must not store an adapter binding",
  );

  setDbForTest(null);
});

test("provider compatibility is derived from protocol, not a stored adapter", async () => {
  const source = fs.readFileSync(
    new URL("../src/services/providers/types.ts", import.meta.url),
    "utf8"
  );
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(transpile(source)).toString("base64")}`
  );

  // A relay that speaks both OpenAI chat and DeepSeek is usable by Codex and
  // by DeepSeek Harness at the same time. This is the whole point of not
  // binding a provider to one adapter.
  const relay = { protocol: "openai-chat", protocols: ["openai-chat", "deepseek"] };
  assert.equal(mod.isProviderCompatibleWithAdapter(relay, "codex-acp"), true);
  assert.equal(mod.isProviderCompatibleWithAdapter(relay, "dsh-acp"), true);
  assert.equal(mod.isProviderCompatibleWithAdapter(relay, "claude-agent-acp"), false);

  // Anthropic-only relays are Claude-only.
  const anthropic = { protocol: "anthropic", protocols: ["anthropic"] };
  assert.equal(mod.isProviderCompatibleWithAdapter(anthropic, "claude-agent-acp"), true);
  assert.equal(mod.isProviderCompatibleWithAdapter(anthropic, "codex-acp"), false);
  assert.equal(mod.isProviderCompatibleWithAdapter(anthropic, "dsh-acp"), false);

  // `protocols` wins when present; bare `protocol` is the fallback.
  assert.deepEqual(mod.protocolsOf({ protocol: "deepseek" }), ["deepseek"]);
  assert.deepEqual(
    mod.protocolsOf({ protocol: "openai-chat", protocols: ["openai-chat", "anthropic"] }),
    ["openai-chat", "anthropic"]
  );

  // env key follows the protocol alone.
  assert.equal(mod.defaultEnvKeyForProtocol("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(mod.defaultEnvKeyForProtocol("deepseek"), "DEEPSEEK_API_KEY");
  assert.equal(mod.defaultEnvKeyForProtocol("openai-chat"), "OPENAI_API_KEY");
  assert.equal(mod.defaultEnvKeyForProtocol("openai-responses"), "OPENAI_API_KEY");

  // No adapter-binding API may survive on the provider surface.
  assert.equal("baseAdapterForProtocol" in mod, false);
  assert.equal("defaultEnvKeyForProvider" in mod, false);
  assert.doesNotMatch(source, /baseAdapter\s*[:?]/, "provider types must not declare baseAdapter");
});

test("provider compatibility helper is not duplicated in the UI layer", () => {
  const store = fs.readFileSync(
    new URL("../src/store/providerStore.ts", import.meta.url),
    "utf8"
  );
  const picker = fs.readFileSync(
    new URL("../src/components/Settings/ProviderSelect.tsx", import.meta.url),
    "utf8"
  );
  for (const [name, src] of [["providerStore", store], ["ProviderSelect", picker]]) {
    assert.match(src, /isProviderCompatibleWithAdapter/, `${name} must reuse the shared helper`);
    assert.doesNotMatch(
      src,
      /=== "dsh-acp"/,
      `${name} must not re-implement protocol compatibility inline`
    );
  }
});

test("a pre-existing providers table loses base_adapter without losing rows", (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  // Mirrors the column set an earlier build created, NOT NULL DEFAULT included,
  // which is the shape that makes a naive DROP COLUMN fail.
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE providers (
       id TEXT PRIMARY KEY, name TEXT NOT NULL,
       base_adapter TEXT NOT NULL DEFAULT 'codex-acp',
       protocol TEXT NOT NULL DEFAULT 'openai-chat',
       base_url TEXT NOT NULL, env_key TEXT, models TEXT,
       enabled INTEGER DEFAULT 1, position INTEGER DEFAULT 100,
       updated_at TEXT NOT NULL)`
  );
  db.prepare(
    "INSERT INTO providers (id,name,base_url,updated_at) VALUES (?,?,?,?)"
  ).run("p1", "legacy", "https://x.example.com", "2026-01-01");

  assert.ok(
    db.prepare("PRAGMA table_info(providers)").all().some((c) => c.name === "base_adapter")
  );

  // The migration step under test.
  db.exec("ALTER TABLE providers DROP COLUMN base_adapter");

  assert.equal(
    db.prepare("PRAGMA table_info(providers)").all().some((c) => c.name === "base_adapter"),
    false
  );
  assert.deepEqual(db.prepare("SELECT id,name,base_url FROM providers").get(), {
    id: "p1",
    name: "legacy",
    base_url: "https://x.example.com"
  });
});

test("providers table no longer declares base_adapter", () => {
  const db = fs.readFileSync(new URL("../electron/cli/db.ts", import.meta.url), "utf8");
  const providersTable = db.slice(db.indexOf("CREATE TABLE IF NOT EXISTS providers"));
  const createBlock = providersTable.slice(0, providersTable.indexOf(");"));
  assert.doesNotMatch(createBlock, /base_adapter/, "fresh installs must not create the column");
  assert.match(db, /ALTER TABLE providers DROP COLUMN base_adapter/, "upgrade path must drop it");
});

test("legacy freebie-* overrides migrate to providers", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  const providers = await import("../dist-electron/cli/providers.js");
  const db = new Database(":memory:");
  setDbForTest(db);
  // 先建表
  migrate(db);
  // 模拟老数据
  db.prepare(
    `INSERT INTO cli_executor_overrides (id, base_adapter, label, codex_byok, updated_at) VALUES (?,?,?,?,?)`,
  ).run(
    "freebie-siliconflow-abc123",
    "codex-acp",
    "SiliconFlow",
    JSON.stringify({ enabled: true, baseUrl: "https://api.siliconflow.cn/v1", providerName: "SiliconFlow", models: [{ id: "m1" }] }),
    new Date().toISOString(),
  );
  // 再次 migrate 触发迁移
  migrate(db);
  const list = providers.listProviders();
  assert.ok(list.some((x) => x.id === "freebie-siliconflow-abc123"), "legacy id preserved");
  assert.equal(list.find((x) => x.id === "freebie-siliconflow-abc123")?.presetId, "siliconflow");
  setDbForTest(null);
});

test("freebie preset import registers a provider and agent BYOK references it without plaintext key", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  const providers = await import("../dist-electron/cli/providers.js");
  const store = await import("../dist-electron/cli/store.js");
  const db = new Database(":memory:");
  setDbForTest(db);
  migrate(db);

  // 1. 模拟 Freebie 一键导入创建 Provider
  const provider = providers.upsertProvider({
    presetId: "siliconflow",
    name: "硅基流动",
    protocol: "openai-chat",
    protocols: ["openai-chat", "deepseek"],
    baseUrl: "https://api.siliconflow.cn/v1",
    envKey: "OPENAI_API_KEY",
    apiKey: "sk-silicon-secret-12345",
    models: [{ id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3" }],
  });
  assert.equal(provider.presetId, "siliconflow");
  assert.equal(provider.hasKey, true);

  // 2. 模拟创建的 Agent Override：仅保存 providerId 引用，绝无明文 Key
  store.upsertOverride({
    id: "freebie-siliconflow-xyz789",
    baseAdapter: "codex-acp",
    label: "硅基流动 Agent",
    codexByok: {
      enabled: true,
      providerId: provider.id,
      providerName: "硅基流动",
    },
  });

  // 3. 运行期解析：主进程自动合并服务商的 Key 和 BaseUrl
  const env = store.resolveCodexByokEnv("cli-freebie-siliconflow-xyz789", "codex-acp");
  assert.ok(env, "Codex env should resolve");
  assert.equal(env?.["OPENAI_API_KEY"], "sk-silicon-secret-12345");
  assert.match(env?.["CODEX_CONFIG"] ?? "", /api\.siliconflow\.cn/);

  // 4. 重复导入/编辑：提供原 id 可就地更新 Key，Agent 自动感知
  providers.upsertProvider({
    id: provider.id,
    presetId: "siliconflow",
    name: "硅基流动",
    protocol: "openai-chat",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "sk-silicon-secret-rotated",
  });
  const envRotated = store.resolveCodexByokEnv("cli-freebie-siliconflow-xyz789", "codex-acp");
  assert.equal(envRotated?.["OPENAI_API_KEY"], "sk-silicon-secret-rotated");

  setDbForTest(null);
});

test("agent referencing provider resolves models dynamically from provider", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  const providers = await import("../dist-electron/cli/providers.js");
  const store = await import("../dist-electron/cli/store.js");
  const db = new Database(":memory:");
  setDbForTest(db);
  migrate(db);

  // 1. 创建服务商，带启用的模型和禁用的模型
  const provider = providers.upsertProvider({
    name: "硅基流动",
    protocol: "openai-chat",
    baseUrl: "https://api.siliconflow.cn/v1",
    envKey: "OPENAI_API_KEY",
    apiKey: "sk-test-models",
    models: [
      { id: "model-active-1", name: "Active Model 1" },
      { id: "model-disabled", name: "Disabled Model", enabled: false },
      { id: "model-active-2", name: "Active Model 2", enabled: true },
    ],
  });

  // 2. Agent 引用该服务商
  store.upsertOverride({
    id: "agent-dynamic-models",
    baseAdapter: "codex-acp",
    label: "Dynamic Models Agent",
    codexByok: {
      enabled: true,
      providerId: provider.id,
    },
  });

  // 3. hasCliByokModels 应该返回 true
  assert.equal(
    store.hasCliByokModels("cli-agent-dynamic-models", "codex-acp"),
    true,
    "hasCliByokModels should resolve via provider"
  );

  // 4. cliByokModelSignature 只应包含启用的模型
  const signature = JSON.parse(
    store.cliByokModelSignature("cli-agent-dynamic-models", "codex-acp")
  );
  assert.equal(signature.length, 2);
  assert.deepEqual(
    signature.map((m) => m.id),
    ["model-active-1", "model-active-2"]
  );

  // 5. mergeCliByokModelOption 下拉选项应解析服务商启用模型
  const initialOptions = [];
  const mergedOptions = store.mergeCliByokModelOption(
    "cli-agent-dynamic-models",
    "codex-acp",
    initialOptions
  );
  const modelOption = mergedOptions.find((opt) => opt.id === "model");
  assert.ok(modelOption, "Model option should be added");
  assert.deepEqual(
    modelOption.values.map((v) => v.id),
    ["model-active-1", "model-active-2"]
  );

  // 6. 服务商动态添加模型，Agent 自动感知无需重新保存
  providers.upsertProvider({
    id: provider.id,
    name: "硅基流动",
    protocol: "openai-chat",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: [
      { id: "model-active-1", name: "Active Model 1" },
      { id: "model-active-3", name: "Active Model 3" },
    ],
  });

  const updatedOptions = store.mergeCliByokModelOption(
    "cli-agent-dynamic-models",
    "codex-acp",
    initialOptions
  );
  const updatedModelOption = updatedOptions.find((opt) => opt.id === "model");
  assert.deepEqual(
    updatedModelOption.values.map((v) => v.id),
    ["model-active-1", "model-active-3"],
    "Options should dynamically reflect provider model updates"
  );

  setDbForTest(null);
});
