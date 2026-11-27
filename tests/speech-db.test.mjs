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

test("speech_providers DB storage, secret masking, linked_provider resolution, and preferences", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  const providers = await import("../dist-electron/cli/providers.js");
  const speechStorage = await import("../dist-electron/speech/storage.js");

  const db = new Database(":memory:");
  setDbForTest(db);
  migrate(db);

  try {
    // 1. Default snapshot has all 3 providers masked & disabled
    const initial = speechStorage.getSpeechConfig();
    assert.equal(initial.preferences.activeAsrProvider, null);
    assert.equal(initial.preferences.activeTtsProvider, null);
    assert.equal(initial.providers.deepseek.hasApiKey, false);
    assert.equal(initial.providers.dashscope.dashscopeEndpointPreset, "payg-cn");
    assert.equal(initial.providers.volcengine.volcAuthMode, "app_token");

    // 2. Save custom DeepSeek key — readback must stay redacted
    const dsSaved = speechStorage.saveSpeechProvider({
      kind: "deepseek",
      enabled: true,
      credentialMode: "custom",
      apiKey: "sk-deepseek-secret-9876",
      ttsVoice: "tide",
    });
    assert.equal(dsSaved.enabled, true);
    assert.equal(dsSaved.hasApiKey, true);
    assert.match(dsSaved.apiKeyPreview ?? "", /9876/);
    assert.equal("apiKey" in dsSaved, false);

    // 3. Partial update without apiKey preserves secret; clearApiKey wipes it
    const dsRenamed = speechStorage.saveSpeechProvider({
      kind: "deepseek",
      ttsVoice: "stella",
    });
    assert.equal(dsRenamed.hasApiKey, true);
    assert.equal(
      speechStorage.resolveSpeechRuntimeConfig("deepseek").apiKey,
      "sk-deepseek-secret-9876"
    );

    const dsCleared = speechStorage.saveSpeechProvider({
      kind: "deepseek",
      clearApiKey: true,
    });
    assert.equal(dsCleared.hasApiKey, false);
    assert.throws(
      () => speechStorage.resolveSpeechRuntimeConfig("deepseek"),
      /API Key/
    );

    // 4. DashScope linked_provider resolves LLM provider key + Token Plan URL and rotates automatically
    const bailianLlm = providers.upsertProvider({
      name: "阿里云百炼 Token Plan",
      protocol: "openai-chat",
      baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKey: "sk-sp-initial-1111",
    });
    speechStorage.saveSpeechProvider({
      kind: "dashscope",
      enabled: true,
      credentialMode: "linked_provider",
      linkedProviderId: bailianLlm.id,
      dashscopeEndpointPreset: "token-plan-cn",
    });
    const resolved1 = speechStorage.resolveSpeechRuntimeConfig("dashscope");
    assert.equal(resolved1.apiKey, "sk-sp-initial-1111");
    assert.equal(
      resolved1.linkedProviderBaseUrl,
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    );

    providers.upsertProvider({
      id: bailianLlm.id,
      name: bailianLlm.name,
      protocol: bailianLlm.protocol,
      baseUrl: bailianLlm.baseUrl,
      apiKey: "sk-sp-rotated-2222",
    });
    const resolved2 = speechStorage.resolveSpeechRuntimeConfig("dashscope");
    assert.equal(resolved2.apiKey, "sk-sp-rotated-2222");

    // 5. Volcengine forces credentialMode = custom even if linked_provider is passed, and encrypts access token
    const volcSaved = speechStorage.saveSpeechProvider({
      kind: "volcengine",
      enabled: true,
      credentialMode: "linked_provider",
      linkedProviderId: bailianLlm.id,
      volcAuthMode: "app_token",
      volcAppId: "volc-app-1",
      volcAccessToken: "volc-tok-abcd",
    });
    assert.equal(volcSaved.credentialMode, "custom");
    assert.equal(volcSaved.linkedProviderId, undefined);
    assert.equal(volcSaved.hasVolcAccessToken, true);
    assert.match(volcSaved.volcAccessTokenPreview ?? "", /abcd/);
    const volcRuntime = speechStorage.resolveSpeechRuntimeConfig("volcengine");
    assert.equal(volcRuntime.volcAppId, "volc-app-1");
    assert.equal(volcRuntime.volcAccessToken, "volc-tok-abcd");

    // 6. Preferences round-trip + clamping
    const prefs = speechStorage.saveSpeechPreferences({
      activeAsrProvider: "dashscope",
      activeTtsProvider: "volcengine",
      asrAfterTranscribe: "send",
      ttsPlaybackRate: 9.9,
      ttsMaxChunkChars: 50,
    });
    assert.equal(prefs.activeAsrProvider, "dashscope");
    assert.equal(prefs.activeTtsProvider, "volcengine");
    assert.equal(prefs.asrAfterTranscribe, "send");
    assert.equal(prefs.ttsPlaybackRate, 2.0);
    assert.equal(prefs.ttsMaxChunkChars, 150);
  } finally {
    setDbForTest(null);
  }
});

test("speech service caches TTS audio and cancels in-flight requests cleanly", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  const speechStorage = await import("../dist-electron/speech/storage.js");
  const { createSpeechService } = await import("../dist-electron/speech/service.js");
  const { SpeechError } = await import("../dist-electron/shared/speechTypes.js");

  const db = new Database(":memory:");
  setDbForTest(db);
  migrate(db);

  try {
    speechStorage.saveSpeechProvider({
      kind: "deepseek",
      enabled: true,
      credentialMode: "custom",
      apiKey: "sk-ds-svc",
    });
    speechStorage.saveSpeechPreferences({
      activeAsrProvider: "deepseek",
      activeTtsProvider: "deepseek",
    });

    let fetchCount = 0;
    const svc = createSpeechService({
      fetchImpl: async (_url, init) => {
        fetchCount += 1;
        // Support cancellation test when signal aborts before resolving
        if (init?.signal && String(init.body || "").includes("slow-cancel")) {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
        }
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      },
    });

    const first = await svc.synthesizeSpeech({ text: "缓存测试文本" });
    assert.equal(first.cached, false);
    assert.equal(fetchCount, 1);

    const second = await svc.synthesizeSpeech({ text: "缓存测试文本" });
    assert.equal(second.cached, true);
    assert.equal(fetchCount, 1);

    // Cancel in-flight request
    const pending = svc.synthesizeSpeech({
      requestId: "req-cancel-1",
      text: "slow-cancel",
      skipCache: true,
    });
    assert.equal(svc.cancelSpeechRequest("req-cancel-1"), true);
    await assert.rejects(
      () => pending,
      (err) => err instanceof SpeechError && err.code === "CANCELLED"
    );
  } finally {
    setDbForTest(null);
  }
});
