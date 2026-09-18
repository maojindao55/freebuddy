import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useProviderStore } from "@/store/providerStore";
import { providersClient } from "@/services/providers/client";
import { copyToClipboard } from "@/utils/clipboard";
import { FREEBIE_BUNDLED_PROVIDERS } from "@/config/freebie";
import type { Provider, ProviderModel, ProviderProtocol } from "@/services/providers/types";
import {
  defaultEnvKeyForProtocol,
  protocolsOf,
} from "@/services/providers/types";
import { ProviderModelManager } from "./ProviderModelManager";
import {
  inferContextWindow,
  inferModelCapabilities,
  inferModelGroup,
} from "@/services/providers/modelUtils";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { ProviderPresetPicker } from "./ProviderPresetPicker";

const PROTOCOLS: ProviderProtocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "deepseek",
];

const PROTOCOL_CONFIG: Record<
  ProviderProtocol,
  { labelKey: string; descKey: string; defaultUrl: string }
> = {
  "openai-chat": {
    labelKey: "providers.protoOpenAiChat",
    descKey: "providers.protoOpenAiChatDesc",
    defaultUrl: "https://api.openai.com/v1",
  },
  "openai-responses": {
    labelKey: "providers.protoOpenAiResponses",
    descKey: "providers.protoOpenAiResponsesDesc",
    defaultUrl: "https://api.openai.com/v1",
  },
  anthropic: {
    labelKey: "providers.protoAnthropic",
    descKey: "providers.protoAnthropicDesc",
    defaultUrl: "https://api.anthropic.com/v1",
  },
  deepseek: {
    labelKey: "providers.protoDeepSeek",
    descKey: "providers.protoDeepSeekDesc",
    defaultUrl: "https://api.deepseek.com",
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

/**
 * Normalise a model list to a canonical string so dirty-checking matches what
 * the backend actually persists (`parseModels` drops undefined optional fields
 * and JSON.stringify key order is stable). Comparing raw objects made the
 * auto-save loop forever because `undefined` fields came back stripped.
 */
function normalizeModels(list: ProviderModel[]): string {
  const norm = list
    .map((m) => ({
      id: m.id,
      name: m.name ?? "",
      contextWindow: m.contextWindow ?? 0,
      maxTokens: m.maxTokens ?? 0,
      supportsVision: m.supportsVision ?? false,
      supportsReasoning: m.supportsReasoning ?? false,
      supportsTools: m.supportsTools ?? false,
      group: m.group ?? "",
      enabled: m.enabled !== false,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(norm);
}

export interface ProviderEditorProps {
  initial?: Provider;
  /** Bundled preset to prefill the "new provider" form with. */
  presetId?: string;
  /** Switch the prefill preset while staying on the "new provider" form. */
  onPickPreset?: (presetId: string | null) => void;
  onSaved: (saved: Provider) => void;
  onDeleted?: (id: string) => void;
}

export function ProviderEditor({
  initial,
  presetId,
  onPickPreset,
  onSaved,
  onDeleted,
}: ProviderEditorProps) {
  const { t } = useTranslation();
  const upsert = useProviderStore((s) => s.upsert);
  const remove = useProviderStore((s) => s.remove);
  const applyHealth = useProviderStore((s) => s.applyHealth);

  const preset = useMemo(
    () => (initial || !presetId ? undefined : FREEBIE_BUNDLED_PROVIDERS.find((p) => p.id === presetId)),
    [initial, presetId],
  );

  const [name, setName] = useState(initial?.name ?? preset?.name ?? "");
  const [selectedProtocols, setSelectedProtocols] = useState<ProviderProtocol[]>(
    () => {
      if (initial?.protocols && initial.protocols.length > 0) {
        return initial.protocols;
      }
      if (initial?.protocol) {
        return [initial.protocol];
      }
      if (preset) {
        return preset.protocols?.length ? [...preset.protocols] : [preset.protocol];
      }
      return ["openai-chat"];
    },
  );

  const primaryProtocol = useMemo<ProviderProtocol>(() => {
    if (selectedProtocols.includes("openai-chat")) return "openai-chat";
    if (selectedProtocols.includes("openai-responses")) return "openai-responses";
    if (selectedProtocols.includes("anthropic")) return "anthropic";
    if (selectedProtocols.includes("deepseek")) return "deepseek";
    return selectedProtocols[0] ?? "openai-chat";
  }, [selectedProtocols]);

  const [baseUrl, setBaseUrl] = useState(
    initial?.baseUrl ?? preset?.baseUrl ?? PROTOCOL_CONFIG["openai-chat"].defaultUrl,
  );

  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [models, setModels] = useState<ProviderModel[]>(() => {
    if (initial) return initial.models;
    return (preset?.models ?? []).map((m) => {
      const caps = inferModelCapabilities(m.id);
      return {
        id: m.id,
        name: m.name,
        enabled: true,
        contextWindow: m.contextWindow ?? preset?.contextWindow ?? inferContextWindow(m.id),
        supportsTools: caps.tools,
        supportsReasoning: caps.reasoning,
        supportsVision: m.supportsVision ?? caps.vision,
        group: inferModelGroup(m.id),
      };
    });
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs?: number;
    error?: string;
    count?: number;
  } | null>(null);
  const [errorExpanded, setErrorExpanded] = useState(false);

  /** Last moment any change (connection or models) was persisted. */
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelMessage, setModelMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const envPlaceholder = useMemo(
    () => defaultEnvKeyForProtocol(primaryProtocol),
    [primaryProtocol],
  );

  const consoleUrl = useMemo(
    () => detectConsoleUrl(baseUrl, initial?.presetId ?? presetId),
    [baseUrl, initial?.presetId, presetId],
  );

  const keyPlaceholder = useMemo(() => {
    if (initial?.hasKey && initial?.apiKeyPreview) {
      return t("providers.savedKeyHint", { preview: initial.apiKeyPreview });
    }
    return t("providers.apiKey");
  }, [initial, t]);

  const onCopyKey = useCallback(async () => {
    if (apiKey.trim()) {
      await copyToClipboard(apiKey.trim());
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 1500);
      return;
    }
    if (initial?.id) {
      try {
        const fullKey = await providersClient.getApiKey(initial.id);
        if (fullKey) {
          await copyToClipboard(fullKey);
          setKeyCopied(true);
          setTimeout(() => setKeyCopied(false), 1500);
        }
      } catch {
        // ignore
      }
    }
  }, [apiKey, initial?.id]);

  const toggleProtocol = (proto: ProviderProtocol) => {
    setSelectedProtocols((prev) => {
      if (prev.includes(proto)) {
        if (prev.length <= 1) return prev;
        return prev.filter((p) => p !== proto);
      }
      return [...prev, proto];
    });
  };

  const testConnection = useCallback(async () => {
    if (!baseUrl.trim()) {
      setTestResult({
        ok: false,
        error: t("providers.baseUrl") + " " + t("providers.noKey"),
      });
      return null;
    }
    setTesting(true);
    setErrorExpanded(false);
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
      // Reflect the result on the sidebar health dot immediately, without a
      // full refresh that would clobber unsaved form state.
      if (initial?.id) {
        applyHealth(initial.id, {
          ok: res.ok,
          latencyMs: res.latencyMs,
          error: res.error,
          checkedAt: res.checkedAt,
        });
      }
      return res;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setTestResult({ ok: false, error: err });
      return null;
    } finally {
      setTesting(false);
    }
  }, [baseUrl, primaryProtocol, apiKey, initial?.id, applyHealth, t]);

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
      const fetchedModelIds = res.models;
      setModels((prev) => {
        const existingMap = new Map(prev.map((m) => [m.id, m]));
        const result: ProviderModel[] = [...prev];
        for (const id of fetchedModelIds) {
          if (!existingMap.has(id)) {
            const defaultCtx = inferContextWindow(id);
            const caps = inferModelCapabilities(id);
            result.push({
              id,
              contextWindow: defaultCtx,
              supportsTools: caps.tools,
              supportsReasoning: caps.reasoning,
              supportsVision: caps.vision,
              group: inferModelGroup(id),
              enabled: false,
            });
          }
        }
        return result;
      });
      setModelMessage({
        type: "success",
        text: t("providers.fetchSuccess", { count: fetchedModelIds.length }),
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setModelMessage({
        type: "error",
        text: t("providers.fetchFailed", { error: err }),
      });
    } finally {
      setFetchingModels(false);
    }
  }, [testConnection, t]);

  const handleDelete = async () => {
    if (!initial) return;
    if (!window.confirm(t("providers.deleteConfirm", { name: initial.name }))) return;
    try {
      await remove(initial.id);
      onDeleted?.(initial.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const connectionDirty = useMemo(() => {
    if (!initial) return true;
    if (name.trim() !== initial.name) return true;
    // Backend normalises baseUrl by stripping trailing slashes; compare the
    // same way so a saved value never shows as dirty again.
    if (baseUrl.trim().replace(/\/+$/, "") !== initial.baseUrl) return true;
    if (apiKey.trim() !== "") return true;
    const initProtos = initial.protocols?.length ? initial.protocols : [initial.protocol];
    if (
      initProtos.length !== selectedProtocols.length ||
      !initProtos.every((p) => selectedProtocols.includes(p))
    ) {
      return true;
    }
    return false;
  }, [initial, name, baseUrl, apiKey, selectedProtocols]);

  const modelsDirty = useMemo(() => {
    return normalizeModels(models) !== normalizeModels(initial?.models ?? []);
  }, [initial?.models, models]);

  const isDirty = connectionDirty || modelsDirty;

  const submit = useCallback(async () => {
    if (models.length > 0 && !models.some((m) => m.enabled !== false)) {
      setError(t("providers.atLeastOneModelEnabled"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await upsert({
        id: initial?.id,
        presetId: initial?.presetId ?? presetId,
        name: name.trim(),
        protocol: primaryProtocol,
        protocols: selectedProtocols,
        baseUrl: baseUrl.trim(),
        envKey: envPlaceholder,
        apiKey: apiKey.trim() || undefined,
        models,
        wireApi: selectedProtocols.includes("openai-responses") ? "responses" : "chat",
      });
      setSavedAt(new Date());
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [
    initial,
    presetId,
    name,
    primaryProtocol,
    selectedProtocols,
    baseUrl,
    envPlaceholder,
    apiKey,
    models,
    upsert,
    onSaved,
    t,
  ]);

  // Unified save model: every change (connection fields OR model list) on an
  // existing provider is debounce-auto-saved; the header status pill reports
  // unsaved / saving / saved instead of a separate manual save button.
  useEffect(() => {
    if (!initial?.id || !isDirty || saving) {
      return;
    }
    if (models.length > 0 && !models.some((m) => m.enabled !== false)) {
      return;
    }
    if (!name.trim() || !baseUrl.trim()) {
      return;
    }
    const timer = setTimeout(() => {
      void submit();
    }, 800);
    return () => clearTimeout(timer);
  }, [initial?.id, isDirty, saving, models, name, baseUrl, submit]);

  return (
    <div className="provider-detail-workspace">
      {/* Workspace Header */}
      <div className="provider-detail-header">
        <div className="provider-detail-title-wrap">
          <ProviderBrandIcon
            nameOrId={name.trim() || initial?.name || initial?.presetId || presetId || initial?.id || ""}
            size={34}
            className="provider-detail-brand-icon"
          />
          <div className="provider-detail-title-text">
            <h3>
              {initial
                ? name.trim() || initial.name || t("providers.edit")
                : t("providers.newProvider")}
            </h3>
            {initial?.lastHealth === "ok" ? (
              <span className="provider-health-badge ok" title={initial.lastCheckedAt}>
                <span className="provider-health-dot" />
                {initial.lastLatencyMs ? `${initial.lastLatencyMs}ms` : t("providers.statusOk")}
              </span>
            ) : initial?.lastHealth === "error" ? (
              <span
                className="provider-health-badge error"
                title={initial.lastError || initial.lastCheckedAt}
              >
                <span className="provider-health-dot" />
                {initial.lastError ? initial.lastError.slice(0, 24) : t("providers.statusError")}
              </span>
            ) : null}
            {/* Unified save status: every change auto-saves; this pill is the
                single source of truth for "is my change persisted?". */}
            {initial ? (
              saving ? (
                <span className="provider-save-status saving">
                  <RefreshCw size={11} className="spinning" />
                  <span>{t("common.saving")}</span>
                </span>
              ) : isDirty ? (
                <span className="provider-save-status unsaved">
                  <span className="provider-save-status-dot" />
                  <span>{t("providers.unsavedChanges")}</span>
                </span>
              ) : savedAt ? (
                <span className="provider-save-status saved">
                  <Check size={11} />
                  <span>
                    {t("providers.savedAt", {
                      time: savedAt.toLocaleTimeString([], { hour12: false }),
                    })}
                  </span>
                </span>
              ) : null
            ) : null}
          </div>
        </div>

        <div className="provider-detail-actions">
          {initial && onDeleted && (
            <button
              type="button"
              className="provider-header-btn danger"
              onClick={handleDelete}
              title={t("providers.deleteProvider")}
            >
              <Trash2 size={14} />
              <span>{t("common.delete")}</span>
            </button>
          )}
          <button
            type="button"
            className="provider-header-btn secondary"
            disabled={testing || !baseUrl.trim()}
            onClick={() => void testConnection()}
            title={t("providers.testFormHint")}
          >
            <RefreshCw size={14} className={testing ? "spinning" : ""} />
            <span>{testing ? t("providers.testing") : t("providers.testConnection")}</span>
          </button>
          {!initial ? (
            <button
              type="button"
              className="provider-header-btn primary"
              disabled={saving || !name.trim() || !baseUrl.trim()}
              onClick={() => void submit()}
            >
              {saving ? (
                <RefreshCw size={14} className="spinning" />
              ) : (
                <Check size={14} />
              )}
              <span>{saving ? t("common.saving") : t("providers.createProvider")}</span>
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="providers-error" role="alert">
          {error}
        </div>
      ) : null}

      {!initial && onPickPreset ? (
        <ProviderPresetPicker onPick={onPickPreset} />
      ) : null}

      {/* Compact Config + Full-Width Model List */}
      <div className="provider-editor-compact">
        {/* Compact top config area */}
        <div className="provider-compact-config">
          {/* Row 1: Name + Protocol pills */}
          <div className="provider-compact-row">
            <label className="provider-compact-field provider-compact-name">
              <span>{t("providers.name")}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("providers.modelNamePlaceholder")}
              />
            </label>
            <div className="provider-compact-field provider-compact-protos">
              <span>{t("providers.supportedProtocols")}</span>
              <div className="provider-proto-pills">
                {PROTOCOLS.map((p) => {
                  const active = selectedProtocols.includes(p);
                  const cfg = PROTOCOL_CONFIG[p];
                  return (
                    <button
                      key={p}
                      type="button"
                      className={`provider-proto-pill ${active ? "active" : ""}`}
                      onClick={() => {
                        toggleProtocol(p);
                        if (!baseUrl && !active) {
                          setBaseUrl(cfg.defaultUrl);
                        }
                      }}
                      title={t(cfg.descKey)}
                    >
                      <div className={`proto-pill-check ${active ? "checked" : ""}`}>
                        {active ? <Check size={10} /> : null}
                      </div>
                      <span>{t(cfg.labelKey)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Row 2: Base URL + API Key side by side */}
          <div className="provider-compact-row">
            <label className="provider-compact-field provider-compact-url">
              <span>{t("providers.baseUrl")}</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://..."
              />
            </label>
            <div className="provider-compact-field provider-compact-key">
              <div className="provider-key-label-row">
                <span>{t("providers.apiKey")}</span>
                {consoleUrl ? (
                  <a
                    href={consoleUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="provider-key-console-link"
                  >
                    {t("providers.getKey")}
                    <ExternalLink size={12} />
                  </a>
                ) : null}
              </div>
              <div className="provider-key-input-wrapper">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={keyPlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                />
                <div className="provider-key-actions">
                  <button
                    type="button"
                    className="provider-eye-btn"
                    title={showKey ? t("providers.hideKey") : t("providers.showKey")}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  {(apiKey || initial?.hasKey) && (
                    <button
                      type="button"
                      className="provider-eye-btn"
                      title={keyCopied ? t("providers.keyCopied") : t("providers.copyKey")}
                      onClick={() => void onCopyKey()}
                    >
                      {keyCopied ? (
                        <Check size={14} className="copied-icon" />
                      ) : (
                        <Copy size={14} />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Row 3: Fetch button + test/message results */}
          <div className="provider-compact-row provider-compact-footer">
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
            {testResult ? (
              <div className="provider-test-result-wrap">
                <div className={`provider-test-pill ${testResult.ok ? "ok" : "error"}`}>
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
                      <span>{t("providers.testFailedShort")}</span>
                      <button
                        type="button"
                        className="provider-test-detail-toggle"
                        onClick={() => setErrorExpanded((v) => !v)}
                      >
                        {errorExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        <span>
                          {errorExpanded ? t("providers.collapseDetail") : t("providers.viewDetail")}
                        </span>
                      </button>
                    </>
                  )}
                </div>
                {!testResult.ok && errorExpanded ? (
                  <div className="provider-test-detail">
                    <pre className="provider-test-detail-error">
                      {testResult.error || t("providers.statusError")}
                    </pre>
                    {consoleUrl ? (
                      <a
                        href={consoleUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="provider-key-console-link"
                      >
                        {t("providers.troubleshootKey")}
                        <ExternalLink size={11} />
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {modelMessage ? (
              <div
                className={`provider-test-pill ${modelMessage.type === "success" ? "ok" : "error"}`}
              >
                {modelMessage.type === "success" ? (
                  <CheckCircle2 size={14} />
                ) : (
                  <AlertTriangle size={14} />
                )}
                <span>{modelMessage.text}</span>
              </div>
            ) : null}
          </div>
        </div>

        {/* Full-width Model Management */}
        <div className="provider-compact-models">
          <ProviderModelManager
            models={models}
            onChange={setModels}
            isDirty={modelsDirty}
            onSave={() => void submit()}
            saving={saving}
          />
        </div>
      </div>
    </div>
  );
}
