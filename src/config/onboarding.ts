/**
 * Onboarding (first-run guide) feature constants.
 *
 * The guide gateway is the Cloudflare Worker that mints short-lived trial
 * tokens for the built-in pi runtime (PR2/PR3 of the onboarding feature).
 * Keep the URL configurable so the same build works before/after deployment.
 */

export const ONBOARDING_STATE_SETTING_KEY = "onboarding.state.v1";
export type OnboardingState = "pending" | "done" | "skipped";

export const GUIDE_GATEWAY_URL =
  "https://freebuddy-freebie.binbinzhaili.workers.dev";

/** Path on the gateway that exchanges a device id for a trial token. */
export const GUIDE_GATEWAY_ACTIVATE_PATH = "/api/v1/auth/device";

export interface GuideTrialActivation {
  /** Trial bearer token — stored as the provider instance's API key. */
  token: string;
  /** Gateway base URL the token is valid against (OpenAI-compatible). */
  baseUrl: string;
  /** Env/selector name the token is presented under. */
  envKey: string;
  /** Whitelisted models the trial may use. */
  models: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    supportsVision?: boolean;
  }>;
  /** Seconds until the token expires (informational UI). */
  expiresInSeconds?: number;
}

/**
 * Built-in fallback trial activation for mainland China / offline / gateway down.
 * Backed by the project's dedicated New-API relay service.
 */
export const DEFAULT_GUIDE_FALLBACK_ACTIVATION: GuideTrialActivation = {
  token: "sk-oC77RLyVT8a72hZrghhpszKjD2u2R3gWY7DHxMcBKrJ97XA6",
  baseUrl: "http://106.13.104.125:3000/v1",
  envKey: "FREEBUDDY_GUIDE_TOKEN",
  models: [
    { id: "auto", name: "Auto (dots3-note-prev)", contextWindow: 128000 },
    { id: "dots3-note-prev", name: "dots3-note-prev", contextWindow: 128000 }
  ],
  expiresInSeconds: 172800
};


