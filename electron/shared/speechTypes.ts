export type SpeechProviderKind = "deepseek" | "dashscope" | "volcengine";

export type SpeechCredentialMode = "custom" | "linked_provider";

export type DashScopeEndpointPreset =
  | "payg-cn"
  | "payg-intl"
  | "token-plan-cn"
  | "token-plan-intl"
  | "custom";

export type VolcengineAuthMode = "app_token" | "api_key";

export type SpeechErrorCode =
  | "NOT_CONFIGURED"
  | "INVALID_CREDENTIALS"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "AUDIO_TOO_LARGE"
  | "TEXT_TOO_LONG"
  | "TIMEOUT"
  | "CANCELLED"
  | "NETWORK_ERROR"
  | "PROVIDER_ERROR"
  | "INVALID_INPUT";

export class SpeechError extends Error {
  readonly code: SpeechErrorCode;
  readonly provider?: SpeechProviderKind;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    code: SpeechErrorCode,
    message: string,
    options?: {
      provider?: SpeechProviderKind;
      status?: number;
      retryable?: boolean;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SpeechError";
    this.code = code;
    this.provider = options?.provider;
    this.status = options?.status;
    this.retryable = options?.retryable ?? (code === "TIMEOUT" || code === "RATE_LIMITED" || code === "NETWORK_ERROR");
  }
}

export type SpeechHealth = "unknown" | "ok" | "error";

export type SpeechTtsFormat = "wav" | "mp3" | "pcm";

/** Sanitized configuration persisted in DB and exposed to the renderer. Never carries plaintext secrets. */
export interface SpeechProviderConfig {
  kind: SpeechProviderKind;
  enabled: boolean;
  credentialMode: SpeechCredentialMode;
  linkedProviderId?: string;
  hasApiKey: boolean;
  apiKeyPreview?: string;
  baseUrl?: string;
  dashscopeEndpointPreset?: DashScopeEndpointPreset;
  volcAuthMode?: VolcengineAuthMode;
  volcAppId?: string;
  hasVolcAccessToken?: boolean;
  volcAccessTokenPreview?: string;
  volcAsrResourceId?: string;
  volcTtsResourceId?: string;
  asrModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: SpeechTtsFormat;
  ttsSampleRate?: number;
  lastHealth?: SpeechHealth;
  lastLatencyMs?: number;
  lastError?: string;
  lastCheckedAt?: string;
  updatedAt?: string;
}

export interface SpeechProviderConfigUpdate {
  kind: SpeechProviderKind;
  enabled?: boolean;
  credentialMode?: SpeechCredentialMode;
  linkedProviderId?: string | null;
  apiKey?: string;
  clearApiKey?: boolean;
  baseUrl?: string | null;
  dashscopeEndpointPreset?: DashScopeEndpointPreset | null;
  volcAuthMode?: VolcengineAuthMode | null;
  volcAppId?: string | null;
  volcAccessToken?: string;
  clearVolcAccessToken?: boolean;
  volcAsrResourceId?: string | null;
  volcTtsResourceId?: string | null;
  asrModel?: string | null;
  ttsModel?: string | null;
  ttsVoice?: string | null;
  ttsFormat?: SpeechTtsFormat | null;
  ttsSampleRate?: number | null;
}

export interface SpeechPreferences {
  activeAsrProvider: SpeechProviderKind | null;
  activeTtsProvider: SpeechProviderKind | null;
  asrAfterTranscribe: "insert" | "send";
  ttsPlaybackRate: number;
  ttsStripCodeBlocks: boolean;
  ttsStripMarkdown: boolean;
  ttsMaxChunkChars: number;
}

export interface SpeechConfigSnapshot {
  preferences: SpeechPreferences;
  providers: Record<SpeechProviderKind, SpeechProviderConfig>;
}

export interface SpeechTranscribeRequest {
  requestId?: string;
  audio: Uint8Array;
  mimeType?: string;
  provider?: SpeechProviderKind;
  language?: string;
}

export interface SpeechTranscribeResult {
  text: string;
  durationMs?: number;
  provider: SpeechProviderKind;
  latencyMs: number;
}

export interface SpeechSynthesizeRequest {
  requestId?: string;
  text: string;
  provider?: SpeechProviderKind;
  voice?: string;
  model?: string;
  stripMarkdown?: boolean;
  stripCodeBlocks?: boolean;
  skipCache?: boolean;
}

export interface SpeechSynthesizeResult {
  audio: Uint8Array;
  mimeType: string;
  provider: SpeechProviderKind;
  latencyMs: number;
  cached?: boolean;
}

export interface SpeechTestRequest {
  kind: SpeechProviderKind;
  target: "tts" | "asr" | "both";
  draft?: SpeechProviderConfigUpdate;
  sampleText?: string;
}

export interface SpeechTestDetail {
  ok: boolean;
  error?: string;
  latencyMs: number;
}

export interface SpeechTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  checkedAt: string;
  audio?: Uint8Array;
  mimeType?: string;
  details?: {
    tts?: SpeechTestDetail;
    asr?: SpeechTestDetail;
  };
}

export interface SpeechMicrophoneStatus {
  platform: string;
  status: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
}

export interface SpeechMicrophoneRequestResult {
  granted: boolean;
  status: SpeechMicrophoneStatus["status"];
}
