import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Mic,
  Volume2,
} from "lucide-react";
import {
  DASHSCOPE_ENDPOINT_ORIGINS,
  SPEECH_CATALOG,
  SPEECH_PROVIDER_KINDS,
  detectDashScopeKeyEndpointMismatch,
  resolveDashScopeOrigin,
} from "../../../electron/shared/speechCatalog";
import { cliClient } from "@/services/cli/client";
import {
  speechClient,
  type DashScopeEndpointPreset,
  type SpeechCredentialMode,
  type SpeechProviderConfig,
  type SpeechProviderConfigUpdate,
  type SpeechProviderKind,
  type SpeechTestResult,
  type VolcengineAuthMode,
} from "@/services/speech/client";
import { useProviderStore } from "@/store/providerStore";
import { useSpeechStore } from "@/store/speechStore";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import "./SpeechTab.css";

const CUSTOM_OPTION = "__custom__";

const BRAND_ICON_MAP: Record<SpeechProviderKind, string> = {
  deepseek: "deepseek",
  dashscope: "qwen",
  volcengine: "doubao",
};

interface ProviderFormDraft {
  enabled: boolean;
  credentialMode: SpeechCredentialMode;
  linkedProviderId: string;
  apiKey: string;
  clearApiKey: boolean;
  baseUrl: string;
  dashscopeEndpointPreset: DashScopeEndpointPreset;
  volcAuthMode: VolcengineAuthMode;
  volcAppId: string;
  volcAccessToken: string;
  clearVolcAccessToken: boolean;
  volcAsrResourceId: string;
  volcTtsResourceId: string;
  asrModel: string;
  ttsModel: string;
  ttsVoice: string;
}

function configToDraft(cfg: SpeechProviderConfig): ProviderFormDraft {
  return {
    enabled: cfg.enabled,
    credentialMode: cfg.credentialMode,
    linkedProviderId: cfg.linkedProviderId ?? "",
    apiKey: "",
    clearApiKey: false,
    baseUrl: cfg.baseUrl ?? SPEECH_CATALOG[cfg.kind].defaultBaseUrl,
    dashscopeEndpointPreset: cfg.dashscopeEndpointPreset ?? "payg-cn",
    volcAuthMode: cfg.volcAuthMode ?? "app_token",
    volcAppId: cfg.volcAppId ?? "",
    volcAccessToken: "",
    clearVolcAccessToken: false,
    volcAsrResourceId: cfg.volcAsrResourceId ?? "volc.bigasr.auc_turbo",
    volcTtsResourceId: cfg.volcTtsResourceId ?? "seed-tts-2.0",
    asrModel: cfg.asrModel ?? SPEECH_CATALOG[cfg.kind].asrModels[0]?.id ?? "",
    ttsModel: cfg.ttsModel ?? SPEECH_CATALOG[cfg.kind].ttsModels[0]?.id ?? "",
    ttsVoice: cfg.ttsVoice ?? SPEECH_CATALOG[cfg.kind].ttsVoices[0]?.id ?? "",
  };
}

function isProviderReady(cfg: SpeechProviderConfig): boolean {
  if (!cfg.enabled) return false;
  if (cfg.kind === "volcengine") {
    return cfg.volcAuthMode === "api_key"
      ? cfg.hasApiKey
      : Boolean(cfg.volcAppId?.trim() && cfg.hasVolcAccessToken);
  }
  if (cfg.credentialMode === "linked_provider") {
    return Boolean(cfg.linkedProviderId);
  }
  return cfg.hasApiKey;
}

function openExternalUrl(url: string): void {
  if (cliClient.isAvailable()) {
    void cliClient.openBrowserExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function SelectOrCustom({
  id,
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const isPreset = options.some((opt) => opt.id === value);
  const [forcingCustom, setForcingCustom] = useState(false);
  const showCustomInput = forcingCustom || (Boolean(value) && !isPreset);

  return (
    <div className="speech-field">
      <label htmlFor={id}>{label}</label>
      <div className="speech-custom-input-wrap">
        <select
          id={id}
          value={showCustomInput ? CUSTOM_OPTION : value}
          onChange={(e) => {
            const val = e.target.value;
            if (val === CUSTOM_OPTION) {
              setForcingCustom(true);
            } else {
              setForcingCustom(false);
              onChange(val);
            }
          }}
        >
          {options.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
          <option value={CUSTOM_OPTION}>{t("speech.customOption")}</option>
        </select>
        {showCustomInput && (
          <input
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

export function SpeechTab() {
  const { t } = useTranslation();
  const config = useSpeechStore((s) => s.config);
  const loaded = useSpeechStore((s) => s.loaded);
  const loadSpeech = useSpeechStore((s) => s.load);
  const saveProvider = useSpeechStore((s) => s.saveProvider);
  const savePreferences = useSpeechStore((s) => s.savePreferences);
  const testProvider = useSpeechStore((s) => s.testProvider);
  const playPreview = useSpeechStore((s) => s.playPreview);

  const llmProviders = useProviderStore((s) => s.providers);
  const llmLoaded = useProviderStore((s) => s.loaded);
  const loadLlmProviders = useProviderStore((s) => s.load);

  const [selectedKind, setSelectedKind] = useState<SpeechProviderKind>("deepseek");
  const [draft, setDraft] = useState<ProviderFormDraft | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showVolcToken, setShowVolcToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [testingTarget, setTestingTarget] = useState<"tts" | "asr" | null>(null);
  const [testResult, setTestResult] = useState<SpeechTestResult | null>(null);

  useEffect(() => {
    if (!loaded) void loadSpeech();
    if (!llmLoaded) void loadLlmProviders();
  }, [loaded, loadSpeech, llmLoaded, loadLlmProviders]);

  const savedConfig = config?.providers[selectedKind];

  useEffect(() => {
    if (savedConfig) {
      setDraft(configToDraft(savedConfig));
      setSaveFeedback(null);
      setTestResult(null);
      setShowApiKey(false);
      setShowVolcToken(false);
    }
  }, [selectedKind, savedConfig?.updatedAt]);

  const availableLlmProviders = useMemo(() => {
    const enabled = llmProviders.filter((p) => p.enabled && p.hasKey);
    const matchRegex =
      selectedKind === "deepseek"
        ? /deepseek/i
        : /(dashscope|aliyun|bailian|qwen|token-plan)/i;
    return [...enabled].sort((a, b) => {
      const aMatch = matchRegex.test(`${a.name} ${a.baseUrl} ${a.presetId ?? ""}`) ? 0 : 1;
      const bMatch = matchRegex.test(`${b.name} ${b.baseUrl} ${b.presetId ?? ""}`) ? 0 : 1;
      return aMatch - bMatch;
    });
  }, [llmProviders, selectedKind]);

  const linkedProvider = useMemo(
    () =>
      draft?.credentialMode === "linked_provider" && draft.linkedProviderId
        ? llmProviders.find((p) => p.id === draft.linkedProviderId)
        : undefined,
    [draft?.credentialMode, draft?.linkedProviderId, llmProviders]
  );

  const resolvedDashScopeOrigin = useMemo(() => {
    if (selectedKind !== "dashscope" || !draft) return "";
    return resolveDashScopeOrigin({
      preset: draft.dashscopeEndpointPreset,
      customBaseUrl: draft.baseUrl,
      linkedProviderBaseUrl: linkedProvider?.baseUrl,
    });
  }, [selectedKind, draft, linkedProvider?.baseUrl]);

  const dashScopeMismatch = useMemo(() => {
    if (selectedKind !== "dashscope" || !draft) return null;
    if (draft.credentialMode === "custom") {
      return detectDashScopeKeyEndpointMismatch(draft.apiKey, resolvedDashScopeOrigin);
    }
    return null;
  }, [selectedKind, draft, resolvedDashScopeOrigin]);

  if (!speechClient.isAvailable()) {
    return (
      <div className="speech-tab">
        <div className="speech-banner info">
          <Info size={16} />
          <span>{t("speech.desktopOnly")}</span>
        </div>
      </div>
    );
  }

  if (!config || !draft || !savedConfig) {
    return <div className="speech-tab">{t("common.loading")}</div>;
  }

  const prefs = config.preferences;
  const catalog = SPEECH_CATALOG[selectedKind];

  const buildUpdatePayload = (): SpeechProviderConfigUpdate => {
    const base: SpeechProviderConfigUpdate = {
      kind: selectedKind,
      enabled: draft.enabled,
      credentialMode: draft.credentialMode,
      linkedProviderId:
        draft.credentialMode === "linked_provider" ? draft.linkedProviderId || null : null,
      baseUrl: draft.baseUrl.trim() || null,
      asrModel: draft.asrModel.trim() || null,
      ttsModel: draft.ttsModel.trim() || null,
      ttsVoice: draft.ttsVoice.trim() || null,
    };

    if (draft.clearApiKey) {
      base.clearApiKey = true;
    } else if (draft.apiKey.trim()) {
      base.apiKey = draft.apiKey.trim();
    }

    if (selectedKind === "dashscope") {
      base.dashscopeEndpointPreset = draft.dashscopeEndpointPreset;
      if (draft.dashscopeEndpointPreset !== "custom") {
        base.baseUrl = DASHSCOPE_ENDPOINT_ORIGINS[draft.dashscopeEndpointPreset];
      }
    }

    if (selectedKind === "volcengine") {
      base.volcAuthMode = draft.volcAuthMode;
      base.volcAppId = draft.volcAppId.trim() || null;
      base.volcAsrResourceId = draft.volcAsrResourceId.trim() || null;
      base.volcTtsResourceId = draft.volcTtsResourceId.trim() || null;
      if (draft.clearVolcAccessToken) {
        base.clearVolcAccessToken = true;
      } else if (draft.volcAccessToken.trim()) {
        base.volcAccessToken = draft.volcAccessToken.trim();
      }
    }

    return base;
  };

  const handleSaveProvider = async () => {
    setSaving(true);
    setSaveFeedback(null);
    try {
      const saved = await saveProvider(buildUpdatePayload());
      setDraft(configToDraft(saved));

      // Auto-select first enabled & configured provider as default ASR/TTS when unassigned.
      if (isProviderReady(saved)) {
        const patch: Partial<typeof prefs> = {};
        if (!prefs.activeAsrProvider) patch.activeAsrProvider = saved.kind;
        if (!prefs.activeTtsProvider) patch.activeTtsProvider = saved.kind;
        if (Object.keys(patch).length > 0) {
          await savePreferences(patch);
        }
      }
      setSaveFeedback({ ok: true, text: t("common.saved") });
    } catch (err) {
      setSaveFeedback({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (target: "tts" | "asr") => {
    setTestingTarget(target);
    setTestResult(null);
    setSaveFeedback(null);
    try {
      const res = await testProvider({
        kind: selectedKind,
        target,
        draft: buildUpdatePayload(),
      });
      setTestResult(res);
      if (target === "tts" && res.ok && res.audio && res.mimeType) {
        await playPreview(`preview-${selectedKind}`, res.audio, res.mimeType);
      }
    } catch (err) {
      setTestResult({
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setTestingTarget(null);
    }
  };

  return (
    <div className="speech-tab">
      <div className="speech-tab-header">
        <h3>{t("speech.title")}</h3>
        <p>{t("speech.subtitle")}</p>
      </div>

      {/* Default routing & preferences */}
      <section className="speech-card">
        <h4 className="speech-card-title">{t("speech.routingTitle")}</h4>
        <div className="speech-routing-grid">
          <div className="speech-field">
            <label htmlFor="speech-active-asr">{t("speech.activeAsr")}</label>
            <select
              id="speech-active-asr"
              value={prefs.activeAsrProvider ?? ""}
              onChange={(e) => {
                const val = e.target.value as SpeechProviderKind | "";
                void savePreferences({ activeAsrProvider: val || null });
              }}
            >
              <option value="">{t("speech.disabledOption")}</option>
              {SPEECH_PROVIDER_KINDS.map((kind) => {
                const ready = isProviderReady(config.providers[kind]);
                return (
                  <option key={kind} value={kind}>
                    {t(`speech.providers.${kind}.name`)}
                    {!ready ? ` (${t("speech.notConfiguredTag")})` : ""}
                  </option>
                );
              })}
            </select>
          </div>

          <div className="speech-field">
            <label htmlFor="speech-active-tts">{t("speech.activeTts")}</label>
            <select
              id="speech-active-tts"
              value={prefs.activeTtsProvider ?? ""}
              onChange={(e) => {
                const val = e.target.value as SpeechProviderKind | "";
                void savePreferences({ activeTtsProvider: val || null });
              }}
            >
              <option value="">{t("speech.disabledOption")}</option>
              {SPEECH_PROVIDER_KINDS.map((kind) => {
                const ready = isProviderReady(config.providers[kind]);
                return (
                  <option key={kind} value={kind}>
                    {t(`speech.providers.${kind}.name`)}
                    {!ready ? ` (${t("speech.notConfiguredTag")})` : ""}
                  </option>
                );
              })}
            </select>
          </div>

          <div className="speech-field">
            <label htmlFor="speech-asr-action">{t("speech.asrAfterTranscribe")}</label>
            <select
              id="speech-asr-action"
              value={prefs.asrAfterTranscribe}
              onChange={(e) =>
                void savePreferences({
                  asrAfterTranscribe: e.target.value === "send" ? "send" : "insert",
                })
              }
            >
              <option value="insert">{t("speech.asrActionInsert")}</option>
              <option value="send">{t("speech.asrActionSend")}</option>
            </select>
          </div>

          <div className="speech-field">
            <label htmlFor="speech-playback-rate">{t("speech.ttsPlaybackRate")}</label>
            <select
              id="speech-playback-rate"
              value={String(prefs.ttsPlaybackRate)}
              onChange={(e) =>
                void savePreferences({ ttsPlaybackRate: Number(e.target.value) || 1.0 })
              }
            >
              {[0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                <option key={rate} value={String(rate)}>
                  {rate}x
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="speech-checkboxes">
          <label className="speech-checkbox-label">
            <input
              type="checkbox"
              checked={prefs.ttsStripCodeBlocks}
              onChange={(e) =>
                void savePreferences({ ttsStripCodeBlocks: e.target.checked })
              }
            />
            <span>{t("speech.ttsStripCodeBlocks")}</span>
          </label>
          <label className="speech-checkbox-label">
            <input
              type="checkbox"
              checked={prefs.ttsStripMarkdown}
              onChange={(e) =>
                void savePreferences({ ttsStripMarkdown: e.target.checked })
              }
            />
            <span>{t("speech.ttsStripMarkdown")}</span>
          </label>
        </div>
      </section>

      {/* Provider selector tabs */}
      <div className="speech-provider-tabs" role="tablist">
        {SPEECH_PROVIDER_KINDS.map((kind) => {
          const cfg = config.providers[kind];
          const isAsr = prefs.activeAsrProvider === kind;
          const isTts = prefs.activeTtsProvider === kind;
          const healthClass =
            cfg.lastHealth === "ok"
              ? "ok"
              : cfg.lastHealth === "error"
                ? "error"
                : "";
          return (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={selectedKind === kind}
              className={`speech-provider-tab${selectedKind === kind ? " active" : ""}`}
              onClick={() => setSelectedKind(kind)}
            >
              <ProviderBrandIcon
                nameOrId={BRAND_ICON_MAP[kind]}
                lobeIconId={BRAND_ICON_MAP[kind]}
                size={24}
              />
              <div className="speech-provider-tab-meta">
                <span className="speech-provider-tab-title">
                  {t(`speech.providers.${kind}.name`)}
                </span>
                <div className="speech-provider-tab-badges">
                  <span>
                    {isProviderReady(cfg)
                      ? t("speech.configuredTag")
                      : t("speech.unconfiguredTag")}
                  </span>
                  {isAsr && <span className="speech-badge">ASR</span>}
                  {isTts && <span className="speech-badge">TTS</span>}
                </div>
              </div>
              <span className={`speech-health-dot ${healthClass}`} />
            </button>
          );
        })}
      </div>

      {/* Selected provider detail form */}
      <section className="speech-card">
        <div className="speech-provider-header">
          <div className="speech-provider-header-left">
            <ProviderBrandIcon
              nameOrId={BRAND_ICON_MAP[selectedKind]}
              lobeIconId={BRAND_ICON_MAP[selectedKind]}
              size={24}
            />
            <h4>{t(`speech.providers.${selectedKind}.name`)}</h4>
          </div>
          <div className="speech-provider-header-actions">
            <label className="speech-checkbox-label">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) =>
                  setDraft((prev) => (prev ? { ...prev, enabled: e.target.checked } : prev))
                }
              />
              <span>{t("speech.enableProvider")}</span>
            </label>
            <button
              type="button"
              className="speech-link-btn"
              onClick={() => openExternalUrl(catalog.consoleUrl)}
            >
              <span>{t("speech.openConsole")}</span>
              <ExternalLink size={12} />
            </button>
          </div>
        </div>

        {selectedKind === "volcengine" && (
          <div className="speech-banner info">
            <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{t("speech.volcengineNote")}</span>
          </div>
        )}

        {selectedKind === "deepseek" && (
          <div className="speech-banner info">
            <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{t("speech.deepseekNote")}</span>
          </div>
        )}

        {catalog.supportsLinkedProvider && (
          <div className="speech-field">
            <label>{t("speech.credentialMode")}</label>
            <div className="speech-segmented">
              <button
                type="button"
                className={draft.credentialMode === "custom" ? "active" : ""}
                onClick={() =>
                  setDraft((prev) =>
                    prev ? { ...prev, credentialMode: "custom" } : prev
                  )
                }
              >
                {t("speech.credentialCustom")}
              </button>
              <button
                type="button"
                className={draft.credentialMode === "linked_provider" ? "active" : ""}
                onClick={() =>
                  setDraft((prev) =>
                    prev
                      ? {
                          ...prev,
                          credentialMode: "linked_provider",
                          linkedProviderId:
                            prev.linkedProviderId || availableLlmProviders[0]?.id || "",
                        }
                      : prev
                  )
                }
              >
                {t("speech.credentialLinked")}
              </button>
            </div>
          </div>
        )}

        {catalog.supportsLinkedProvider && draft.credentialMode === "linked_provider" ? (
          <div className="speech-field">
            <label htmlFor="speech-linked-provider">{t("speech.linkedProviderLabel")}</label>
            <select
              id="speech-linked-provider"
              value={draft.linkedProviderId}
              onChange={(e) =>
                setDraft((prev) =>
                  prev ? { ...prev, linkedProviderId: e.target.value } : prev
                )
              }
            >
              <option value="">{t("speech.selectLinkedProvider")}</option>
              {availableLlmProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.baseUrl})
                </option>
              ))}
            </select>
            {availableLlmProviders.length === 0 && (
              <span className="speech-hint">{t("speech.noLinkedProviders")}</span>
            )}
          </div>
        ) : null}

        {selectedKind === "volcengine" ? (
          <>
            <div className="speech-field">
              <label>{t("speech.volcAuthMode")}</label>
              <div className="speech-segmented">
                <button
                  type="button"
                  className={draft.volcAuthMode === "app_token" ? "active" : ""}
                  onClick={() =>
                    setDraft((prev) =>
                      prev ? { ...prev, volcAuthMode: "app_token" } : prev
                    )
                  }
                >
                  {t("speech.volcAuthAppToken")}
                </button>
                <button
                  type="button"
                  className={draft.volcAuthMode === "api_key" ? "active" : ""}
                  onClick={() =>
                    setDraft((prev) =>
                      prev ? { ...prev, volcAuthMode: "api_key" } : prev
                    )
                  }
                >
                  {t("speech.volcAuthApiKey")}
                </button>
              </div>
            </div>

            {draft.volcAuthMode === "app_token" ? (
              <div className="speech-routing-grid">
                <div className="speech-field">
                  <label htmlFor="speech-volc-appid">{t("speech.volcAppId")}</label>
                  <input
                    id="speech-volc-appid"
                    type="text"
                    value={draft.volcAppId}
                    placeholder="App ID"
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev ? { ...prev, volcAppId: e.target.value } : prev
                      )
                    }
                  />
                </div>
                <div className="speech-field">
                  <label htmlFor="speech-volc-token">{t("speech.volcAccessToken")}</label>
                  <div className="speech-secret-row">
                    <input
                      id="speech-volc-token"
                      type={showVolcToken ? "text" : "password"}
                      value={draft.volcAccessToken}
                      placeholder={
                        savedConfig.hasVolcAccessToken && !draft.clearVolcAccessToken
                          ? savedConfig.volcAccessTokenPreview || t("speech.keySavedPlaceholder")
                          : t("speech.volcAccessTokenPlaceholder")
                      }
                      onChange={(e) =>
                        setDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                volcAccessToken: e.target.value,
                                clearVolcAccessToken: false,
                              }
                            : prev
                        )
                      }
                    />
                    <button
                      type="button"
                      className="speech-icon-toggle"
                      onClick={() => setShowVolcToken((v) => !v)}
                      title={t("speech.toggleKeyVisibility")}
                    >
                      {showVolcToken ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    {savedConfig.hasVolcAccessToken && !draft.clearVolcAccessToken && (
                      <button
                        type="button"
                        className="speech-icon-toggle"
                        onClick={() =>
                          setDraft((prev) =>
                            prev
                              ? { ...prev, volcAccessToken: "", clearVolcAccessToken: true }
                              : prev
                          )
                        }
                      >
                        {t("speech.clearKey")}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="speech-field">
                <label htmlFor="speech-volc-apikey">{t("speech.apiKey")}</label>
                <div className="speech-secret-row">
                  <input
                    id="speech-volc-apikey"
                    type={showApiKey ? "text" : "password"}
                    value={draft.apiKey}
                    placeholder={
                      savedConfig.hasApiKey && !draft.clearApiKey
                        ? savedConfig.apiKeyPreview || t("speech.keySavedPlaceholder")
                        : t("speech.apiKeyPlaceholder")
                    }
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev
                          ? { ...prev, apiKey: e.target.value, clearApiKey: false }
                          : prev
                      )
                    }
                  />
                  <button
                    type="button"
                    className="speech-icon-toggle"
                    onClick={() => setShowApiKey((v) => !v)}
                    title={t("speech.toggleKeyVisibility")}
                  >
                    {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            )}

            <div className="speech-routing-grid">
              <SelectOrCustom
                id="speech-volc-asr-res"
                label={t("speech.volcAsrResourceId")}
                value={draft.volcAsrResourceId}
                options={catalog.volcAsrResourceIds ?? []}
                placeholder="volc.bigasr.auc_turbo"
                onChange={(val) =>
                  setDraft((prev) =>
                    prev ? { ...prev, volcAsrResourceId: val } : prev
                  )
                }
              />
              <SelectOrCustom
                id="speech-volc-tts-res"
                label={t("speech.volcTtsResourceId")}
                value={draft.volcTtsResourceId}
                options={catalog.volcTtsResourceIds ?? []}
                placeholder="seed-tts-2.0"
                onChange={(val) =>
                  setDraft((prev) =>
                    prev ? { ...prev, volcTtsResourceId: val } : prev
                  )
                }
              />
            </div>
          </>
        ) : draft.credentialMode === "custom" ? (
          <div className="speech-field">
            <label htmlFor="speech-api-key">{t("speech.apiKey")}</label>
            <div className="speech-secret-row">
              <input
                id="speech-api-key"
                type={showApiKey ? "text" : "password"}
                value={draft.apiKey}
                placeholder={
                  savedConfig.hasApiKey && !draft.clearApiKey
                    ? savedConfig.apiKeyPreview || t("speech.keySavedPlaceholder")
                    : selectedKind === "dashscope"
                      ? "sk-... / sk-sp-..."
                      : "sk-..."
                }
                onChange={(e) =>
                  setDraft((prev) =>
                    prev ? { ...prev, apiKey: e.target.value, clearApiKey: false } : prev
                  )
                }
              />
              <button
                type="button"
                className="speech-icon-toggle"
                onClick={() => setShowApiKey((v) => !v)}
                title={t("speech.toggleKeyVisibility")}
              >
                {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              {savedConfig.hasApiKey && !draft.clearApiKey && (
                <button
                  type="button"
                  className="speech-icon-toggle"
                  onClick={() =>
                    setDraft((prev) =>
                      prev ? { ...prev, apiKey: "", clearApiKey: true } : prev
                    )
                  }
                >
                  {t("speech.clearKey")}
                </button>
              )}
            </div>
          </div>
        ) : null}

        {selectedKind === "dashscope" && (
          <>
            <div className="speech-field">
              <label htmlFor="speech-dashscope-preset">{t("speech.dashscopeEndpoint")}</label>
              <select
                id="speech-dashscope-preset"
                value={draft.dashscopeEndpointPreset}
                onChange={(e) => {
                  const preset = e.target.value as DashScopeEndpointPreset;
                  setDraft((prev) =>
                    prev
                      ? {
                          ...prev,
                          dashscopeEndpointPreset: preset,
                          ...(preset !== "custom"
                            ? { baseUrl: DASHSCOPE_ENDPOINT_ORIGINS[preset] }
                            : {}),
                        }
                      : prev
                  );
                }}
              >
                <option value="payg-cn">{t("speech.dashscopePresetPaygCn")}</option>
                <option value="payg-intl">{t("speech.dashscopePresetPaygIntl")}</option>
                <option value="token-plan-cn">{t("speech.dashscopePresetTokenPlanCn")}</option>
                <option value="token-plan-intl">{t("speech.dashscopePresetTokenPlanIntl")}</option>
                <option value="custom">{t("speech.dashscopePresetCustom")}</option>
              </select>
              <span className="speech-hint">
                {t("speech.resolvedEndpointHint", { url: resolvedDashScopeOrigin })}
              </span>
            </div>

            {dashScopeMismatch && (
              <div className="speech-banner warn">
                <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  {dashScopeMismatch === "token_plan_key_on_payg"
                    ? t("speech.dashscopeMismatchTokenPlanKey")
                    : t("speech.dashscopeMismatchPaygKey")}
                </span>
              </div>
            )}
          </>
        )}

        {(selectedKind !== "dashscope" || draft.dashscopeEndpointPreset === "custom") && (
          <div className="speech-field">
            <label htmlFor="speech-base-url">{t("speech.baseUrl")}</label>
            <input
              id="speech-base-url"
              type="url"
              value={draft.baseUrl}
              placeholder={catalog.defaultBaseUrl}
              onChange={(e) =>
                setDraft((prev) => (prev ? { ...prev, baseUrl: e.target.value } : prev))
              }
            />
          </div>
        )}

        <div className="speech-routing-grid">
          {selectedKind !== "deepseek" && (
            <SelectOrCustom
              id="speech-asr-model"
              label={t("speech.asrModel")}
              value={draft.asrModel}
              options={catalog.asrModels}
              placeholder={catalog.asrModels[0]?.id}
              onChange={(val) =>
                setDraft((prev) => (prev ? { ...prev, asrModel: val } : prev))
              }
            />
          )}

          {selectedKind !== "deepseek" && selectedKind !== "volcengine" && (
            <SelectOrCustom
              id="speech-tts-model"
              label={t("speech.ttsModel")}
              value={draft.ttsModel}
              options={catalog.ttsModels}
              placeholder={catalog.ttsModels[0]?.id}
              onChange={(val) =>
                setDraft((prev) => (prev ? { ...prev, ttsModel: val } : prev))
              }
            />
          )}

          <SelectOrCustom
            id="speech-tts-voice"
            label={t("speech.ttsVoice")}
            value={draft.ttsVoice}
            options={catalog.ttsVoices}
            placeholder={catalog.ttsVoices[0]?.id}
            onChange={(val) =>
              setDraft((prev) => (prev ? { ...prev, ttsVoice: val } : prev))
            }
          />
        </div>

        {saveFeedback && (
          <div className={`speech-banner ${saveFeedback.ok ? "success" : "error"}`}>
            {saveFeedback.ok ? (
              <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            ) : (
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            )}
            <span>{saveFeedback.text}</span>
          </div>
        )}

        {testResult && (
          <div className={`speech-banner ${testResult.ok ? "success" : "error"}`}>
            {testResult.ok ? (
              <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            ) : (
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            )}
            <span>
              {testResult.ok
                ? t("speech.testSuccess", { ms: testResult.latencyMs })
                : testResult.error || t("speech.testFailed")}
            </span>
          </div>
        )}

        <div className="speech-footer-actions">
          <div className="speech-footer-buttons">
            <button
              type="button"
              className="speech-btn primary"
              disabled={saving}
              onClick={() => void handleSaveProvider()}
            >
              {saving && <Loader2 size={14} className="spin" />}
              <span>{saving ? t("common.saving") : t("common.save")}</span>
            </button>
            <button
              type="button"
              className="speech-btn"
              disabled={Boolean(testingTarget)}
              onClick={() => void handleTest("tts")}
            >
              {testingTarget === "tts" ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Volume2 size={14} />
              )}
              <span>{t("speech.previewTts")}</span>
            </button>
            <button
              type="button"
              className="speech-btn"
              disabled={Boolean(testingTarget)}
              onClick={() => void handleTest("asr")}
            >
              {testingTarget === "asr" ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Mic size={14} />
              )}
              <span>{t("speech.testAsr")}</span>
            </button>
          </div>
          {savedConfig.lastCheckedAt && (
            <span className="speech-hint">
              {savedConfig.lastHealth === "ok"
                ? t("speech.lastCheckOk", { ms: savedConfig.lastLatencyMs ?? 0 })
                : savedConfig.lastHealth === "error"
                  ? savedConfig.lastError || t("speech.testFailed")
                  : ""}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
