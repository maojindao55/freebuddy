// Local-only visual fixture: /tests/fixtures/provider-management-preview.html.
// Production UI, realistic sample data, and memory-only mutations. No native API calls.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Moon, RotateCcw, Sun } from "lucide-react";
import i18next from "../../src/i18n";
import "../../styles.css";
import { ProvidersTab } from "../../src/components/Settings/ProvidersTab";
import { useProviderStore } from "../../src/store/providerStore";
import { providersClient } from "../../src/services/providers/client";
import {
  defaultEnvKeyForProtocol,
  type Provider,
  type ProviderInput,
  type ProviderModel,
  type ProviderTestResult,
  type TestProviderOptions,
} from "../../src/services/providers/types";
import {
  inferContextWindow,
  inferModelCapabilities,
  inferModelGroup,
} from "../../src/services/providers/modelUtils";

void i18next.changeLanguage("zh-CN");

const initialTheme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = initialTheme;

const modelIds = [
  "deepseek-v4.1-flash",
  "deepseek-v4-flash-0731",
  "doubao-seedance-2-0-260128",
  "doubao-seedream-5-0-260128",
  "doubao-seed-1-8-251228",
  "doubao-1-5-pro-32k-250115",
  "glm-5",
  "glm-4.7-flash",
  "glm-4.6v",
  "kimi-k2.5",
  "kimi-k2-thinking",
  "moonshot-v1-128k",
  "qwen3.5-plus",
  "qwen3.5-397b-a17b",
  "qwen3-coder-plus",
  "qwen3-coder-480b-a35b-instruct",
  "qwen3-max-2026-01-23",
  "qwen3-vl-235b-a22b-instruct",
  "qwen3-embedding-8b",
  "SenseChat-5.5",
  "SenseChat-Turbo",
  "SenseChat-Long-200K",
  "SenseChat-5-Cantonese",
  "SenseChat-5-Finance",
  "sensenova-6.8-flash-lite",
  "sensenova-6.7-flash-lite",
  "senseaudio-tts-v1",
  "senseaudio-asr-v1",
  "senseaudio-realtime-v1",
  "MiniMax-M2.5",
  "MiniMax-Text-01",
  "step-3.5-flash",
  "step-3.5-flash-extended-context-preview",
];
const enabledIds = new Set(["deepseek-v4.1-flash", "kimi-k2.5", "qwen3.5-plus", "SenseChat-5.5"]);
const sampleModels = (): ProviderModel[] => modelIds.map(id => {
  const capabilities = inferModelCapabilities(id);
  return {
    id,
    supportsTools: capabilities.tools,
    supportsReasoning: capabilities.reasoning,
    supportsVision: capabilities.vision,
    group: inferModelGroup(id),
    contextWindow: inferContextWindow(id),
    enabled: enabledIds.has(id),
  };
});
const checkedAt = new Date().toISOString();
const seedProviders = (): Provider[] => [
  {
    id: "provider-senseaudio-sample",
    name: "商汤 SenseAudio",
    protocol: "openai-chat",
    protocols: ["openai-chat", "deepseek"],
    baseUrl: "https://api.senseaudio.cn/v1",
    envKey: "OPENAI_API_KEY",
    enabled: true,
    position: 0,
    hasKey: true,
    apiKeyPreview: "••••••••C3Ab",
    models: sampleModels(),
    lastHealth: "ok",
    lastLatencyMs: 57,
    lastCheckedAt: checkedAt,
  },
  {
    id: "provider-sensenova-sample",
    presetId: "sensenova",
    name: "商汤日日新 SenseNova",
    protocol: "openai-chat",
    protocols: ["openai-chat", "openai-responses", "anthropic", "deepseek"],
    baseUrl: "https://token.sensenova.cn/v1",
    envKey: "OPENAI_API_KEY",
    enabled: true,
    position: 1,
    hasKey: true,
    apiKeyPreview: "••••••••Q7Lx",
    models: sampleModels().slice(19, 30).map((model, index) => ({ ...model, enabled: index < 3 })),
    lastHealth: "ok",
    lastLatencyMs: 83,
    lastCheckedAt: checkedAt,
  },
  {
    id: "provider-freebuddy-sample",
    name: "FreeBuddy 体验服务",
    protocol: "openai-chat",
    protocols: ["openai-chat"],
    baseUrl: "https://preview.example.com/v1",
    envKey: "OPENAI_API_KEY",
    enabled: true,
    position: 2,
    hasKey: false,
    models: sampleModels().slice(0, 2).map(model => ({ ...model, enabled: true })),
    lastHealth: "unknown",
  },
];

const copyProvider = (provider: Provider): Provider => ({
  ...provider,
  protocols: provider.protocols ? [...provider.protocols] : undefined,
  models: provider.models.map(model => ({ ...model })),
});
const currentProviders = () => useProviderStore.getState().providers;
const refresh = async () => useProviderStore.setState({ loaded: true, loading: false, error: undefined });
let nextProviderId = 1;

const upsert = async ({ apiKey, ...input }: ProviderInput & { apiKey?: string }): Promise<Provider> => {
  const previous = currentProviders().find(provider => provider.id === input.id);
  const provider: Provider = {
    ...previous,
    ...input,
    id: input.id ?? `provider-preview-${nextProviderId++}`,
    envKey: input.envKey ?? defaultEnvKeyForProtocol(input.protocol),
    enabled: input.enabled ?? previous?.enabled ?? true,
    position: input.position ?? previous?.position ?? currentProviders().length,
    models: (input.models ?? previous?.models ?? []).map(model => ({ ...model })),
    hasKey: Boolean(apiKey?.trim()) || previous?.hasKey || false,
    // Never retain even the user-entered preview key. Copy returns a fixed dummy below.
    apiKeyPreview: apiKey?.trim() ? "••••••••DEMO" : previous?.apiKeyPreview,
    updatedAt: new Date().toISOString(),
  };
  useProviderStore.setState(state => ({
    providers: previous
      ? state.providers.map(item => item.id === provider.id ? provider : item)
      : [...state.providers, provider],
  }));
  return copyProvider(provider);
};
const remove = async (id: string) => {
  useProviderStore.setState(state => ({ providers: state.providers.filter(provider => provider.id !== id) }));
};
const setEnabled = async (id: string, enabled: boolean): Promise<Provider> => {
  const previous = currentProviders().find(provider => provider.id === id);
  if (!previous) throw new Error("Preview provider not found");
  return upsert({ ...previous, enabled });
};
const reorder = async (ids: string[]): Promise<Provider[]> => {
  useProviderStore.setState(state => ({ providers: state.providers.map(provider => ({
    ...provider,
    position: ids.includes(provider.id) ? ids.indexOf(provider.id) : provider.position,
  })) }));
  return currentProviders().map(copyProvider);
};
const test = async (target: string | TestProviderOptions): Promise<ProviderTestResult> => {
  await new Promise(resolve => setTimeout(resolve, 300));
  const id = typeof target === "string" ? target : target.id;
  const provider = currentProviders().find(item => item.id === id);
  const hasKey = provider?.hasKey || (typeof target !== "string" && Boolean(target.apiKey?.trim()));
  return {
    ok: Boolean(hasKey),
    latencyMs: provider?.lastLatencyMs ?? 57,
    checkedAt: new Date().toISOString(),
    models: hasKey ? [...modelIds] : undefined,
    error: hasKey ? undefined : "未配置 API Key。此预览仅使用本地示例数据。",
  };
};

// Cover every bridge entry used by provider management, including test/fetch and key copy.
Object.assign(providersClient, {
  isAvailable: () => true,
  list: async () => currentProviders().map(copyProvider),
  upsert,
  remove,
  setEnabled,
  reorder,
  test,
  getApiKey: async (id: string) => currentProviders().find(provider => provider.id === id)?.hasKey
    ? "sk-preview-only-not-a-real-api-key"
    : undefined,
});
useProviderStore.setState({
  providers: seedProviders(),
  loaded: true,
  loading: false,
  error: undefined,
  load: refresh,
  refresh,
  upsert,
  remove,
  setEnabled: async (id, enabled) => { await setEnabled(id, enabled); },
  reorder: async ids => { await reorder(ids); },
  test: async id => {
    const result = await test(id);
    useProviderStore.getState().applyHealth(id, result);
    return result;
  },
});

function Preview() {
  const [theme, setTheme] = useState(initialTheme);
  const [revision, setRevision] = useState(0);
  return <main className="provider-fixture-shell" data-theme={theme}>
    <style>{`
      .provider-fixture-shell { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; overflow: hidden; background: var(--fb-panel-bg); }
      .provider-fixture-titlebar { display: flex; align-items: center; flex: 0 0 44px; gap: 12px; padding: 0 20px; border-bottom: 1px solid var(--fb-border-strong); }
      .provider-fixture-titlebar h1 { margin: 0; color: var(--fb-text-primary); font-size: 14px; font-weight: 600; }
      .provider-fixture-note { margin-left: auto; color: var(--fb-text-secondary); font-size: 11px; }
      .provider-fixture-titlebar button { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 5px; color: var(--fb-text-secondary); background: transparent; cursor: pointer; }
      .provider-fixture-titlebar button:hover { background: var(--fb-hover); }
    `}</style>
    <header className="provider-fixture-titlebar">
      <h1>设置</h1>
      <span className="provider-fixture-note">本地示例 · 3 个服务商</span>
      <button type="button" title="重置示例" aria-label="重置示例" onClick={() => {
        useProviderStore.setState({ providers: seedProviders(), error: undefined });
        setRevision(value => value + 1);
      }}><RotateCcw size={13} /></button>
      <button type="button" title="切换主题" aria-label="切换主题" onClick={() => {
        const next = theme === "light" ? "dark" : "light";
        document.documentElement.dataset.theme = next;
        setTheme(next);
      }}>{theme === "light" ? <Moon size={13} /> : <Sun size={13} />}</button>
    </header>
    <section className="settings-surface settings-surface-page">
      <div className="settings-layout settings-layout-content-only">
        <div className="settings-panel settings-panel-full"><ProvidersTab key={revision} /></div>
      </div>
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
