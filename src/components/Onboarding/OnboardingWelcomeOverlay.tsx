/**
 * First-run welcome overlay (onboarding step 1).
 *
 * Deliberately model-free: on a brand-new install the user has neither a CLI
 * agent nor an API key, so the first card must render from local i18n strings
 * only. Every action here either configures something locally or deep-links
 * into Settings.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, LoaderCircle, Sparkles, X } from "lucide-react";

import piLogoUrl from "../../../assets/pi-logo.svg";
import { ONBOARDING_GUIDE_AGENT_ID } from "@/config/agentProfiles";
import { GUIDE_GATEWAY_URL } from "@/config/onboarding";
import { activateGuideTrial } from "@/services/onboarding/gatewayClient";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useConversationStore } from "@/store/conversationStore";
import { useOnboardingStore } from "@/store/onboardingStore";
import { useProviderStore } from "@/store/providerStore";

export function OnboardingWelcomeOverlay({
  onOpenSettings
}: {
  onOpenSettings: (tab: "providers" | "cli") => void;
}) {
  const { t } = useTranslation();
  const open = useOnboardingStore((s) => s.open);
  const markStarted = useOnboardingStore((s) => s.markStarted);
  const markSkipped = useOnboardingStore((s) => s.markSkipped);
  const upsertProvider = useProviderStore((s) => s.upsert);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void markSkipped();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, markSkipped]);

  if (!open) return null;

  const handleTrial = async () => {
    setBusy(true);
    setError("");
    try {
      const existingGuideProvider = useProviderStore
        .getState()
        .providers.find((p) => p.presetId === "freebuddy-guide");
      const trial = await activateGuideTrial();
      const provider = await upsertProvider({
        id: existingGuideProvider?.id,
        presetId: "freebuddy-guide",
        name: t("onboarding.trialProviderName"),
        protocol: "openai-chat",
        baseUrl: trial.baseUrl,
        envKey: trial.envKey,
        icon: "lobehub:Pi",
        models: trial.models.length
          ? trial.models
          : [{ id: "auto", name: t("onboarding.trialProviderName") }],
        enabled: true,
        apiKey: trial.token
      });

      // Bind pi-acp adapter to the newly provisioned trial provider
      const executorStore = useCliExecutorStore.getState();
      const existingPiOverride = executorStore.overrides["pi-acp"];
      await executorStore.upsertOverride({
        ...existingPiOverride,
        id: "pi-acp",
        baseAdapter: "pi-acp",
        piByok: {
          enabled: true,
          providerId: provider.id,
          envKey: trial.envKey || "FREEBUDDY_GUIDE_TOKEN",
          models: trial.models
        },
        enabled: true
      });

      // Start fresh GuideBuddy conversation
      const convStore = useConversationStore.getState();
      const guideMember = convStore.members.find(
        (m) => m.id === ONBOARDING_GUIDE_AGENT_ID
      );
      if (guideMember) {
        await convStore.newConversation({
          member: guideMember,
          title: guideMember.name
        });
      }

      await markStarted();
    } catch (err) {
      setError(
        t("onboarding.trialFailed", {
          error: (err as Error)?.message || String(err)
        })
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        tabIndex={-1}
      >
        <button
          type="button"
          className="onboarding-close"
          aria-label={t("onboarding.skip")}
          onClick={() => void markSkipped()}
        >
          <X size={16} />
        </button>

        <div className="onboarding-hero">
          <img src={piLogoUrl} alt="" className="onboarding-hero-logo" />
          <h2 id="onboarding-title">{t("onboarding.title")}</h2>
          <p className="onboarding-subtitle">{t("onboarding.subtitle")}</p>
        </div>

        <div className="onboarding-actions">
          <button
            type="button"
            className="onboarding-action onboarding-action--primary"
            disabled={busy}
            onClick={() => void handleTrial()}
          >
            <span className="onboarding-action-icon">
              {busy ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}
            </span>
            <span className="onboarding-action-copy">
              <strong>{busy ? t("onboarding.trialLoading") : t("onboarding.trial")}</strong>
              <span>{t("onboarding.trialHint")}</span>
            </span>
            <ArrowRight size={16} />
          </button>
        </div>

        {error ? (
          <p className="onboarding-error">
            {error}
            <span className="onboarding-error-hint">{t("onboarding.trialFallback")}</span>
          </p>
        ) : null}

        <p className="onboarding-footnote">
          {t("onboarding.gatewayNote", { url: GUIDE_GATEWAY_URL })}
        </p>
      </div>
    </div>
  );
}