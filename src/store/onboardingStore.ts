/**
 * First-run onboarding state.
 *
 * Decision table (evaluated once per launch, after stores load):
 *   1. user already configured a provider  → never show (silent dismiss)
 *   2. state already resolved (done/skipped) → never show
 *   3. otherwise                            → show the welcome overlay
 *
 * "done"  = user activated the trial token, or finished the DIY path
 * "skipped" = user dismissed the overlay
 */

import { create } from "zustand";

import {
  ONBOARDING_STATE_SETTING_KEY,
  type OnboardingState
} from "@/config/onboarding";
import { cliClient } from "@/services/cli/client";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useProviderStore } from "@/store/providerStore";

interface OnboardingStoreState {
  /** null until the first evaluation completes. */
  resolved: OnboardingState | null;
  open: boolean;
  evaluating: boolean;
  /** Begin the first-run evaluation. Safe to call multiple times. */
  evaluate(): Promise<void>;
  /** Show the overlay again (Settings -> Agent management -> restart). */
  restart(): void;
  close(): void;
  markDone(): Promise<void>;
  markSkipped(): Promise<void>;
}

async function readStoredState(): Promise<OnboardingState | null> {
  if (!cliClient.isAvailable()) return null;
  try {
    const raw = await cliClient.getSetting(ONBOARDING_STATE_SETTING_KEY);
    return raw === "done" || raw === "skipped" ? raw : null;
  } catch {
    return null;
  }
}

async function writeStoredState(state: OnboardingState): Promise<void> {
  if (!cliClient.isAvailable()) return;
  try {
    await cliClient.setSetting(ONBOARDING_STATE_SETTING_KEY, state);
  } catch {
    /* best-effort: a failed write only re-shows the overlay next launch */
  }
}

/** True when the user already has model access configured. */
function hasConfiguredModelAccess(): boolean {
  const providers = useProviderStore.getState().providers;
  if (providers.some((p) => p.enabled)) return true;
  const overrides = useCliExecutorStore.getState().overrides;
  return Object.values(overrides).some(
    (o) =>
      o.codexByok?.enabled ||
      o.claudeByok?.enabled ||
      o.deepseekByok?.enabled ||
      o.piByok?.enabled
  );
}

let evaluateStarted = false;

export const useOnboardingStore = create<OnboardingStoreState>((set, get) => ({
  resolved: null,
  open: false,
  evaluating: false,

  async evaluate() {
    if (evaluateStarted) return;
    evaluateStarted = true;
    set({ evaluating: true });
    try {
      const stored = await readStoredState();
      if (stored) {
        set({ resolved: stored, open: false });
        return;
      }
      if (hasConfiguredModelAccess()) {
        // Existing install (or the user already set things up): never nag.
        await writeStoredState("done");
        set({ resolved: "done", open: false });
        return;
      }
      set({ resolved: "pending", open: true });
    } finally {
      set({ evaluating: false });
    }
  },

  restart() {
    set({ resolved: "pending", open: true });
  },

  close() {
    set({ open: false });
  },

  async markDone() {
    await writeStoredState("done");
    set({ resolved: "done", open: false });
  },

  async markSkipped() {
    await writeStoredState("skipped");
    set({ resolved: "skipped", open: false });
  }
}));

/** Test/telemetry helper: whether the overlay should be visible right now. */
export function shouldShowOnboarding(): boolean {
  const state = useOnboardingStore.getState();
  return state.resolved === "pending" && state.open;
}
