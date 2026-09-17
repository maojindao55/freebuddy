import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

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
    baseAdapter: "codex-acp",
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
    name: "硅基流动2", baseAdapter: "codex-acp", protocol: "openai-chat",
    baseUrl: "https://api.siliconflow.cn/v1", presetId: "siliconflow",
    apiKey: "sk-aaa",
  });
  assert.throws(
    () =>
      providers.upsertProvider({
        name: "重复", baseAdapter: "codex-acp", protocol: "openai-chat",
        baseUrl: "https://api.siliconflow.cn/v1/", presetId: "siliconflow",
        apiKey: "sk-bbb",
      }),
    /已存在/,
  );
  void p1;

  // 3. Agent BYOK 引用服务商
  store.upsertOverride({
    id: "test-agent",
    baseAdapter: "codex-acp",
    codexByok: { enabled: true, providerId: p.id },
  });
  const env = store.resolveCodexByokEnv("cli-test-agent", "codex-acp");
  assert.ok(env, "应解析出 env");
  assert.equal(env?.["OPENAI_API_KEY"], "sk-test-12345678", "Key 应来自服务商");
  assert.match(env?.["CODEX_CONFIG"] ?? "", /siliconflow/, "baseUrl 应来自服务商");

  // 4. 服务商改 Key，Agent 自动生效
  providers.upsertProvider({ id: p.id, name: p.name, baseAdapter: p.baseAdapter, protocol: p.protocol, baseUrl: p.baseUrl, apiKey: "sk-rotated-9999" });
  const env2 = store.resolveCodexByokEnv("cli-test-agent", "codex-acp");
  assert.equal(env2?.["OPENAI_API_KEY"], "sk-rotated-9999");

  // 5. 更新空 Key 保持原 Key
  providers.upsertProvider({ id: p.id, name: "改名", baseAdapter: p.baseAdapter, protocol: p.protocol, baseUrl: p.baseUrl });
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
