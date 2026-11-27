import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

function readRepoFile(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), "utf8");
}

async function importTranspiledTs(relPath) {
  const source = readRepoFile(relPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
  );
}

test("wavEncoder encodes valid 16-bit mono PCM WAV, downsamples, and computes RMS", async () => {
  const wavMod = await importTranspiledTs("../src/services/speech/wavEncoder.ts");

  assert.equal(wavMod.computeRmsLevel(new Float32Array([0, 0, 0, 0])), 0);
  const rmsOne = wavMod.computeRmsLevel(new Float32Array([1, -1, 1, -1]));
  assert.ok(Math.abs(rmsOne - 1) < 1e-6);

  // 48kHz -> 16kHz downsampling (3:1)
  const source = new Float32Array(480);
  for (let i = 0; i < source.length; i += 1) {
    source[i] = i % 3 === 0 ? 0.6 : 0.3;
  }
  const downsampled = wavMod.downsampleFloat32(source, 48000, 16000);
  assert.equal(downsampled.length, 160);
  assert.ok(Math.abs(downsampled[0] - 0.4) < 1e-5);

  const wav = wavMod.encodePcm16Wav(downsampled, 16000);
  assert.equal(wav.byteLength, 44 + 160 * 2);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(Buffer.from(wav.slice(0, 4)).toString("ascii"), "RIFF");
  assert.equal(Buffer.from(wav.slice(8, 12)).toString("ascii"), "WAVE");
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16); // 16-bit
  assert.equal(view.getUint32(40, true), 160 * 2);
});

test("speechText strips code blocks & markdown, chunks long text, and builds silent WAV", async () => {
  const textMod = await import("../dist-electron/shared/speechText.js");

  const input = [
    "# 标题 Summary",
    "",
    "请看 [官方文档](https://example.com/docs) 和 `inlineCode`。",
    "",
    "```ts",
    "const secret = 123;",
    "console.log(secret);",
    "```",
    "",
    "- **重点**：访问 https://example.com/abc 查看详情！",
  ].join("\n");

  const cleaned = textMod.cleanTextForSpeech(input, {
    stripCodeBlocks: true,
    stripMarkdown: true,
  });
  assert.doesNotMatch(cleaned, /console\.log/);
  assert.doesNotMatch(cleaned, /https?:\/\//);
  assert.doesNotMatch(cleaned, /\*\*/);
  assert.match(cleaned, /标题 Summary/);
  assert.match(cleaned, /官方文档/);
  assert.match(cleaned, /inlineCode/);
  assert.match(cleaned, /重点：访问 查看详情！/);

  const chunks = textMod.chunkTextForSpeech(
    [
      "第一句话比较简短，适合合并到同一个分段里。",
      "第二句话稍微长一点，用于验证多句累加时的长度边界！",
      "第三句故意写得非常非常长，里面包含若干逗号分隔的子句，比如第一个子句用于测试逗号切分位置，第二个子句继续拉长整体文本确保超过单段六十个字符的限制，然后再追加一段足够长的尾部文本。",
    ].join(""),
    60
  );
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 60, `chunk exceeded limit: ${chunk}`);
  }

  const silent = textMod.buildSilentWav(500, 16000);
  assert.equal(silent.byteLength, 44 + 8000 * 2);
  assert.equal(Buffer.from(silent.slice(0, 4)).toString("ascii"), "RIFF");
});

test("speechCatalog resolves DashScope PAYG / Token Plan origins and detects key mismatch", async () => {
  const catalog = await import("../dist-electron/shared/speechCatalog.js");

  assert.equal(
    catalog.resolveDashScopeOrigin({ preset: "payg-cn" }),
    "https://dashscope.aliyuncs.com"
  );
  assert.equal(
    catalog.resolveDashScopeOrigin({ preset: "token-plan-cn" }),
    "https://token-plan.cn-beijing.maas.aliyuncs.com"
  );
  assert.equal(
    catalog.resolveDashScopeOrigin({ preset: "token-plan-intl" }),
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com"
  );
  assert.equal(
    catalog.resolveDashScopeOrigin({
      preset: "custom",
      customBaseUrl: "https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
    }),
    "https://ws-123.cn-beijing.maas.aliyuncs.com"
  );
  assert.equal(
    catalog.resolveDashScopeOrigin({
      linkedProviderBaseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    }),
    "https://token-plan.cn-beijing.maas.aliyuncs.com"
  );

  assert.equal(
    catalog.detectDashScopeKeyEndpointMismatch("sk-sp-abc123", "https://dashscope.aliyuncs.com"),
    "token_plan_key_on_payg"
  );
  assert.equal(
    catalog.detectDashScopeKeyEndpointMismatch(
      "sk-regular-123",
      "https://token-plan.cn-beijing.maas.aliyuncs.com"
    ),
    "payg_key_on_token_plan"
  );
  assert.equal(
    catalog.detectDashScopeKeyEndpointMismatch(
      "sk-sp-abc123",
      "https://token-plan.cn-beijing.maas.aliyuncs.com"
    ),
    null
  );
});

test("deepseek adapter handles multipart ASR, size guard, binary TTS, and error mapping", async () => {
  const { deepseekSpeechAdapter } = await import(
    "../dist-electron/speech/providers/deepseek.js"
  );
  const { SpeechError } = await import("../dist-electron/shared/speechTypes.js");

  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v1/tools/asr")) {
      return new Response(JSON.stringify({ text: "你好世界", duration_ms: 1400 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  };

  const baseConfig = {
    kind: "deepseek",
    credentialMode: "custom",
    apiKey: "sk-ds-test",
    baseUrl: "https://api.deepseek.com/v1",
    volcAuthMode: "app_token",
    ttsVoice: "tide",
  };

  const asrRes = await deepseekSpeechAdapter.transcribe({
    config: baseConfig,
    audio: new Uint8Array([1, 2, 3, 4]),
    mimeType: "audio/wav",
    signal: new AbortController().signal,
    fetchImpl: mockFetch,
  });
  assert.equal(asrRes.text, "你好世界");
  assert.equal(asrRes.durationMs, 1400);
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/asr");
  assert.ok(calls[0].init.body instanceof FormData);

  const ttsRes = await deepseekSpeechAdapter.synthesize({
    config: baseConfig,
    text: "测试语音",
    stripMarkdown: true,
    signal: new AbortController().signal,
    fetchImpl: mockFetch,
  });
  assert.equal(calls[1].url, "https://api.deepseek.com/v1/tools/tts");
  const ttsBody = JSON.parse(calls[1].init.body);
  assert.equal(ttsBody.voice_id, "tide");
  assert.equal(ttsBody.filter_markdown, true);
  assert.equal(ttsRes.mimeType, "audio/wav");
  assert.equal(ttsRes.audio.byteLength, 7);

  // Over 8 MiB guard
  await assert.rejects(
    () =>
      deepseekSpeechAdapter.transcribe({
        config: baseConfig,
        audio: new Uint8Array(8 * 1024 * 1024 + 1),
        mimeType: "audio/wav",
        signal: new AbortController().signal,
        fetchImpl: mockFetch,
      }),
    (err) => err instanceof SpeechError && err.code === "AUDIO_TOO_LARGE"
  );

  // 401 maps to UNAUTHORIZED
  await assert.rejects(
    () =>
      deepseekSpeechAdapter.synthesize({
        config: baseConfig,
        text: "hi",
        signal: new AbortController().signal,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
      }),
    (err) => err instanceof SpeechError && err.code === "UNAUTHORIZED"
  );
});

test("dashscope adapter routes Token Plan, qwen3-asr/tts-flash, qwen-audio SpeechSynthesizer, and mismatch hints", async () => {
  const { dashscopeSpeechAdapter } = await import(
    "../dist-electron/speech/providers/dashscope.js"
  );
  const { SpeechError } = await import("../dist-electron/shared/speechTypes.js");

  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://oss.example.com/audio.mp3")) {
      return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }
    if (String(url).includes("/services/audio/tts/SpeechSynthesizer")) {
      return new Response(
        JSON.stringify({
          output: { audio: { data: Buffer.from("WAVDATA").toString("base64") } },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    const parsed = JSON.parse(init.body);
    if (parsed.model === "qwen3-asr-flash") {
      return new Response(
        JSON.stringify({
          output: {
            choices: [{ message: { content: [{ text: "百炼语音识别结果" }] } }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        output: { audio: { url: "https://oss.example.com/audio.mp3?Expires=999" } },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const tokenPlanConfig = {
    kind: "dashscope",
    credentialMode: "custom",
    apiKey: "sk-sp-token-plan",
    dashscopeEndpointPreset: "token-plan-cn",
    volcAuthMode: "app_token",
    asrModel: "qwen3-asr-flash",
    ttsModel: "qwen3-tts-flash",
    ttsVoice: "Cherry",
  };

  const asr = await dashscopeSpeechAdapter.transcribe({
    config: tokenPlanConfig,
    audio: new Uint8Array([1, 2, 3]),
    mimeType: "audio/wav",
    signal: new AbortController().signal,
    fetchImpl: mockFetch,
  });
  assert.equal(asr.text, "百炼语音识别结果");
  assert.equal(
    calls[0].url,
    "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
  );
  const asrPayload = JSON.parse(calls[0].init.body);
  assert.ok(
    asrPayload.input.messages[1].content[0].audio.startsWith("data:audio/wav;base64,")
  );

  // qwen3-tts-flash -> multimodal-generation + secondary OSS download without Auth header
  const tts1 = await dashscopeSpeechAdapter.synthesize({
    config: tokenPlanConfig,
    text: "你好",
    signal: new AbortController().signal,
    fetchImpl: mockFetch,
  });
  assert.equal(tts1.mimeType, "audio/mpeg");
  assert.equal(tts1.audio.byteLength, 4);
  assert.equal(calls[2].init?.headers, undefined);

  // qwen-audio-3.0-tts-plus -> SpeechSynthesizer
  const tts2 = await dashscopeSpeechAdapter.synthesize({
    config: { ...tokenPlanConfig, ttsModel: "qwen-audio-3.0-tts-plus" },
    text: "你好",
    signal: new AbortController().signal,
    fetchImpl: mockFetch,
  });
  assert.equal(
    calls[3].url,
    "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"
  );
  assert.equal(Buffer.from(tts2.audio).toString("utf8"), "WAVDATA");

  // Key-endpoint mismatch hint on 401
  await assert.rejects(
    () =>
      dashscopeSpeechAdapter.synthesize({
        config: {
          ...tokenPlanConfig,
          dashscopeEndpointPreset: "payg-cn",
          apiKey: "sk-sp-token-plan",
        },
        text: "你好",
        signal: new AbortController().signal,
        fetchImpl: async () => new Response("Unauthorized", { status: 401 }),
      }),
    (err) =>
      err instanceof SpeechError &&
      err.code === "UNAUTHORIZED" &&
      /Token Plan/.test(err.message)
  );
});

test("volcengine adapter handles app_token & api_key headers, ASR status, and split NDJSON TTS chunks", async () => {
  const { volcengineSpeechAdapter } = await import(
    "../dist-electron/speech/providers/volcengine.js"
  );
  const { SpeechError } = await import("../dist-electron/shared/speechTypes.js");

  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/v3/auc/bigmodel/recognize/flash")) {
      return new Response(
        JSON.stringify({
          result: { text: "火山豆包识别文本" },
          audio_info: { duration: 2100 },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-api-status-code": "20000000",
          },
        }
      );
    }

    // Simulate TCP chunk boundaries splitting an NDJSON JSON line right in the middle
    const part1 = Buffer.from("part-one-");
    const part2 = Buffer.from("part-two");
    const lines = [
      JSON.stringify({ code: 0, data: part1.toString("base64") }),
      JSON.stringify({ code: 0, data: part2.toString("base64") }),
      JSON.stringify({ code: 20000000, message: "success" }),
    ].join("\n") + "\n";

    const mid = Math.floor(lines.length / 2);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(lines.slice(0, mid)));
        controller.enqueue(new TextEncoder().encode(lines.slice(mid)));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };

  const appTokenConfig = {
    kind: "volcengine",
    credentialMode: "custom",
    volcAuthMode: "app_token",
    volcAppId: "app-123",
    volcAccessToken: "tok-456",
    volcAsrResourceId: "volc.bigasr.auc_turbo",
    volcTtsResourceId: "seed-tts-2.0",
    ttsVoice: "zh_female_vv_uranus_bigtts",
  };

  const asr = await volcengineSpeechAdapter.transcribe({
    config: appTokenConfig,
    audio: new Uint8Array([9, 8, 7]),
    mimeType: "audio/wav",
    signal: new AbortController().signal,
    fetchImpl: mockFetch,
  });
  assert.equal(asr.text, "火山豆包识别文本");
  assert.equal(asr.durationMs, 2100);
  assert.equal(calls[0].init.headers["X-Api-App-Key"], "app-123");
  assert.equal(calls[0].init.headers["X-Api-Access-Key"], "tok-456");
  assert.equal(calls[0].init.headers["X-Api-Resource-Id"], "volc.bigasr.auc_turbo");

  const tts = await volcengineSpeechAdapter.synthesize({
    config: { ...appTokenConfig, volcAuthMode: "api_key", apiKey: "volc-api-key-789" },
    text: "你好火山",
    signal: new AbortController().signal,
    fetchImpl: mockFetch,
  });
  assert.equal(calls[1].init.headers["X-Api-Key"], "volc-api-key-789");
  assert.equal(calls[1].init.headers["X-Api-Resource-Id"], "seed-tts-2.0");
  assert.equal(Buffer.from(tts.audio).toString("utf8"), "part-one-part-two");

  // Volcengine custom error code inside NDJSON chunk throws SpeechError
  await assert.rejects(
    () =>
      volcengineSpeechAdapter.synthesize({
        config: appTokenConfig,
        text: "fail",
        signal: new AbortController().signal,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ code: 45000010, message: "invalid access token" }) + "\n",
            { status: 200 }
          ),
      }),
    (err) => err instanceof SpeechError && err.code === "UNAUTHORIZED"
  );
});

test("macOS entitlements, electron-builder Info.plist, and i18n speech keys stay in sync", () => {
  const plistMain = readRepoFile("../desktop/macos/entitlements.mac.plist");
  const plistInherit = readRepoFile("../desktop/macos/entitlements.mac.inherit.plist");
  const builderYml = readRepoFile("../electron-builder.yml");

  assert.match(plistMain, /com\.apple\.security\.device\.audio-input/);
  assert.match(plistInherit, /com\.apple\.security\.device\.audio-input/);
  assert.match(builderYml, /NSMicrophoneUsageDescription:/);

  const en = JSON.parse(readRepoFile("../src/locales/en.json"));
  const zh = JSON.parse(readRepoFile("../src/locales/zh-CN.json"));
  assert.equal(en.settings.tabs.speech, "Voice");
  assert.equal(zh.settings.tabs.speech, "语音");

  const collectKeys = (obj, prefix = "") =>
    Object.entries(obj).flatMap(([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? collectKeys(v, `${prefix}${k}.`)
        : [`${prefix}${k}`]
    );
  assert.deepEqual(
    collectKeys(en.speech).sort(),
    collectKeys(zh.speech).sort(),
    "en.json and zh-CN.json speech keys must match"
  );
});
