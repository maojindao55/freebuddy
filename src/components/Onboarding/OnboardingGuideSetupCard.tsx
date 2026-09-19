import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CheckCircle2, Circle, ExternalLink, Loader2, Play, Sparkles, Wrench } from "lucide-react";

import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useCliInstallStore } from "@/store/cliInstallStore";
import { useProviderStore } from "@/store/providerStore";
import { useConversationStore } from "@/store/conversationStore";
import { useAgentBridgeStore } from "@/store/agentBridgeStore";
import { useOnboardingStore } from "@/store/onboardingStore";

export function OnboardingGuideSetupCard({
  onOpenSettings
}: {
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  const notify = useAgentBridgeStore((s) => s.notify);

  const [authorizing, setAuthorizing] = useState(false);

  // 1. Subscribe to atomic state to avoid unstable object references from s.resolve()
  const codexRuntime = useCliExecutorStore((s) => s.runtimes["codex-acp"]);
  const codexOverride = useCliExecutorStore((s) => s.overrides["codex-acp"]);
  const isInstalled = Boolean(codexRuntime?.installed);

  const isInstalling = useCliInstallStore((s) =>
    s.jobs.some((j) => j.adapterId === "codex-acp" && !j.done)
  );
  const startInstall = useCliInstallStore((s) => s.startJob);

  // 2. Check model/byok status
  const isKeyConfigured = Boolean(
    codexOverride?.codexByok?.enabled &&
    (codexOverride.codexByok.providerId || codexOverride.codexByok.apiKey)
  );

  // Step state
  const step1Done = isInstalled;
  const step2Done = isKeyConfigured;
  const allReady = step1Done && step2Done;

  const handleInstall = () => {
    const codexEx = useCliExecutorStore.getState().resolve("codex-acp");
    const installHint =
      codexEx?.installHint ||
      "npm install -g --force @agentclientprotocol/codex-acp";
    startInstall({
      adapterId: "codex-acp",
      label: codexEx?.label || "Codex",
      command: installHint
    });
    notify(t("onboarding.setup.installStarted"));
  };

  const handleAuthorize = async () => {
    const guideProvider = useProviderStore
      .getState()
      .providers.find((p) => p.presetId === "freebuddy-guide" || p.enabled);

    if (!guideProvider) {
      notify(t("onboarding.setup.noProviderFound"));
      return;
    }
    setAuthorizing(true);
    try {
      const executorStore = useCliExecutorStore.getState();
      const existingCodexOverride = executorStore.overrides["codex-acp"] || {
        id: "codex-acp",
        baseAdapter: "codex-acp"
      };

      await executorStore.upsertOverride({
        ...existingCodexOverride,
        id: "codex-acp",
        baseAdapter: "codex-acp",
        codexByok: {
          enabled: true,
          providerId: guideProvider.id,
          wireApi: "chat",
          envKey: guideProvider.envKey || "OPENAI_API_KEY",
          models: guideProvider.models.length
            ? guideProvider.models
            : [{ id: "auto", name: "Auto (Trial)" }]
        },
        enabled: true
      });

      notify(t("onboarding.setup.authorizedSuccess"));
    } catch (err) {
      notify(String(err));
    } finally {
      setAuthorizing(false);
    }
  };

  const handleStartTask = async () => {
    const convStore = useConversationStore.getState();
    const codexMember = convStore.members.find(
      (m) => m.id === "cli-codex-acp" || m.cli.adapter === "codex-acp"
    );
    if (!codexMember) {
      notify(t("onboarding.setup.codexMemberNotFound"));
      return;
    }

    try {
      await convStore.newConversation({
        member: codexMember,
        title: t("onboarding.setup.firstTaskTitle")
      });
      void useOnboardingStore.getState().markDone();
      notify(t("onboarding.setup.firstTaskStarted"));
    } catch (err) {
      notify(String(err));
    }
  };

  return (
    <div className="onboarding-setup-card">
      <div className="onboarding-setup-header">
        <div className="onboarding-setup-header-icon">
          <Sparkles size={18} />
        </div>
        <div className="onboarding-setup-header-text">
          <h3>{t("onboarding.setup.cardTitle")}</h3>
          <p>{t("onboarding.setup.cardSubtitle")}</p>
        </div>
      </div>

      <div className="onboarding-setup-steps">
        {/* Step 1: Install Agent */}
        <div className={`onboarding-setup-step${step1Done ? " is-done" : ""}`}>
          <div className="onboarding-setup-step-num">
            {step1Done ? (
              <CheckCircle2 size={18} className="step-icon step-icon--done" />
            ) : isInstalling ? (
              <Loader2 size={18} className="step-icon step-icon--spin" />
            ) : (
              <span className="step-badge">1</span>
            )}
          </div>
          <div className="onboarding-setup-step-content">
            <div className="step-title">
              <strong>{t("onboarding.setup.step1Title")}</strong>
              <span className="step-desc">
                {step1Done
                  ? t("onboarding.setup.step1Done")
                  : isInstalling
                    ? t("onboarding.setup.step1Installing")
                    : t("onboarding.setup.step1Desc")}
              </span>
            </div>
            {!step1Done && (
              <div className="step-action">
                <button
                  type="button"
                  className="step-btn step-btn--primary"
                  disabled={isInstalling}
                  onClick={handleInstall}
                >
                  {isInstalling ? (
                    <>
                      <Loader2 size={13} className="spin" />
                      {t("onboarding.setup.installing")}
                    </>
                  ) : (
                    <>
                      <Wrench size={13} />
                      {t("onboarding.setup.installCodex")}
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Step 2: Authorize Trial Credits */}
        <div className={`onboarding-setup-step${step2Done ? " is-done" : ""}${!step1Done ? " is-locked" : ""}`}>
          <div className="onboarding-setup-step-num">
            {step2Done ? (
              <CheckCircle2 size={18} className="step-icon step-icon--done" />
            ) : authorizing ? (
              <Loader2 size={18} className="step-icon step-icon--spin" />
            ) : (
              <span className="step-badge">2</span>
            )}
          </div>
          <div className="onboarding-setup-step-content">
            <div className="step-title">
              <strong>{t("onboarding.setup.step2Title")}</strong>
              <span className="step-desc">
                {step2Done
                  ? t("onboarding.setup.step2Done")
                  : t("onboarding.setup.step2Desc")}
              </span>
            </div>
            {!step2Done && (
              <div className="step-action">
                <button
                  type="button"
                  className="step-btn"
                  disabled={!step1Done || authorizing}
                  onClick={() => void handleAuthorize()}
                >
                  {authorizing ? (
                    <>
                      <Loader2 size={13} className="spin" />
                      {t("onboarding.setup.authorizing")}
                    </>
                  ) : (
                    <>
                      <Sparkles size={13} />
                      {t("onboarding.setup.authorizeTrial")}
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Step 3: Run First Coding Task */}
        <div className={`onboarding-setup-step${allReady ? " is-ready" : " is-locked"}`}>
          <div className="onboarding-setup-step-num">
            <span className="step-badge">3</span>
          </div>
          <div className="onboarding-setup-step-content">
            <div className="step-title">
              <strong>{t("onboarding.setup.step3Title")}</strong>
              <span className="step-desc">{t("onboarding.setup.step3Desc")}</span>
            </div>
            <div className="step-action">
              <button
                type="button"
                className="step-btn step-btn--launch"
                disabled={!allReady}
                onClick={() => void handleStartTask()}
              >
                <Play size={13} />
                {t("onboarding.setup.startFirstTask")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {onOpenSettings && (
        <div className="onboarding-setup-footer">
          <button
            type="button"
            className="onboarding-setup-settings-link"
            onClick={onOpenSettings}
          >
            <span>{t("onboarding.setup.exploreOtherAgents")}</span>
            <ExternalLink size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
