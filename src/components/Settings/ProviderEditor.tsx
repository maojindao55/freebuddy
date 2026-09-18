import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useProviderStore } from "@/store/providerStore";
import { providersClient } from "@/services/providers/client";
import { cliClient } from "@/services/cli/client";
import { copyToClipboard } from "@/utils/clipboard";
import { FREEBIE_BUNDLED_PROVIDERS } from "@/config/freebie";
import type { Provider, ProviderProtocol } from "@/services/providers/types";
import {
  defaultEnvKeyForProtocol,
  protocolsOf,
} from "@/services/providers/types";

const PROTOCOLS: ProviderProtocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "deepseek",
];

const PROTOCOL_CONFIG: Record<
  ProviderProtocol,
  { label: string; desc: string; defaultUrl: string; presets: string[] }
> = {
  "openai-chat": {
    label: "OpenAI 兼容",
    desc: "Chat Completions 兼容协议",
    defaultUrl: "https://api.openai.com/v1",
    presets: ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini", "claude-3-7-sonnet"],
  },
  "openai-responses": {
    label: "OpenAI Responses",
    desc: "OpenAI 新版 Responses API",
    defaultUrl: "https://api.openai.com/v1",
    presets: ["gpt-4o", "o1", "o3-mini"],
  },
  anthropic: {
    label: "Anthropic Claude",
    desc: "Claude Messages API 协议",
    defaultUrl: "https://api.anthropic.com/v1",
    presets: [
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
  },
  deepseek: {
    label: "DeepSeek",
    desc: "DeepSeek 原生协议及推理模型",
    defaultUrl: "https://api.deepseek.com",
    presets: ["deepseek-chat", "deepseek-reasoner"],
  },
};

function detectConsoleUrl(baseUrl: string, presetId?: string): string | undefined {
  if (presetId) {
    const p = FREEBIE_BUNDLED_PROVIDERS.find((x) => x.id === presetId);
    if (p?.consoleUrl) return p.consoleUrl;
  }
  const clean = baseUrl.trim().toLowerCase().replace(/\/+$/, "");
  if (!clean) return undefined;
  const matched = FREEBIE_BUNDLED_PROVIDERS.find(
    (x) => x.baseUrl.toLowerCase().replace(/\/+$/, "") === clean,
  );
  if (matched?.consoleUrl) return matched.consoleUrl;

  if (clean.includes("api.openai.com")) return "https://platform.openai.com/api-keys";
  if (clean.includes("anthropic.com")) return "https://console.anthropic.com/settings/keys";
  if (clean.includes("deepseek.com")) return "https://platform.deepseek.com/api_keys";
  if (clean.includes("siliconflow.cn")) return "https://cloud.siliconflow.cn/account/ak";
  if (clean.includes("openrouter.ai")) return "https://openrouter.ai/keys";
  if (clean.includes("moonshot.cn")) return "https://platform.moonshot.cn/console/api-keys";
  if (clean.includes("bigmodel.cn")) return "https://bigmodel.cn/usercenter/apikeys";
  if (clean.includes("dashscope.aliyuncs.com")) return "https://dashscope.console.aliyun.com/apiKey";
  if (clean.includes("groq.com")) return "https://console.groq.com/keys";
  if (clean.includes("mistral.ai")) return "https://console.mistral.ai/api-keys";
  return undefined;
}

export function ProviderEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Provider;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const upsert = useProviderStore((s) => s.upsert);

  const [name, setName] = useState(initial?.name ?? "");
  const [selectedProtocols, setSelectedProtocols] = useState<ProviderProtocol[]>(() => {
    const p = protocolsOf(initial ?? { protocol: "openai-chat" });
    return p.length ? p : ["openai-chat"];
  });

  const toggleProtocol = (p: ProviderProtocol) => {
    setSelectedProtocols((prev) => {
      if (prev.includes(p)) {
        if (prev.length <= 1) return prev; // keep at least 1
        return prev.filter((x) => x !== p);
      }
      return [...prev, p];
    });
  };

  const primaryProtocol = selectedProtocols[0] || "openai-chat";

  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [envKey, setEnvKey] = useState(initial?.envKey ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  const handleToggleShowKey = async () => {
    if (!showApiKey) {
      if (!apiKey && initial?.id && initial?.hasKey) {
        try {
          const fetched = await providersClient.getApiKey(initial.id);
          if (fetched) setApiKey(fetched);
        } catch { /* ignore */ }
      }
      setShowApiKey(true);
    } else {
      setShowApiKey(false);
    }
  };

  const handleCopyKey = async () => {
    let text = apiKey.trim();
    if (!text && initial?.id && initial?.hasKey) {
      try {
        const fetched = await providersClient.getApiKey(initial.id);
        if (fetched) text = fetched;
      } catch { /* ignore */ }
    }
    if (text) {
      await copyToClipboard(text);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  };

  // Models state
  const [modelList, setModelList] = useState<string[]>(() =>
    (initial?.models ?? []).map((m) => m.id).filter(Boolean),
  );
  const [newModelId, setNewModelId] = useState("");
  const [isTextMode, setIsTextMode] = useState(false);
  const [rawTextModels, setRawTextModels] = useState("");

  // Testing & fetching
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs?: number;
    error?: string;
    count?: number;
  } | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelMessage, setModelMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const envPlaceholder = useMemo(
    () => defaultEnvKeyForProtocol(primaryProtocol),
    [primaryProtocol],
  );

  const availablePresets = useMemo(() => {
    const list: string[] = [];
    for (const p of selectedProtocols) {
      for (const m of PROTOCOL_CONFIG[p]?.presets ?? []) {
        if (!list.includes(m)) list.push(m);
      }
    }
    return list;
  }, [selectedProtocols]);

  const consoleUrl = useMemo(
    () => detectConsoleUrl(baseUrl, initial?.presetId),
    [baseUrl, initial?.presetId],
  );

  const hasKey = apiKey.trim().length > 0 || Boolean(initial?.hasKey);

  const testConnection = useCallback(async () => {
    if (!baseUrl.trim()) {
      setTestResult({
        ok: false,
        error: t("providers.baseUrl") + " " + t("providers.noKey"),
      });
      return null;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await providersClient.test({
        id: initial?.id,
        baseUrl: baseUrl.trim(),
        protocol: primaryProtocol,
        apiKey: apiKey.trim() || undefined,
      });
      setTestResult({
        ok: res.ok,
        latencyMs: res.latencyMs,
        error: res.error,
        count: res.models?.length,
      });
      return res;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setTestResult({ ok: false, error: err });
      return null;
    } finally {
      setTesting(false);
    }
  }, [baseUrl, primaryProtocol, apiKey, initial?.id, t]);

  const onFetchModels = useCallback(async () => {
    setFetchingModels(true);
    setModelMessage(null);
    try {
      const res = await testConnection();
      if (!res) return;
      if (!res.ok) {
        setModelMessage({
          type: "error",
          text: t("providers.fetchFailed", { error: res.error || "Network error" }),
        });
        return;
      }
      if (!res.models || res.models.length === 0) {
        setModelMessage({ type: "error", text: t("providers.noModelsFound") });
        return;
      }
      const newModels = res.models;
      setModelList((prev) => {
        const set = new Set(prev);
        for (const m of newModels) {
          set.add(m);
        }
        return Array.from(set);
      });
      setModelMessage({
        type: "success",
        text: t("providers.fetchSuccess", { count: newModels.length }),
      });
    } catch (e) {
      setModelMessage({
        type: "error",
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setFetchingModels(false);
    }
  }, [testConnection, t]);

  const addModel = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) return;
    if (!modelList.includes(trimmed)) {
      setModelList((prev) => [...prev, trimmed]);
    }
    setNewModelId("");
  };

  const removeModel = (id: string) => {
    setModelList((prev) => prev.filter((m) => m !== id));
  };

  const toggleTextMode = () => {
    if (!isTextMode) {
      setRawTextModels(modelList.join("\n"));
      setIsTextMode(true);
    } else {
      const parsed = rawTextModels
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      setModelList(Array.from(new Set(parsed)));
      setIsTextMode(false);
    }
  };

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      const finalModels = isTextMode
        ? rawTextModels
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        : modelList;

      await upsert({
        id: initial?.id,
        presetId: initial?.presetId,
        name: name.trim(),
        protocol: primaryProtocol,
        protocols: selectedProtocols,
        baseUrl: baseUrl.trim(),
        envKey: envKey.trim() || envPlaceholder,
        apiKey: apiKey.trim() || undefined,
        models: finalModels.map((id) => ({ id })),
        wireApi: selectedProtocols.includes("openai-responses") ? "responses" : "chat",
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal provider-editor-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{initial ? t("providers.edit") : t("providers.add")}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <X size={17} />
          </button>
        </div>

        <div className="modal-body provider-editor">
          {/* 1. Name */}
          <label className="provider-form-label">
            <span>{t("providers.name")}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：OpenAI / 硅基流动 / 个人中转站"
            />
          </label>

          {/* 2. Supported Protocols (Unified Multi-select Cards) */}
          <div className="provider-form-group">
            <div className="provider-form-group-header">
              <span className="provider-form-group-title">
                {t("providers.supportedProtocols")}
              </span>
              <span className="provider-form-group-hint">
                {t("providers.supportedProtocolsHint")}
              </span>
            </div>
            <div className="provider-protocol-grid">
              {PROTOCOLS.map((p) => {
                const active = selectedProtocols.includes(p);
                const cfg = PROTOCOL_CONFIG[p];
                return (
                  <button
                    key={p}
                    type="button"
                    className={`provider-protocol-card ${active ? "active" : ""}`}
                    onClick={() => {
                      toggleProtocol(p);
                      if (!baseUrl && !active) {
                        setBaseUrl(cfg.defaultUrl);
                      }
                    }}
                  >
                    <div className="protocol-card-head">
                      <strong>{cfg.label}</strong>
                      <div className={`protocol-checkbox ${active ? "checked" : ""}`}>
                        {active ? <Check size={12} /> : null}
                      </div>
                    </div>
                    <span className="protocol-card-desc">{cfg.desc}</span>
                    <code className="protocol-card-id">{p}</code>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 4. Base URL */}
          <label className="provider-form-label">
            <span>{t("providers.baseUrl")}</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://..."
            />
          </label>

          {/* 5. API Key & Console link */}
          <div className="provider-form-group">
            <label className="provider-form-label">
              <span>{t("providers.apiKey")}</span>
              <div className="provider-key-input-wrapper">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    initial?.apiKeyPreview
                      ? t("providers.savedKeyHint", {
                          preview: initial.apiKeyPreview,
                        })
                      : "sk-..."
                  }
                />
                <div className="provider-key-actions-inner">
                  {hasKey ? (
                    <button
                      type="button"
                      className={`provider-eye-btn ${copiedKey ? "copied" : ""}`}
                      title={copiedKey ? t("providers.keyCopied") : t("providers.copyKey")}
                      onClick={() => void handleCopyKey()}
                    >
                      {copiedKey ? <Check size={14} className="copied-icon" /> : <Copy size={14} />}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="provider-eye-btn"
                    title={showApiKey ? t("providers.hideKey") : t("providers.showKey")}
                    onClick={() => void handleToggleShowKey()}
                  >
                    {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
            </label>

            <div className="provider-key-foot">
              {initial?.apiKeyPreview ? (
                <span className="provider-key-hint">
                  {t("providers.savedKeyHint", {
                    preview: initial.apiKeyPreview,
                  })}
                </span>
              ) : null}
              {consoleUrl ? (
                <button
                  type="button"
                  className="provider-link-btn"
                  onClick={() => void cliClient.openBrowserExternal(consoleUrl)}
                >
                  {t("providers.getKey")}
                  <ExternalLink size={12} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>

          {/* 6. Test & Fetch Bar */}
          <div className="provider-test-bar">
            <div className="provider-test-actions">
              <button
                type="button"
                className="provider-secondary-btn"
                disabled={testing || !baseUrl.trim() || (!apiKey.trim() && !initial?.hasKey)}
                onClick={() => void testConnection()}
              >
                <RefreshCw
                  size={14}
                  className={testing ? "spinning" : ""}
                  aria-hidden="true"
                />
                {testing ? t("providers.testing") : t("providers.testConnection")}
              </button>
              <button
                type="button"
                className="provider-secondary-btn"
                disabled={fetchingModels || !baseUrl.trim() || (!apiKey.trim() && !initial?.hasKey)}
                onClick={() => void onFetchModels()}
              >
                <Download
                  size={14}
                  className={fetchingModels ? "spinning" : ""}
                  aria-hidden="true"
                />
                {fetchingModels
                  ? t("providers.fetchingModels")
                  : t("providers.fetchModels")}
              </button>
            </div>

            {testResult ? (
              <div
                className={`provider-test-pill ${testResult.ok ? "ok" : "error"}`}
              >
                {testResult.ok ? (
                  <>
                    <CheckCircle2 size={14} />
                    <span>{t("providers.testSuccess", { latency: testResult.latencyMs ?? 0 })}</span>
                    {testResult.count ? (
                      <span className="provider-test-pill-extra">
                        ({t("providers.modelsCount", { count: testResult.count })})
                      </span>
                    ) : null}
                  </>
                ) : (
                  <>
                    <AlertTriangle size={14} />
                    <span>{t("providers.testFailed", { error: testResult.error || "Failed" })}</span>
                  </>
                )}
              </div>
            ) : null}
          </div>

          {modelMessage ? (
            <div
              className={`provider-model-message ${modelMessage.type === "success" ? "ok" : "error"}`}
            >
              {modelMessage.type === "success" ? (
                <CheckCircle2 size={14} />
              ) : (
                <AlertTriangle size={14} />
              )}
              <span>{modelMessage.text}</span>
            </div>
          ) : null}

          {/* 7. Model Management (Tags / Text mode) */}
          <div className="provider-models-panel">
            <div className="provider-models-panel-header">
              <div className="provider-models-count">
                <strong>
                  {t("providers.configuredCount", {
                    count: isTextMode
                      ? rawTextModels.split("\n").filter((s) => s.trim()).length
                      : modelList.length,
                  })}
                </strong>
              </div>
              <div className="provider-models-header-actions">
                {modelList.length > 0 && !isTextMode ? (
                  <button
                    type="button"
                    className="provider-text-btn danger"
                    onClick={() => setModelList([])}
                  >
                    <Trash2 size={12} />
                    {t("providers.clearModels")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="provider-text-btn"
                  onClick={toggleTextMode}
                >
                  {isTextMode ? t("providers.tagMode") : t("providers.batchEdit")}
                </button>
              </div>
            </div>

            {isTextMode ? (
              <textarea
                value={rawTextModels}
                onChange={(e) => setRawTextModels(e.target.value)}
                rows={5}
                className="provider-models-textarea"
                placeholder="gpt-4o&#10;claude-3-7-sonnet&#10;deepseek-chat"
              />
            ) : (
              <div className="provider-models-tags-container">
                {/* Quick Add row */}
                <div className="provider-model-input-row">
                  <input
                    value={newModelId}
                    onChange={(e) => setNewModelId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addModel(newModelId);
                      }
                    }}
                    placeholder={t("providers.addModelPlaceholder")}
                  />
                  <button
                    type="button"
                    className="provider-secondary-btn"
                    disabled={!newModelId.trim()}
                    onClick={() => addModel(newModelId)}
                  >
                    <Plus size={14} />
                    {t("providers.addModel")}
                  </button>
                </div>

                {/* Quick Presets */}
                {availablePresets.length ? (
                  <div className="provider-presets-row">
                    <span className="provider-presets-title">
                      {t("providers.quickAddPresets")}:
                    </span>
                    <div className="provider-presets-chips">
                      {availablePresets.map((preset) => {
                        const exists = modelList.includes(preset);
                        return (
                          <button
                            key={preset}
                            type="button"
                            className={`provider-preset-chip ${exists ? "exists" : ""}`}
                            disabled={exists}
                            onClick={() => addModel(preset)}
                          >
                            <span>{exists ? "✓" : "+"}</span>
                            <span>{preset}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {/* Tags List */}
                {modelList.length > 0 ? (
                  <div className="provider-model-tags-list">
                    {modelList.map((m) => (
                      <span key={m} className="provider-model-tag">
                        <code>{m}</code>
                        <button
                          type="button"
                          className="provider-model-tag-del"
                          onClick={() => removeModel(m)}
                          aria-label="Remove"
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="provider-models-empty-hint">
                    {t("providers.noModelsFound")}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 8. Env Key (Advanced) */}
          <label className="provider-form-label">
            <span>{t("providers.envKey")}</span>
            <input
              value={envKey}
              onChange={(e) => setEnvKey(e.target.value)}
              placeholder={envPlaceholder}
            />
          </label>

          {error ? <div className="providers-error">{error}</div> : null}

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={saving || !name.trim() || !baseUrl.trim()}
              onClick={() => void submit()}
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

