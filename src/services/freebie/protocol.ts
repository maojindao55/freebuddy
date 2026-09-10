/**
 * postMessage protocol between FreeBuddy and the externally hosted "freebie"
 * (free-tier providers) page. The page is remote content that can change
 * without an app release, so every inbound payload is treated as untrusted and
 * re-validated here before it reaches any store.
 *
 * Secrets never cross this bridge: the page sends provider presets only and the
 * API key is typed into a native FreeBuddy dialog.
 */

export const FREEBIE_BRIDGE_SOURCE = "freebuddy-freebie";
export const FREEBIE_PROTOCOL_VERSION = 1;

export const FREEBIE_PROTOCOLS = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "deepseek"
] as const;
export type FreebieProtocol = (typeof FREEBIE_PROTOCOLS)[number];

export type FreebieRegion = "cn" | "global";

export interface FreebieModel {
  id: string;
  name?: string;
  contextWindow?: number;
  supportsVision?: boolean;
}

export interface FreebieProviderPreset {
  /** Stable slug, e.g. `zhipu`. Used to detect "already imported". */
  id: string;
  name: string;
  region?: FreebieRegion;
  homepage?: string;
  /** Where the user obtains an API key. */
  consoleUrl?: string;
  /** Localized one-line summary of the free tier, keyed by locale (`zh-CN`, `en`). */
  freeTierSummary?: Record<string, string>;
  protocol: FreebieProtocol;
  /** HTTPS API base URL the agent will talk to. */
  baseUrl: string;
  /** Environment variable the base adapter reads the key from. */
  envKey?: string;
  models: FreebieModel[];
  contextWindow?: number;
  /** ISO date when the free-tier information was last verified. */
  verifiedAt?: string;
}

export interface FreebieRuntimeState {
  codex: boolean;
  claude: boolean;
  deepseek: boolean;
}

export interface FreebieHostState {
  importedProviderIds: string[];
  runtimes: FreebieRuntimeState;
}

/** Messages the page sends to FreeBuddy. */
export type FreebiePageMessage =
  | { type: "ready" }
  | { type: "importAgent"; requestId: string; preset: FreebieProviderPreset }
  | { type: "openExternal"; url: string }
  | { type: "getState"; requestId: string };

/** Messages FreeBuddy sends to the page. */
export type FreebieHostMessage =
  | ({
      type: "hello";
      locale: string;
      theme: "light" | "dark";
      platform: string;
    } & FreebieHostState)
  | { type: "result"; requestId: string; ok: true; agentId: string }
  | { type: "result"; requestId: string; ok: false; error: string }
  | ({ type: "state" } & FreebieHostState);

export type FreebieEnvelope<T> = T & {
  source: typeof FREEBIE_BRIDGE_SOURCE;
  protocolVersion: typeof FREEBIE_PROTOCOL_VERSION;
};

export function wrapHostMessage(message: FreebieHostMessage): FreebieEnvelope<FreebieHostMessage> {
  return {
    source: FREEBIE_BRIDGE_SOURCE,
    protocolVersion: FREEBIE_PROTOCOL_VERSION,
    ...message
  };
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MODELS = 50;
const MAX_NAME_LENGTH = 80;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 400;

type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}

/**
 * Accepts only absolute https URLs without embedded credentials. `http` is
 * allowed for loopback hosts so the page can be developed against a local
 * mock provider.
 */
export function parseHttpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return url;
  }
  return null;
}

function validateModel(input: unknown): FreebieModel | null {
  if (!isRecord(input)) return null;
  const id = optionalString(input.id, MAX_MODEL_ID_LENGTH);
  if (!id) return null;
  const model: FreebieModel = { id };
  const name = optionalString(input.name, MAX_NAME_LENGTH);
  if (name) model.name = name;
  const contextWindow = optionalPositiveInt(input.contextWindow);
  if (contextWindow) model.contextWindow = contextWindow;
  if (input.supportsVision === true) model.supportsVision = true;
  return model;
}

function validateSummary(input: unknown): Record<string, string> | undefined {
  if (!isRecord(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [locale, text] of Object.entries(input)) {
    if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(locale)) continue;
    const value = optionalString(text, MAX_SUMMARY_LENGTH);
    if (value) out[locale] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Validates an untrusted preset and returns a sanitized copy containing only
 * known fields. Unknown fields are dropped rather than rejected so the page can
 * evolve its JSON ahead of the app.
 */
export function validateFreebiePreset(input: unknown): Validation<FreebieProviderPreset> {
  if (!isRecord(input)) return { ok: false, error: "preset must be an object" };

  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!SLUG_PATTERN.test(id)) return { ok: false, error: "invalid provider id" };

  const name = optionalString(input.name, MAX_NAME_LENGTH);
  if (!name) return { ok: false, error: "invalid provider name" };

  const protocol = input.protocol;
  if (!FREEBIE_PROTOCOLS.includes(protocol as FreebieProtocol)) {
    return { ok: false, error: "unsupported protocol" };
  }

  const baseUrl = parseHttpsUrl(input.baseUrl);
  if (!baseUrl) return { ok: false, error: "baseUrl must be an https URL" };

  if (!Array.isArray(input.models) || input.models.length === 0) {
    return { ok: false, error: "models must be a non-empty array" };
  }
  const models: FreebieModel[] = [];
  const seen = new Set<string>();
  for (const raw of input.models.slice(0, MAX_MODELS)) {
    const model = validateModel(raw);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (!models.length) return { ok: false, error: "models must contain at least one valid id" };

  const preset: FreebieProviderPreset = {
    id,
    name,
    protocol: protocol as FreebieProtocol,
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    models
  };

  if (input.region === "cn" || input.region === "global") preset.region = input.region;

  const homepage = parseHttpsUrl(input.homepage);
  if (homepage) preset.homepage = homepage.toString();
  const consoleUrl = parseHttpsUrl(input.consoleUrl);
  if (consoleUrl) preset.consoleUrl = consoleUrl.toString();

  const summary = validateSummary(input.freeTierSummary);
  if (summary) preset.freeTierSummary = summary;

  if (typeof input.envKey === "string" && ENV_KEY_PATTERN.test(input.envKey.trim())) {
    preset.envKey = input.envKey.trim();
  }

  const contextWindow = optionalPositiveInt(input.contextWindow);
  if (contextWindow) preset.contextWindow = contextWindow;

  if (typeof input.verifiedAt === "string" && ISO_DATE_PATTERN.test(input.verifiedAt)) {
    preset.verifiedAt = input.verifiedAt;
  }

  return { ok: true, value: preset };
}

/**
 * Parses a raw `message` event payload from the page. Returns `null` for
 * anything that is not a well-formed v1 bridge message so callers can ignore
 * unrelated postMessage traffic silently.
 */
export function parseFreebiePageMessage(data: unknown): Validation<FreebiePageMessage> | null {
  if (!isRecord(data)) return null;
  if (data.source !== FREEBIE_BRIDGE_SOURCE) return null;
  if (data.protocolVersion !== FREEBIE_PROTOCOL_VERSION) {
    return { ok: false, error: "unsupported protocol version" };
  }
  switch (data.type) {
    case "ready":
      return { ok: true, value: { type: "ready" } };
    case "getState": {
      const requestId = optionalString(data.requestId, 128);
      if (!requestId) return { ok: false, error: "missing requestId" };
      return { ok: true, value: { type: "getState", requestId } };
    }
    case "openExternal": {
      const url = parseHttpsUrl(data.url);
      if (!url) return { ok: false, error: "openExternal requires an https URL" };
      return { ok: true, value: { type: "openExternal", url: url.toString() } };
    }
    case "importAgent": {
      const requestId = optionalString(data.requestId, 128);
      if (!requestId) return { ok: false, error: "missing requestId" };
      const preset = validateFreebiePreset(data.preset);
      if (!preset.ok) return preset;
      return { ok: true, value: { type: "importAgent", requestId, preset: preset.value } };
    }
    default:
      return { ok: false, error: "unknown message type" };
  }
}

/** Picks the best summary text for a UI locale, falling back to English then any. */
export function pickFreebieSummary(
  summary: Record<string, string> | undefined,
  locale: string
): string | undefined {
  if (!summary) return undefined;
  if (summary[locale]) return summary[locale];
  const lang = locale.split("-")[0];
  const byLang = Object.keys(summary).find((key) => key.split("-")[0] === lang);
  if (byLang) return summary[byLang];
  return summary.en ?? Object.values(summary)[0];
}
