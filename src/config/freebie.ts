import providersSnapshot from "../../sites/freebie/providers.json";
import {
  parseHttpsUrl,
  validateFreebiePreset,
  type FreebieProviderPreset
} from "@/services/freebie/protocol";

/**
 * Public URL of the externally hosted freebie page (Cloudflare Pages). Override
 * with `VITE_FREEBIE_PAGE_URL` (e.g. `http://localhost:8788/`) while developing
 * the page locally; only https and loopback http origins are accepted.
 */
const DEFAULT_FREEBIE_PAGE_URL = "https://freebuddy-freebie.pages.dev/";

function resolvePageUrl(): URL {
  const configured = import.meta.env?.VITE_FREEBIE_PAGE_URL as string | undefined;
  const parsed = parseHttpsUrl(configured) ?? parseHttpsUrl(DEFAULT_FREEBIE_PAGE_URL);
  if (!parsed) throw new Error("invalid freebie page URL");
  return parsed;
}

export const FREEBIE_PAGE_URL = resolvePageUrl();

/** The only origin FreeBuddy accepts bridge messages from. */
export const FREEBIE_PAGE_ORIGIN = FREEBIE_PAGE_URL.origin;

/** Time the page has to complete the `ready` handshake before the bundled fallback is shown. */
export const FREEBIE_HANDSHAKE_TIMEOUT_MS = 8000;

export function buildFreebieEmbedUrl(params: {
  locale: string;
  theme: "light" | "dark";
}): string {
  const url = new URL(FREEBIE_PAGE_URL.toString());
  url.searchParams.set("embed", "1");
  url.searchParams.set("lang", params.locale);
  url.searchParams.set("theme", params.theme);
  return url.toString();
}

/**
 * Snapshot of the provider catalog bundled with this build. Used when the
 * remote page cannot be reached so the feature degrades to "slightly stale"
 * instead of "blank". Entries that fail validation are dropped so a bad JSON
 * edit cannot break the app.
 */
export const FREEBIE_BUNDLED_PROVIDERS: FreebieProviderPreset[] = (() => {
  const raw = (providersSnapshot as { providers?: unknown[] }).providers ?? [];
  const out: FreebieProviderPreset[] = [];
  for (const entry of raw) {
    const result = validateFreebiePreset(entry);
    if (result.ok) out.push(result.value);
  }
  return out;
})();

export const FREEBIE_BUNDLED_UPDATED_AT: string | undefined = (
  providersSnapshot as { updatedAt?: string }
).updatedAt;
