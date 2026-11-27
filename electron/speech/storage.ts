import { getDb } from "../cli/db.js";
import { getProvider, getProviderApiKey } from "../cli/providers.js";
import { getSetting, setSetting } from "../cli/settings.js";
import { decryptSecret, encryptSecret, redactApiKey } from "../cli/store.js";
import {
  DEFAULT_SPEECH_PREFERENCES,
  SPEECH_PROVIDER_KINDS,
  defaultSpeechProviderConfig,
} from "../shared/speechCatalog.js";
import {
  SpeechError,
  type DashScopeEndpointPreset,
  type SpeechConfigSnapshot,
  type SpeechCredentialMode,
  type SpeechHealth,
  type SpeechPreferences,
  type SpeechProviderConfig,
  type SpeechProviderConfigUpdate,
  type SpeechProviderKind,
  type SpeechTtsFormat,
  type VolcengineAuthMode,
} from "../shared/speechTypes.js";

const SPEECH_PREFERENCES_KEY = "speech.preferences.v1";

interface SpeechProviderRow {
  kind: string;
  enabled: number;
  credential_mode: string;
  linked_provider_id: string | null;
  api_key_encrypted: string | null;
  api_key_preview: string | null;
  base_url: string | null;
  dashscope_endpoint_preset: string | null;
  volc_auth_mode: string | null;
  volc_app_id: string | null;
  volc_access_token_encrypted: string | null;
  volc_access_token_preview: string | null;
  volc_asr_resource_id: string | null;
  volc_tts_resource_id: string | null;
  asr_model: string | null;
  tts_model: string | null;
  tts_voice: string | null;
  tts_format: string | null;
  tts_sample_rate: number | null;
  last_health: string | null;
  last_latency_ms: number | null;
  last_error: string | null;
  last_checked_at: string | null;
  updated_at: string;
}

export interface ResolvedSpeechRuntimeConfig {
  kind: SpeechProviderKind;
  credentialMode: SpeechCredentialMode;
  linkedProviderId?: string;
  linkedProviderBaseUrl?: string;
  apiKey?: string;
  baseUrl?: string;
  dashscopeEndpointPreset?: DashScopeEndpointPreset;
  volcAuthMode: VolcengineAuthMode;
  volcAppId?: string;
  volcAccessToken?: string;
  volcAsrResourceId?: string;
  volcTtsResourceId?: string;
  asrModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: SpeechTtsFormat;
  ttsSampleRate?: number;
}

function isSpeechProviderKind(value: unknown): value is SpeechProviderKind {
  return (
    typeof value === "string" &&
    (SPEECH_PROVIDER_KINDS as readonly string[]).includes(value)
  );
}

function normalizeOptionalUrl(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SpeechError("INVALID_INPUT", "Base URL 格式不正确，需以 http:// 或 https:// 开头");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SpeechError("INVALID_INPUT", "Base URL 格式不正确，需以 http:// 或 https:// 开头");
  }
  return trimmed;
}

function normalizeOptionalString(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function normalizeCredentialMode(
  kind: SpeechProviderKind,
  raw: string | null | undefined
): SpeechCredentialMode {
  if (kind === "volcengine") return "custom";
  return raw === "linked_provider" ? "linked_provider" : "custom";
}

function normalizeDashScopePreset(raw: string | null | undefined): DashScopeEndpointPreset | undefined {
  if (
    raw === "payg-cn" ||
    raw === "payg-intl" ||
    raw === "token-plan-cn" ||
    raw === "token-plan-intl" ||
    raw === "custom"
  ) {
    return raw;
  }
  return undefined;
}

function normalizeVolcAuthMode(raw: string | null | undefined): VolcengineAuthMode {
  return raw === "api_key" ? "api_key" : "app_token";
}

function normalizeTtsFormat(raw: string | null | undefined): SpeechTtsFormat | undefined {
  if (raw === "wav" || raw === "mp3" || raw === "pcm") return raw;
  return undefined;
}

function rowToConfig(kind: SpeechProviderKind, row?: SpeechProviderRow): SpeechProviderConfig {
  const defaults = defaultSpeechProviderConfig(kind);
  if (!row) return defaults;

  const credentialMode = normalizeCredentialMode(kind, row.credential_mode);
  return {
    kind,
    enabled: row.enabled !== 0,
    credentialMode,
    ...(row.linked_provider_id ? { linkedProviderId: row.linked_provider_id } : {}),
    hasApiKey: Boolean(row.api_key_encrypted),
    ...(row.api_key_preview ? { apiKeyPreview: row.api_key_preview } : {}),
    baseUrl: row.base_url ?? defaults.baseUrl,
    ...(kind === "dashscope"
      ? {
          dashscopeEndpointPreset:
            normalizeDashScopePreset(row.dashscope_endpoint_preset) ??
            defaults.dashscopeEndpointPreset,
        }
      : {}),
    ...(kind === "volcengine"
      ? {
          volcAuthMode: normalizeVolcAuthMode(row.volc_auth_mode),
          ...(row.volc_app_id ? { volcAppId: row.volc_app_id } : {}),
          hasVolcAccessToken: Boolean(row.volc_access_token_encrypted),
          ...(row.volc_access_token_preview
            ? { volcAccessTokenPreview: row.volc_access_token_preview }
            : {}),
          volcAsrResourceId: row.volc_asr_resource_id ?? defaults.volcAsrResourceId,
          volcTtsResourceId: row.volc_tts_resource_id ?? defaults.volcTtsResourceId,
        }
      : {}),
    asrModel: row.asr_model ?? defaults.asrModel,
    ttsModel: row.tts_model ?? defaults.ttsModel,
    ttsVoice: row.tts_voice ?? defaults.ttsVoice,
    ttsFormat: normalizeTtsFormat(row.tts_format) ?? defaults.ttsFormat,
    ttsSampleRate:
      typeof row.tts_sample_rate === "number" && row.tts_sample_rate > 0
        ? row.tts_sample_rate
        : defaults.ttsSampleRate,
    lastHealth: (row.last_health as SpeechHealth | null) ?? "unknown",
    ...(row.last_latency_ms != null ? { lastLatencyMs: row.last_latency_ms } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
    updatedAt: row.updated_at,
  };
}

export function getSpeechPreferences(): SpeechPreferences {
  const raw = getSetting(SPEECH_PREFERENCES_KEY);
  if (!raw) return { ...DEFAULT_SPEECH_PREFERENCES };
  try {
    const parsed = JSON.parse(raw) as Partial<SpeechPreferences>;
    return {
      activeAsrProvider: isSpeechProviderKind(parsed.activeAsrProvider)
        ? parsed.activeAsrProvider
        : null,
      activeTtsProvider: isSpeechProviderKind(parsed.activeTtsProvider)
        ? parsed.activeTtsProvider
        : null,
      asrAfterTranscribe: parsed.asrAfterTranscribe === "send" ? "send" : "insert",
      asrInputDeviceId:
        typeof parsed.asrInputDeviceId === "string"
          ? parsed.asrInputDeviceId.trim()
          : "",
      ttsPlaybackRate: clampNumber(
        parsed.ttsPlaybackRate,
        DEFAULT_SPEECH_PREFERENCES.ttsPlaybackRate,
        0.5,
        2.0
      ),
      ttsStripCodeBlocks:
        typeof parsed.ttsStripCodeBlocks === "boolean"
          ? parsed.ttsStripCodeBlocks
          : DEFAULT_SPEECH_PREFERENCES.ttsStripCodeBlocks,
      ttsStripMarkdown:
        typeof parsed.ttsStripMarkdown === "boolean"
          ? parsed.ttsStripMarkdown
          : DEFAULT_SPEECH_PREFERENCES.ttsStripMarkdown,
      ttsMaxChunkChars: Math.round(
        clampNumber(
          parsed.ttsMaxChunkChars,
          DEFAULT_SPEECH_PREFERENCES.ttsMaxChunkChars,
          150,
          2000
        )
      ),
    };
  } catch {
    return { ...DEFAULT_SPEECH_PREFERENCES };
  }
}

export function saveSpeechPreferences(patch: Partial<SpeechPreferences>): SpeechPreferences {
  const current = getSpeechPreferences();
  const next: SpeechPreferences = {
    activeAsrProvider:
      patch.activeAsrProvider === null
        ? null
        : isSpeechProviderKind(patch.activeAsrProvider)
          ? patch.activeAsrProvider
          : current.activeAsrProvider,
    activeTtsProvider:
      patch.activeTtsProvider === null
        ? null
        : isSpeechProviderKind(patch.activeTtsProvider)
          ? patch.activeTtsProvider
          : current.activeTtsProvider,
    asrAfterTranscribe:
      patch.asrAfterTranscribe === "send" || patch.asrAfterTranscribe === "insert"
        ? patch.asrAfterTranscribe
        : current.asrAfterTranscribe,
    asrInputDeviceId:
      typeof patch.asrInputDeviceId === "string"
        ? patch.asrInputDeviceId.trim()
        : current.asrInputDeviceId ?? "",
    ttsPlaybackRate: clampNumber(
      patch.ttsPlaybackRate ?? current.ttsPlaybackRate,
      current.ttsPlaybackRate,
      0.5,
      2.0
    ),
    ttsStripCodeBlocks:
      typeof patch.ttsStripCodeBlocks === "boolean"
        ? patch.ttsStripCodeBlocks
        : current.ttsStripCodeBlocks,
    ttsStripMarkdown:
      typeof patch.ttsStripMarkdown === "boolean"
        ? patch.ttsStripMarkdown
        : current.ttsStripMarkdown,
    ttsMaxChunkChars: Math.round(
      clampNumber(
        patch.ttsMaxChunkChars ?? current.ttsMaxChunkChars,
        current.ttsMaxChunkChars,
        150,
        2000
      )
    ),
  };
  setSetting(SPEECH_PREFERENCES_KEY, JSON.stringify(next));
  return next;
}

export function getSpeechProvider(kind: SpeechProviderKind): SpeechProviderConfig {
  const row = getDb()
    .prepare("SELECT * FROM speech_providers WHERE kind = ?")
    .get(kind) as SpeechProviderRow | undefined;
  return rowToConfig(kind, row);
}

export function getSpeechConfig(): SpeechConfigSnapshot {
  const rows = getDb()
    .prepare("SELECT * FROM speech_providers")
    .all() as SpeechProviderRow[];
  const rowMap = new Map(rows.map((r) => [r.kind, r]));

  return {
    preferences: getSpeechPreferences(),
    providers: {
      deepseek: rowToConfig("deepseek", rowMap.get("deepseek")),
      dashscope: rowToConfig("dashscope", rowMap.get("dashscope")),
      volcengine: rowToConfig("volcengine", rowMap.get("volcengine")),
    },
  };
}

export function saveSpeechProvider(input: SpeechProviderConfigUpdate): SpeechProviderConfig {
  if (!isSpeechProviderKind(input.kind)) {
    throw new SpeechError("INVALID_INPUT", `Unsupported speech provider: ${String(input.kind)}`);
  }

  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM speech_providers WHERE kind = ?")
    .get(input.kind) as SpeechProviderRow | undefined;
  const defaults = defaultSpeechProviderConfig(input.kind);
  const now = new Date().toISOString();

  const credentialMode = normalizeCredentialMode(
    input.kind,
    input.credentialMode ?? existing?.credential_mode
  );
  const linkedProviderId =
    credentialMode === "linked_provider"
      ? (input.linkedProviderId === undefined
          ? existing?.linked_provider_id ?? null
          : normalizeOptionalString(input.linkedProviderId) ?? null)
      : null;

  let apiKeyEncrypted = existing?.api_key_encrypted ?? null;
  let apiKeyPreview = existing?.api_key_preview ?? null;
  if (input.clearApiKey) {
    apiKeyEncrypted = null;
    apiKeyPreview = null;
  } else if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    const trimmed = input.apiKey.trim();
    apiKeyEncrypted = encryptSecret(trimmed);
    apiKeyPreview = redactApiKey(trimmed);
  }

  let volcAccessTokenEncrypted = existing?.volc_access_token_encrypted ?? null;
  let volcAccessTokenPreview = existing?.volc_access_token_preview ?? null;
  if (input.clearVolcAccessToken) {
    volcAccessTokenEncrypted = null;
    volcAccessTokenPreview = null;
  } else if (typeof input.volcAccessToken === "string" && input.volcAccessToken.trim()) {
    const trimmed = input.volcAccessToken.trim();
    volcAccessTokenEncrypted = encryptSecret(trimmed);
    volcAccessTokenPreview = redactApiKey(trimmed);
  }

  const baseUrl =
    input.baseUrl === undefined
      ? existing?.base_url ?? defaults.baseUrl ?? null
      : normalizeOptionalUrl(input.baseUrl) ?? defaults.baseUrl ?? null;

  const dashscopeEndpointPreset =
    input.kind === "dashscope"
      ? (input.dashscopeEndpointPreset === undefined
          ? existing?.dashscope_endpoint_preset ?? defaults.dashscopeEndpointPreset ?? null
          : normalizeDashScopePreset(input.dashscopeEndpointPreset) ??
            defaults.dashscopeEndpointPreset ??
            null)
      : null;

  const volcAuthMode =
    input.kind === "volcengine"
      ? normalizeVolcAuthMode(input.volcAuthMode ?? existing?.volc_auth_mode)
      : null;
  const volcAppId =
    input.kind === "volcengine"
      ? (input.volcAppId === undefined
          ? existing?.volc_app_id ?? null
          : normalizeOptionalString(input.volcAppId) ?? null)
      : null;
  const volcAsrResourceId =
    input.kind === "volcengine"
      ? (input.volcAsrResourceId === undefined
          ? existing?.volc_asr_resource_id ?? defaults.volcAsrResourceId ?? null
          : normalizeOptionalString(input.volcAsrResourceId) ?? defaults.volcAsrResourceId ?? null)
      : null;
  const volcTtsResourceId =
    input.kind === "volcengine"
      ? (input.volcTtsResourceId === undefined
          ? existing?.volc_tts_resource_id ?? defaults.volcTtsResourceId ?? null
          : normalizeOptionalString(input.volcTtsResourceId) ?? defaults.volcTtsResourceId ?? null)
      : null;

  const asrModel =
    input.asrModel === undefined
      ? existing?.asr_model ?? defaults.asrModel ?? null
      : normalizeOptionalString(input.asrModel) ?? defaults.asrModel ?? null;
  const ttsModel =
    input.ttsModel === undefined
      ? existing?.tts_model ?? defaults.ttsModel ?? null
      : normalizeOptionalString(input.ttsModel) ?? defaults.ttsModel ?? null;
  const ttsVoice =
    input.ttsVoice === undefined
      ? existing?.tts_voice ?? defaults.ttsVoice ?? null
      : normalizeOptionalString(input.ttsVoice) ?? defaults.ttsVoice ?? null;
  const ttsFormat =
    input.ttsFormat === undefined
      ? existing?.tts_format ?? defaults.ttsFormat ?? null
      : normalizeTtsFormat(input.ttsFormat) ?? defaults.ttsFormat ?? null;
  const ttsSampleRate =
    input.ttsSampleRate === undefined
      ? existing?.tts_sample_rate ?? defaults.ttsSampleRate ?? null
      : typeof input.ttsSampleRate === "number" && input.ttsSampleRate > 0
        ? Math.round(input.ttsSampleRate)
        : defaults.ttsSampleRate ?? null;

  const enabled =
    input.enabled === undefined ? (existing ? existing.enabled : 1) : input.enabled ? 1 : 0;

  db.prepare(
    `INSERT INTO speech_providers (
      kind, enabled, credential_mode, linked_provider_id,
      api_key_encrypted, api_key_preview, base_url, dashscope_endpoint_preset,
      volc_auth_mode, volc_app_id, volc_access_token_encrypted, volc_access_token_preview,
      volc_asr_resource_id, volc_tts_resource_id,
      asr_model, tts_model, tts_voice, tts_format, tts_sample_rate, updated_at
    ) VALUES (
      @kind, @enabled, @credential_mode, @linked_provider_id,
      @api_key_encrypted, @api_key_preview, @base_url, @dashscope_endpoint_preset,
      @volc_auth_mode, @volc_app_id, @volc_access_token_encrypted, @volc_access_token_preview,
      @volc_asr_resource_id, @volc_tts_resource_id,
      @asr_model, @tts_model, @tts_voice, @tts_format, @tts_sample_rate, @updated_at
    )
    ON CONFLICT(kind) DO UPDATE SET
      enabled = excluded.enabled,
      credential_mode = excluded.credential_mode,
      linked_provider_id = excluded.linked_provider_id,
      api_key_encrypted = excluded.api_key_encrypted,
      api_key_preview = excluded.api_key_preview,
      base_url = excluded.base_url,
      dashscope_endpoint_preset = excluded.dashscope_endpoint_preset,
      volc_auth_mode = excluded.volc_auth_mode,
      volc_app_id = excluded.volc_app_id,
      volc_access_token_encrypted = excluded.volc_access_token_encrypted,
      volc_access_token_preview = excluded.volc_access_token_preview,
      volc_asr_resource_id = excluded.volc_asr_resource_id,
      volc_tts_resource_id = excluded.volc_tts_resource_id,
      asr_model = excluded.asr_model,
      tts_model = excluded.tts_model,
      tts_voice = excluded.tts_voice,
      tts_format = excluded.tts_format,
      tts_sample_rate = excluded.tts_sample_rate,
      updated_at = excluded.updated_at`
  ).run({
    kind: input.kind,
    enabled,
    credential_mode: credentialMode,
    linked_provider_id: linkedProviderId,
    api_key_encrypted: apiKeyEncrypted,
    api_key_preview: apiKeyPreview,
    base_url: baseUrl,
    dashscope_endpoint_preset: dashscopeEndpointPreset,
    volc_auth_mode: volcAuthMode,
    volc_app_id: volcAppId,
    volc_access_token_encrypted: volcAccessTokenEncrypted,
    volc_access_token_preview: volcAccessTokenPreview,
    volc_asr_resource_id: volcAsrResourceId,
    volc_tts_resource_id: volcTtsResourceId,
    asr_model: asrModel,
    tts_model: ttsModel,
    tts_voice: ttsVoice,
    tts_format: ttsFormat,
    tts_sample_rate: ttsSampleRate,
    updated_at: now,
  });

  return getSpeechProvider(input.kind);
}

export function recordSpeechProviderHealth(
  kind: SpeechProviderKind,
  health: { ok: boolean; latencyMs?: number; error?: string }
): void {
  const existing = getDb()
    .prepare("SELECT kind FROM speech_providers WHERE kind = ?")
    .get(kind) as { kind: string } | undefined;
  if (!existing) return;

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE speech_providers
       SET last_health = ?, last_latency_ms = ?, last_error = ?, last_checked_at = ?, updated_at = ?
       WHERE kind = ?`
    )
    .run(
      health.ok ? "ok" : "error",
      health.latencyMs ?? null,
      health.error ?? null,
      now,
      now,
      kind
    );
}

/**
 * Resolves plaintext credentials strictly inside Electron main process.
 * Never returns these secrets over IPC.
 */
export function resolveSpeechRuntimeConfig(
  kind: SpeechProviderKind,
  draftOverride?: SpeechProviderConfigUpdate
): ResolvedSpeechRuntimeConfig {
  if (!isSpeechProviderKind(kind)) {
    throw new SpeechError("INVALID_INPUT", `Unsupported speech provider: ${String(kind)}`);
  }

  const row = getDb()
    .prepare("SELECT * FROM speech_providers WHERE kind = ?")
    .get(kind) as SpeechProviderRow | undefined;
  const saved = rowToConfig(kind, row);

  const credentialMode = normalizeCredentialMode(
    kind,
    draftOverride?.credentialMode ?? saved.credentialMode
  );
  const linkedProviderId =
    credentialMode === "linked_provider"
      ? (draftOverride?.linkedProviderId !== undefined
          ? normalizeOptionalString(draftOverride.linkedProviderId)
          : saved.linkedProviderId)
      : undefined;

  const baseUrl =
    draftOverride?.baseUrl !== undefined
      ? normalizeOptionalUrl(draftOverride.baseUrl) ?? saved.baseUrl
      : saved.baseUrl;

  const dashscopeEndpointPreset =
    kind === "dashscope"
      ? (draftOverride?.dashscopeEndpointPreset !== undefined
          ? normalizeDashScopePreset(draftOverride.dashscopeEndpointPreset) ??
            saved.dashscopeEndpointPreset
          : saved.dashscopeEndpointPreset)
      : undefined;

  const volcAuthMode = normalizeVolcAuthMode(draftOverride?.volcAuthMode ?? saved.volcAuthMode);
  const volcAppId =
    draftOverride?.volcAppId !== undefined
      ? normalizeOptionalString(draftOverride.volcAppId)
      : saved.volcAppId;
  const volcAsrResourceId =
    draftOverride?.volcAsrResourceId !== undefined
      ? normalizeOptionalString(draftOverride.volcAsrResourceId) ?? saved.volcAsrResourceId
      : saved.volcAsrResourceId;
  const volcTtsResourceId =
    draftOverride?.volcTtsResourceId !== undefined
      ? normalizeOptionalString(draftOverride.volcTtsResourceId) ?? saved.volcTtsResourceId
      : saved.volcTtsResourceId;

  const asrModel =
    draftOverride?.asrModel !== undefined
      ? normalizeOptionalString(draftOverride.asrModel) ?? saved.asrModel
      : saved.asrModel;
  const ttsModel =
    draftOverride?.ttsModel !== undefined
      ? normalizeOptionalString(draftOverride.ttsModel) ?? saved.ttsModel
      : saved.ttsModel;
  const ttsVoice =
    draftOverride?.ttsVoice !== undefined
      ? normalizeOptionalString(draftOverride.ttsVoice) ?? saved.ttsVoice
      : saved.ttsVoice;
  const ttsFormat =
    draftOverride?.ttsFormat !== undefined
      ? normalizeTtsFormat(draftOverride.ttsFormat) ?? saved.ttsFormat
      : saved.ttsFormat;
  const ttsSampleRate =
    typeof draftOverride?.ttsSampleRate === "number" && draftOverride.ttsSampleRate > 0
      ? Math.round(draftOverride.ttsSampleRate)
      : saved.ttsSampleRate;

  let apiKey: string | undefined;
  let linkedProviderBaseUrl: string | undefined;

  if (credentialMode === "linked_provider") {
    if (!linkedProviderId) {
      throw new SpeechError("NOT_CONFIGURED", "请先选择要复用的模型服务商", {
        provider: kind,
      });
    }
    const provider = getProvider(linkedProviderId);
    if (!provider || !provider.enabled) {
      throw new SpeechError("INVALID_CREDENTIALS", "关联的模型服务商不存在或已停用", {
        provider: kind,
      });
    }
    const linkedKey = getProviderApiKey(linkedProviderId)?.trim();
    if (!linkedKey) {
      throw new SpeechError("INVALID_CREDENTIALS", "关联的模型服务商尚未填写 API Key", {
        provider: kind,
      });
    }
    apiKey = linkedKey;
    linkedProviderBaseUrl = provider.baseUrl;
  } else {
    if (draftOverride?.clearApiKey) {
      apiKey = undefined;
    } else if (typeof draftOverride?.apiKey === "string" && draftOverride.apiKey.trim()) {
      apiKey = draftOverride.apiKey.trim();
    } else {
      apiKey = decryptSecret(row?.api_key_encrypted ?? undefined)?.trim() || undefined;
    }
  }

  let volcAccessToken: string | undefined;
  if (kind === "volcengine") {
    if (draftOverride?.clearVolcAccessToken) {
      volcAccessToken = undefined;
    } else if (
      typeof draftOverride?.volcAccessToken === "string" &&
      draftOverride.volcAccessToken.trim()
    ) {
      volcAccessToken = draftOverride.volcAccessToken.trim();
    } else {
      volcAccessToken =
        decryptSecret(row?.volc_access_token_encrypted ?? undefined)?.trim() || undefined;
    }

    if (volcAuthMode === "api_key") {
      if (!apiKey) {
        throw new SpeechError("NOT_CONFIGURED", "请先填写火山引擎语音 API Key", {
          provider: kind,
        });
      }
    } else if (!volcAppId || !volcAccessToken) {
      throw new SpeechError(
        "NOT_CONFIGURED",
        "请先填写火山引擎智能语音控制台的 App ID 和 Access Token",
        { provider: kind }
      );
    }
  } else if (!apiKey) {
    throw new SpeechError(
      "NOT_CONFIGURED",
      kind === "deepseek"
        ? "请先配置 DeepSeek API Key 或关联已有 DeepSeek 服务商"
        : "请先配置阿里云百炼 API Key 或关联已有百炼服务商",
      { provider: kind }
    );
  }

  return {
    kind,
    credentialMode,
    linkedProviderId,
    linkedProviderBaseUrl,
    apiKey,
    baseUrl,
    dashscopeEndpointPreset,
    volcAuthMode,
    volcAppId,
    volcAccessToken,
    volcAsrResourceId,
    volcTtsResourceId,
    asrModel,
    ttsModel,
    ttsVoice,
    ttsFormat,
    ttsSampleRate,
  };
}
