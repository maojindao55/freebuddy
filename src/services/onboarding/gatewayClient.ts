/**
 * Client for the FreeBuddy guide gateway (Cloudflare Worker).
 *
 * The gateway holds real provider keys server-side and issues short-lived,
 * quota-bound trial tokens to FreeBuddy devices. The client never sees a
 * shared upstream key; the returned token is stored like any user key
 * (safeStorage-encrypted via the providers table).
 */

import {
  DEFAULT_GUIDE_FALLBACK_ACTIVATION,
  GUIDE_GATEWAY_ACTIVATE_PATH,
  GUIDE_GATEWAY_URL,
  type GuideTrialActivation
} from "@/config/onboarding";
import { getOrCreateDeviceId } from "@/services/freebie/communityClient";

export type { GuideTrialActivation };

export class GatewayUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayUnavailableError";
  }
}

export async function activateGuideTrial(
  signal?: AbortSignal
): Promise<GuideTrialActivation> {
  const deviceId = getOrCreateDeviceId();
  const url = new URL(GUIDE_GATEWAY_ACTIVATE_PATH, GUIDE_GATEWAY_URL).toString();

  // Short timeout (3.5s) to avoid hanging when gateway is blocked or slow
  const timeoutCtrl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtrl.abort(), 3500);

  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutCtrl.signal])
    : timeoutCtrl.signal;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FreeBuddy-Device-Id": deviceId
      },
      body: JSON.stringify({ deviceId, client: "freebuddy" }),
      signal: combinedSignal
    });

    if (response.ok) {
      const data = (await response.json()) as Partial<GuideTrialActivation> & {
        ok?: boolean;
      };
      if (data?.token && data?.baseUrl) {
        return {
          token: data.token,
          baseUrl: data.baseUrl,
          envKey: data.envKey || "FREEBUDDY_GUIDE_TOKEN",
          models: Array.isArray(data.models) ? data.models : [],
          expiresInSeconds: data.expiresInSeconds
        };
      }
    }
    console.warn(`[guideGateway] gateway status ${response.status}, falling back to built-in trial endpoint`);
  } catch (err) {
    console.warn(
      "[guideGateway] gateway unreachable, falling back to built-in trial endpoint:",
      (err as Error)?.message || err
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // Gracefully fallback to built-in trial activation to guarantee zero-fail onboarding
  return { ...DEFAULT_GUIDE_FALLBACK_ACTIVATION };
}

