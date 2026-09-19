import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  Layers,
  Loader2,
  Play,
  Sparkles,
  Wrench
} from "lucide-react";

import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useCliInstallStore } from "@/store/cliInstallStore";
import { useProviderStore } from "@/store/providerStore";
import { useConversationStore } from "@/store/conversationStore";
import { useAgentBridgeStore } from "@/store/agentBridgeStore";
import { useOnboardingStore } from "@/store/onboardingStore";

interface CoreAgentMeta {
  id: string;
  name: string;
  tag: string;
  descKey: string;
  defaultCommand: string;
}

const CORE_AGENTS: CoreAgentMeta[] = [
  {
    id: "codex-acp",
    name: "Codex",
    tag: "OpenAI / Reasoning",
    descKey: "onboarding.setup.codexDesc",
    defaultCommand: "npm install -g --force @agentclientprotocol/codex-acp"
  },
  {
    id: "dsh-acp",
    name: "DeepSeek (DSH)",
    tag: "DeepSeek / Cost-effective",
    descKey: "onboarding.setup.dshDesc",
    defaultCommand: "npm install -g deepseek-harness-acp"
  },
  {
    id: "claude-agent-acp",
    name: "ClaudeCode",
    tag: "Claude / Full Stack",
    descKey: "onboarding.setup.claudeDesc",
    defaultCommand: "npm install -g --include=optional @agentclientprotocol/claude-agent-acp"
  }
];

export function OnboardingGuideSetupCard({
  onOpenSettings,
  onAskGuide
}: {
  onOpenSettings?: () => void;
  onAskGuide?: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const notify = useAgentBridgeStore((s) => s.notify);
  const [authorizing, setAuthorizing] = useState(false);

  const handleAskGuide = () => {
    onAskGuide?.(t("onboarding.setup.askGuidePrompt"));
  };

  // 1. Subscribe to atomic state
  const runtimes = useCliExecutorStore((s) => s.runtimes);
  const overrides = useCliExecutorStore((s) => s.overrides);
  const installJobs = useCliInstallStore((s) => s.jobs);
  const startInstall = useCliInstallStore((s) => s.startJob);

  // 2. Derive agent status safely
  const agentsStatus = CORE_AGENTS.map((agent) => {
    const isInstalled = Boolean(runtimes[agent.id]?.installed);
    const isInstalling = Boolean(
      installJobs.some((j) => j.adapterId === agent.id && !j.done)
    );
    const override = overrides[agent.id];
    const isKeyConfigured = Boolean(
      (agent.id === "codex-acp" &&
        override?.codexByok?.enabled &&
        (override.codexByok.providerId || override.codexByok.apiKey)) ||
      (agent.id === "dsh-acp" &&
        override?.deepseekByok?.enabled &&
        (override.deepseekByok.providerId || override.deepseekByok.apiKey)) ||
      (agent.id === "claude-agent-acp" &&
        override?.claudeByok?.enabled &&
        (override.claudeByok.providerId || override.claudeByok.apiKey))
    );
    return {
      ...agent,
      isInstalled,
      isInstalling,
      isKeyConfigured
    };
  });

  const installedAgents = agentsStatus.filter((a) => a.isInstalled);
  const missingAgents = agentsStatus.filter((a) => !a.isInstalled);
  const installingAgents = agentsStatus.filter((a) => a.isInstalling);

  const allInstalled = missingAgents.length === 0;
  const anyInstalled = installedAgents.length > 0;
  const isAnyKeyConfigured = installedAgents.some((a) => a.isKeyConfigured);

  // Status headline
  const headline = allInstalled
    ? t("onboarding.setup.allInstalled")
    : anyInstalled
      ? t("onboarding.setup.partiallyInstalled", {
          installedNames: installedAgents.map((a) => a.name).join(", "),
          count: missingAgents.length
        })
      : t("onboarding.setup.noneInstalled");

  const handleInstallOne = (agentId: string) => {
    const def = CORE_AGENTS.find((a) => a.id === agentId);
    if (!def) return;
    const resolved = useCliExecutorStore.getState().resolve(agentId);
    startInstall({
      adapterId: agentId,
      label: def.name,
      command: resolved?.installHint || def.defaultCommand
    });
    notify(t("onboarding.setup.installStarted"));
  };

  const handleInstallAllMissing = () => {
    for (const agent of missingAgents) {
      const resolved = useCliExecutorStore.getState().resolve(agent.id);
      startInstall({
        adapterId: agent.id,
        label: agent.name,
        command: resolved?.installHint || agent.defaultCommand
      });
    }
    notify(t("onboarding.setup.installStarted"));
  };

  const handleAuthorizeAll = async () => {
    const guideProvider = useProviderStore
      .getState()
      .providers.find((p) => p.presetId === "freebuddy-guide" || p.enabled);

    if (!guideProvider) {
      notify(t("onboarding.setup.noProviderFound"));
      return;
    }

    if (installedAgents.length === 0) {
      notify(t("onboarding.setup.noAgentReady"));
      return;
    }

    setAuthorizing(true);
    try {
      const executorStore = useCliExecutorStore.getState();

      for (const agent of installedAgents) {
        const existingOverride = executorStore.overrides[agent.id] || {
          id: agent.id,
          baseAdapter: agent.id
        };

        if (agent.id === "codex-acp") {
          await executorStore.upsertOverride({
            ...existingOverride,
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
        } else if (agent.id === "dsh-acp") {
          await executorStore.upsertOverride({
            ...existingOverride,
            id: "dsh-acp",
            baseAdapter: "dsh-acp",
            deepseekByok: {
              enabled: true,
              providerId: guideProvider.id,
              wireApi: "chat",
              envKey: guideProvider.envKey || "DEEPSEEK_API_KEY",
              models: guideProvider.models.length
                ? guideProvider.models
                : [{ id: "auto", name: "Auto (Trial)" }]
            },
            enabled: true
          });
        } else if (agent.id === "claude-agent-acp") {
          await executorStore.upsertOverride({
            ...existingOverride,
            id: "claude-agent-acp",
            baseAdapter: "claude-agent-acp",
            claudeByok: {
              enabled: true,
              providerId: guideProvider.id,
              envKey: guideProvider.envKey || "ANTHROPIC_API_KEY",
              models: guideProvider.models.length
                ? guideProvider.models
                : [{ id: "auto", name: "Auto (Trial)" }]
            },
            enabled: true
          });
        }
      }

      notify(t("onboarding.setup.authorizedSuccess"));
    } catch (err) {
      notify(String(err));
    } finally {
      setAuthorizing(false);
    }
  };

  const handleStartTask = async () => {
    const convStore = useConversationStore.getState();
    // Pick the first ready installed agent (prefer codex, then dsh, then claude)
    const preferredId =
      installedAgents.find((a) => a.id === "codex-acp")?.id ||
      installedAgents.find((a) => a.id === "dsh-acp")?.id ||
      installedAgents[0]?.id;

    if (!preferredId) {
      notify(t("onboarding.setup.noAgentReady"));
      return;
    }

    const member = convStore.members.find(
      (m) => m.cli.adapter === preferredId || m.id.includes(preferredId)
    );

    if (!member) {
      notify(t("onboarding.setup.noAgentReady"));
      return;
    }

    try {
      await convStore.newConversation({
        member,
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
      {/* Header with detection summary */}
      <div className="onboarding-setup-header">
        <div className="onboarding-setup-header-icon">
          <Layers size={18} />
        </div>
        <div className="onboarding-setup-header-text">
          <div className="setup-header-title-row">
            <h3>{t("onboarding.setup.cardTitle")}</h3>
            <span className="setup-header-badge">
              {installedAgents.length} / {CORE_AGENTS.length}
            </span>
          </div>
          <p className="setup-header-headline">{headline}</p>
        </div>
        {missingAgents.length > 0 && (
          <div className="setup-header-action">
            {onAskGuide && (
              <button
                type="button"
                className="step-btn step-btn--guide-auto"
                onClick={handleAskGuide}
                title={t("onboarding.setup.askGuideTooltip")}
              >
                <Sparkles size={13} />
                {t("onboarding.setup.askGuideBtn")}
              </button>
            )}
            <button
              type="button"
              className="step-btn step-btn--primary"
              disabled={installingAgents.length > 0}
              onClick={handleInstallAllMissing}
            >
              {installingAgents.length > 0 ? (
                <>
                  <Loader2 size={13} className="spin" />
                  {t("onboarding.setup.installingAll")}
                </>
              ) : (
                <>
                  <Download size={13} />
                  {anyInstalled
                    ? t("onboarding.setup.installAll", { count: missingAgents.length })
                    : t("onboarding.setup.installAllNone")}
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* 3 Core Agents List */}
      <div className="onboarding-core-agents-list">
        {agentsStatus.map((agent) => (
          <div
            key={agent.id}
            className={`core-agent-item${agent.isInstalled ? " is-installed" : ""}`}
          >
            <div className="core-agent-info">
              <div className="core-agent-name-row">
                <strong>{agent.name}</strong>
                <span className="core-agent-tag">{agent.tag}</span>
              </div>
              <span className="core-agent-desc">{t(agent.descKey)}</span>
            </div>

            <div className="core-agent-action">
              {agent.isInstalled ? (
                <span className="core-agent-status core-agent-status--installed">
                  <CheckCircle2 size={15} />
                  {t("onboarding.setup.installed")}
                </span>
              ) : agent.isInstalling ? (
                <span className="core-agent-status core-agent-status--installing">
                  <Loader2 size={15} className="spin" />
                  {t("onboarding.setup.installing")}
                </span>
              ) : (
                <button
                  type="button"
                  className="step-btn"
                  onClick={() => handleInstallOne(agent.id)}
                >
                  <Wrench size={12} />
                  {t("onboarding.setup.install")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Next Step Controls: Authorize and Launch */}
      <div className="onboarding-setup-next-steps">
        {/* Step 2: Authorize Trial Credits */}
        <div className={`setup-flow-row${isAnyKeyConfigured ? " is-done" : ""}${!anyInstalled ? " is-disabled" : ""}`}>
          <div className="setup-flow-copy">
            <strong>{t("onboarding.setup.step2Title")}</strong>
            <span>
              {isAnyKeyConfigured
                ? t("onboarding.setup.step2Done")
                : t("onboarding.setup.step2Desc")}
            </span>
          </div>
          {!isAnyKeyConfigured && (
            <button
              type="button"
              className="step-btn step-btn--primary"
              disabled={!anyInstalled || authorizing}
              onClick={() => void handleAuthorizeAll()}
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
          )}
        </div>

        {/* Step 3: Run First Coding Task */}
        <div className={`setup-flow-row${anyInstalled && isAnyKeyConfigured ? " is-ready" : " is-disabled"}`}>
          <div className="setup-flow-copy">
            <strong>{t("onboarding.setup.step3Title")}</strong>
            <span>{t("onboarding.setup.step3Desc")}</span>
          </div>
          <button
            type="button"
            className="step-btn step-btn--launch"
            disabled={!anyInstalled || !isAnyKeyConfigured}
            onClick={() => void handleStartTask()}
          >
            <Play size={13} />
            {t("onboarding.setup.startFirstTask")}
          </button>
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
