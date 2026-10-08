import { useEffect, useMemo, useState } from "react";
import { delegationClient, type DelegationRunRow } from "@/services/delegation/client";

import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { displayAgentName } from "@/config/agentDisplay";
import { cliClient } from "@/services/cli/client";
import type {
  CodexResetCredit,
  CodexUsageResult,
  CodexUsageWindow,
  AntigravityQuotaBucket,
  AntigravityUsageResult,
  ConversationMessage
} from "@/services/cli/types";
import type { CliStreamItem } from "@/services/cli/parsers";
import { useConversationStore } from "@/store/conversationStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useProjectStore } from "@/store/projectStore";
import { AgentAvatar } from "./AgentAvatar";
import { RunMetricsSection } from "./RunMetricsSection";
import { SessionInfoCard } from "./SessionInfoCard";
import { runCardElapsedMs, selectRunCardMetrics } from "./runCardMetrics";
import { InfoCardHost } from "../InfoCards/InfoCardHost";
import { WorkflowRunPanel } from "../Workflows/WorkflowRunPanel";
import { DelegationTeamCard } from "../Workflows/DelegationTeamCard";
import { mergeSessionMetaItems } from "@/store/sessionMetaUtils";
import { displayConfigOptionLabel } from "@/utils/sessionConfigOptions";
import { conversationDisplayCwd, conversationWorktreePath } from "./conversationProjectGrouping";

type PlanItem = Extract<CliStreamItem, { kind: "plan" }>;
type PlanEntry = PlanItem["entries"][number];

// Stable empty array so the active-slice selectors below return a constant
// reference when there is no active conversation (avoids re-renders).
const EMPTY_MESSAGES: ConversationMessage[] = [];

export function WorkspacePanel(_props: { runningCount: number }) {
  const { t, i18n } = useTranslation();
  const activeId = useConversationStore((s) => s.activeId);
  const conversations = useConversationStore((s) => s.conversations);
  const projects = useProjectStore((s) => s.projects);
  // Subscribe only to the active conversation's slices so background
  // conversations streaming events don't re-render this panel.
  const messages = useConversationStore((s) =>
    s.activeId ? s.messages[s.activeId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );
  const live = useConversationStore((s) =>
    s.activeId ? s.live[s.activeId] : undefined
  );
  const [now, setNow] = useState(() => Date.now());
  const [monotonicNow, setMonotonicNow] = useState(() => performance.now());
  const [codexUsage, setCodexUsage] = useState<CodexUsageResult | undefined>();
  const [codexUsageLoading, setCodexUsageLoading] = useState(false);
  const [antigravityUsage, setAntigravityUsage] = useState<AntigravityUsageResult | undefined>();
  const [antigravityUsageLoading, setAntigravityUsageLoading] = useState(false);
  const [resetCreditsExpanded, setResetCreditsExpanded] = useState(false);
  const loadWorkflowForConversation = useWorkflowStore((s) => s.loadForConversation);
  const clearActiveWorkflowConversation = useWorkflowStore(
    (s) => s.clearActiveConversation
  );
  const activeRun = useWorkflowStore((s) => s.activeRun);
  const workflowSteps = useWorkflowStore((s) => s.steps);

  useEffect(() => {
    if (!activeId) {
      clearActiveWorkflowConversation();
      return;
    }
    void loadWorkflowForConversation(activeId);
  }, [activeId, clearActiveWorkflowConversation, loadWorkflowForConversation]);

  const displayMessages = messages;
  const displayLive = live;
  const currentWorkflowRun =
    activeRun?.conversationId === activeId ? activeRun : undefined;
  const displayRun = currentWorkflowRun;

  const active = conversations.find((c) => c.id === activeId);
  const activeAgentName = displayAgentName(active?.agentName, active?.adapter);
  const activeDisplayCwd = active ? conversationDisplayCwd(active) : "";
  const worktreePath = useMemo(
    () => (active ? conversationWorktreePath(active) : undefined),
    [active]
  );
  const activeProject = useMemo(() => {
    const projectId = active?.projectId?.trim();
    if (!projectId) return undefined;
    return projects.find((entry) => entry.id === projectId);
  }, [active?.projectId, projects]);
  const mountedFolders = useMemo(() => {
    if (activeProject?.folders?.length) {
      return activeProject.folders.map((folder) => folder.trim()).filter(Boolean);
    }
    return activeDisplayCwd ? [activeDisplayCwd] : [];
  }, [activeDisplayCwd, activeProject]);
  const primaryFolder =
    activeProject?.primaryPath?.trim() ||
    activeDisplayCwd ||
    mountedFolders[0];
  const isCodexAgent =
    active?.adapter === "codex-acp" || active?.agentId === "cli-codex-acp";
  const isAntigravityAgent =
    active?.adapter === "agy-acp" ||
    active?.adapter === "antigravity" ||
    active?.agentId === "cli-agy-acp";
  const isDshAgent =
    active?.adapter === "dsh-acp" ||
    active?.adapter === "dsh" ||
    active?.agentId === "cli-dsh-acp";

  const status = displayLive?.status ?? "ready";
  const isLive = status === "running" || status === "starting";

  const [delegationRun, setDelegationRun] = useState<DelegationRunRow>();
  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    if (!activeId || !delegationClient.isAvailable()) return;
    const refresh = () => {
      const requestedRevision = ++revision;
      void delegationClient.getRunByConversation(activeId)
        .then(run => { if (!cancelled && requestedRevision === revision) setDelegationRun(run); })
        .catch(() => { /* Preserve the last verified team result. */ });
    };
    refresh();
    const offChanged = delegationClient.onChanged(refresh);
    const offFinished = delegationClient.onRunFinished(refresh);
    return () => { cancelled = true; offChanged?.(); offFinished?.(); };
  }, [activeId, displayLive?.taskSessionId, displayLive?.status]);

  const currentDelegationRun = delegationRun?.conversationId === activeId ? delegationRun : undefined;
  const teamRun = displayRun ?? currentDelegationRun;
  const isTeamRun = Boolean(teamRun) || active?.kind === "workflow" || active?.kind === "delegation";
  const isTeamLive = !!teamRun && ["running", "paused", "blocked", "pending", "pending_approval"].includes(teamRun.status);

  useEffect(() => {
    if (!isLive && !isTeamLive) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
      setMonotonicNow(performance.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [isLive, isTeamLive]);

  const totalMessages = useMemo(
    () =>
      isTeamRun
        ? displayMessages.filter((m) => m.role !== "system").length
        : displayMessages.length,
    [isTeamRun, displayMessages]
  );
  const assistantTurns = useMemo(
    () => displayMessages.filter((m) => m.role === "assistant").length,
    [displayMessages]
  );

  const latestSessionId = useMemo(() => {
    if (isTeamRun) return undefined;
    const fromLive = displayLive?.capturedSessionId ?? displayLive?.resumedFromSessionId;
    if (fromLive) return fromLive;

    for (let i = displayMessages.length - 1; i >= 0; i -= 1) {
      const message = displayMessages[i];
      if (message.role !== "assistant") continue;
      try {
        const items = JSON.parse(message.content) as unknown[];
        if (!Array.isArray(items)) continue;
        for (let j = items.length - 1; j >= 0; j -= 1) {
          const item = items[j] as { kind?: string; sessionId?: string };
          if (item?.kind === "session" && item.sessionId) {
            return item.sessionId;
          }
        }
      } catch {
        // Ignore plain or legacy assistant messages.
      }
    }

    return undefined;
  }, [isTeamRun, displayLive?.capturedSessionId, displayLive?.resumedFromSessionId, displayMessages]);

  const runCard = useMemo(
    () => selectRunCardMetrics(displayMessages, displayLive),
    [displayMessages, displayLive]
  );
  const latestUsage = isTeamRun ? undefined : runCard.usage;

  const latestPlan = useMemo(
    () => (isTeamRun ? undefined : latestPlanFromMessages(displayMessages)),
    [isTeamRun, displayMessages]
  );

  const latestConfigOptions = useMemo(() => {
    if (isTeamRun) return [];
    const messageItems = displayMessages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => {
        try {
          const items = JSON.parse(message.content);
          return Array.isArray(items) ? items : [];
        } catch {
          return [];
        }
      });
    return mergeSessionMetaItems(messageItems, displayLive?.items).configOptions;
  }, [isTeamRun, displayLive, displayMessages]);

  const durationMs = useMemo(() => {
    if (isTeamRun) {
      if (!teamRun) return undefined;
      const start = Date.parse(teamRun.createdAt);
      const end = teamRun.endedAt ? Date.parse(teamRun.endedAt) : isTeamLive ? now : NaN;
      return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
    }
    return runCardElapsedMs(runCard.summary, runCard.running, runCard.receivedAt, monotonicNow);
  }, [isTeamRun, teamRun, isTeamLive, now, runCard, monotonicNow]);
  const teamStatus = teamRun?.status === "completed" ? "done" :
    teamRun?.status === "stopped" || teamRun?.status === "killed" ? "cancelled" :
    teamRun?.status === "pending_approval" ? "pending" :
    teamRun?.status === "timeout" ? "timed-out" : teamRun?.status ?? "unknown";
  const runStatus = isTeamRun ? teamStatus : runCard.exists ? runCard.status : "idle";

  const sessionConfigSummary = useMemo(() => {
    const sessionConfigValues = latestConfigOptions
      .map(
        (option) =>
          displayConfigOptionLabel(option, active?.configOptionOverrides) ??
          option.currentLabel ??
          option.currentValue
      )
      .filter((value): value is string => Boolean(value));
    return sessionConfigValues.length > 0
      ? sessionConfigValues.join(" / ")
      : t("workspace.localAgent");
  }, [active?.configOptionOverrides, latestConfigOptions, t]);

  useEffect(() => {
    if (!isCodexAgent) {
      setCodexUsage(undefined);
      setCodexUsageLoading(false);
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      setCodexUsageLoading(true);
      try {
        const result = await cliClient.codexUsage();
        if (!cancelled) setCodexUsage(result);
      } catch (error) {
        if (!cancelled) {
          setCodexUsage({
            ok: false,
            reason: "request_failed",
            error: error instanceof Error ? error.message : String(error),
            fetchedAt: new Date().toISOString()
          });
        }
      } finally {
        if (!cancelled) setCodexUsageLoading(false);
      }
    };

    void refresh();
    const id = window.setInterval(refresh, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [isCodexAgent, status]);

  useEffect(() => {
    if (!isAntigravityAgent) {
      setAntigravityUsage(undefined);
      setAntigravityUsageLoading(false);
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      setAntigravityUsageLoading(true);
      try {
        const result = await cliClient.antigravityUsage();
        if (!cancelled) setAntigravityUsage(result);
      } catch (error) {
        if (!cancelled) {
          setAntigravityUsage({
            ok: false,
            reason: "request_failed",
            error: error instanceof Error ? error.message : String(error),
            fetchedAt: new Date().toISOString()
          });
        }
      } finally {
        if (!cancelled) setAntigravityUsageLoading(false);
      }
    };

    void refresh();
    const id = window.setInterval(refresh, 2 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [isAntigravityAgent, status]);

  return (
    <div className="workspace-cards" aria-label={t("workspace.panelAria")}>
      <WorkflowRunPanel />
      {activeId && currentDelegationRun ? (
        <DelegationTeamCard conversationId={activeId} />
      ) : null}

      {isTeamRun ? null : (
        <section className="side-card active-agent-card">
          <div className="side-card-header">
            <span>{t("workspace.activeAgent")}</span>
            <strong>{t(`status.${status}`)}</strong>
          </div>
          <div className="agent-lockup">
            <AgentAvatar
              adapter={active?.adapter}
              agentId={active?.agentId}
              className="agent-avatar"
              fallback={
                <span>
                  {(active ? activeAgentName : "FB").slice(0, 2).toUpperCase()}
                </span>
              }
            />
            <div>
              <strong>{active ? activeAgentName : t("workspace.noConversation")}</strong>
              <small title={sessionConfigSummary}>{sessionConfigSummary}</small>
            </div>
          </div>
        </section>
      )}

      <RunMetricsSection key={`run:${activeId}`} metrics={runCard} elapsedMs={durationMs} team={isTeamRun} teamRunning={isTeamLive} status={runStatus} />
      <SessionInfoCard
        key={`session:${activeId}`}
        projectName={activeProject?.name}
        cwd={activeDisplayCwd}
        folders={mountedFolders}
        primaryFolder={primaryFolder}
        worktreePath={worktreePath}
        sessionId={latestSessionId}
        messages={totalMessages}
        turns={assistantTurns}
        contextUsed={latestUsage?.contextUsed}
        contextSize={latestUsage?.contextSize}
        team={isTeamRun}
      />

      {latestPlan &&
        latestPlan.entries.some((entry) => entry.status !== "cancelled") && (
        <section className="side-card plan-card">
          <div className="side-card-header">
            <span>{t("workspace.plan")}</span>
            <strong>
              {t("workspace.planProgress", {
                done: latestPlan.entries.filter(
                  (entry) =>
                    entry.status === "completed" || entry.status === "cancelled"
                ).length,
                total: latestPlan.entries.length
              })}
            </strong>
          </div>
          <ol className="plan-list">
            {latestPlan.entries.map((entry, index) => (
              <li
                key={`${entry.content}-${index}`}
                className={`plan-entry ${entry.status} priority-${entry.priority}`}
              >
                <span className="plan-status-dot" aria-hidden="true" />
                <div>
                  <p>{entry.content}</p>
                  <small>
                    {t(`workspace.planStatus.${entry.status}`)} ·{" "}
                    {t(`workspace.planPriority.${entry.priority}`)}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {isCodexAgent && (
        <section className="side-card codex-usage-card">
          <div className="side-card-header">
            <span>{t("workspace.codexUsage")}</span>
            <button
              className="codex-usage-refresh"
              type="button"
              disabled={codexUsageLoading}
              onClick={() => {
                setCodexUsageLoading(true);
                void cliClient
                  .codexUsage()
                  .then(setCodexUsage)
                  .catch((error) =>
                    setCodexUsage({
                      ok: false,
                      reason: "request_failed",
                      error: error instanceof Error ? error.message : String(error),
                      fetchedAt: new Date().toISOString()
                    })
                  )
                  .finally(() => setCodexUsageLoading(false));
              }}
            >
              {codexUsageLoading
                ? t("workspace.codexUsageLoading")
                : t("workspace.codexUsageRefresh")}
            </button>
          </div>
          {codexUsage?.ok ? (
            <div className="codex-limit-list">
              {codexUsage.windows.map((usage) => (
                <CodexLimitRow
                  key={`${usage.windowSeconds}-${usage.resetAt}`}
                  label={codexUsageWindowLabel(usage.windowSeconds, t)}
                  usage={usage}
                  leftLabel={t("workspace.codexUsageLeft", {
                    percent: usage.leftPercent
                  })}
                  resetLabel={t("workspace.codexUsageResetAt", {
                    time: formatCodexResetAt(
                      usage.resetAt,
                      i18n.language,
                      usage.windowSeconds < 86_400 ? "time" : "dateTime"
                    )
                  })}
                />
              ))}
              {codexUsage.resetCredits && (
                <div className="codex-reset-credits">
                  <button
                    className="codex-reset-credits-summary"
                    type="button"
                    aria-expanded={resetCreditsExpanded}
                    aria-label={
                      resetCreditsExpanded
                        ? t("workspace.codexResetCreditsCollapse")
                        : t("workspace.codexResetCreditsExpand")
                    }
                    onClick={() => setResetCreditsExpanded((value) => !value)}
                  >
                    <strong>
                      {t("workspace.codexResetCredits")}
                      <span className="codex-reset-credits-chevron" aria-hidden="true" />
                    </strong>
                    <span>
                      {t("workspace.codexResetCreditsCount", {
                        available: codexUsage.resetCredits.availableCount,
                        total: codexUsage.resetCredits.totalCount
                      })}
                    </span>
                  </button>
                  {codexUsage.resetCredits.nextExpiresAt && (
                    <small>
                      {t("workspace.codexResetCreditsExpireAt", {
                        time: formatCodexResetAt(
                          codexUsage.resetCredits.nextExpiresAt,
                          i18n.language
                        )
                      })}
                    </small>
                  )}
                  {resetCreditsExpanded && (
                    <div className="codex-reset-credit-list">
                      {codexUsage.resetCredits.credits.map((credit, index) => (
                        <CodexResetCreditRow
                          key={`${credit.status}-${credit.expiresAt ?? "none"}-${index}`}
                          credit={credit}
                          index={index}
                          language={i18n.language}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="codex-usage-empty">
              {codexUsageLoading
                ? t("workspace.codexUsageLoading")
                : t("workspace.codexUsageUnavailable")}
            </p>
          )}
        </section>
      )}

      {isAntigravityAgent && (
        <section className="side-card codex-usage-card antigravity-usage-card">
          <div className="side-card-header">
            <span title={antigravityUsage?.ok && antigravityUsage.email ? antigravityUsage.email : undefined}>
              {t("workspace.antigravityUsage")}
            </span>
            <button
              className="codex-usage-refresh"
              type="button"
              disabled={antigravityUsageLoading}
              onClick={() => {
                setAntigravityUsageLoading(true);
                void cliClient
                  .antigravityUsage()
                  .then(setAntigravityUsage)
                  .catch((error) =>
                    setAntigravityUsage({
                      ok: false,
                      reason: "request_failed",
                      error: error instanceof Error ? error.message : String(error),
                      fetchedAt: new Date().toISOString()
                    })
                  )
                  .finally(() => setAntigravityUsageLoading(false));
              }}
            >
              {antigravityUsageLoading
                ? t("workspace.antigravityUsageLoading")
                : t("workspace.antigravityUsageRefresh")}
            </button>
          </div>
          {antigravityUsage?.ok ? (
            <div className="codex-limit-list antigravity-limit-list">
              {antigravityUsage.groups.map((group, gIdx) => (
                <div key={group.displayName || gIdx} className="antigravity-quota-group">
                  <div className="antigravity-group-title">
                    {group.displayName === "Gemini Models"
                      ? t("workspace.antigravityGeminiGroup")
                      : group.displayName === "Claude and GPT models"
                        ? t("workspace.antigravityThirdPartyGroup")
                        : group.displayName}
                  </div>
                  {group.buckets.map((bucket) => (
                    <AntigravityLimitRow
                      key={bucket.bucketId}
                      label={antigravityUsageWindowLabel(bucket, t)}
                      bucket={bucket}
                      leftLabel={t("workspace.antigravityLeft", {
                        percent: bucket.leftPercent
                      })}
                      resetLabel={
                        bucket.resetAt
                          ? t("workspace.antigravityResetAt", {
                              time: formatCodexResetAt(
                                bucket.resetAt,
                                i18n.language,
                                bucket.windowSeconds < 86_400 ? "time" : "dateTime"
                              )
                            })
                          : undefined
                      }
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <p className="codex-usage-empty">
              {antigravityUsageLoading
                ? t("workspace.antigravityUsageLoading")
                : t("workspace.antigravityUsageUnavailable")}
            </p>
          )}
        </section>
      )}

      <InfoCardHost />
    </div>
  );
}

function CodexResetCreditRow({
  credit,
  index,
  language
}: {
  credit: CodexResetCredit;
  index: number;
  language: string;
}) {
  const { t } = useTranslation();
  const statusKey = codexResetCreditStatusKey(credit.status);
  return (
    <div className="codex-reset-credit-row">
      <strong>{t("workspace.codexResetCreditTitle", { index: index + 1 })}</strong>
      <span className={`codex-reset-credit-status ${statusKey}`}>
        {t(`workspace.codexResetCreditStatus.${statusKey}`)}
      </span>
      <small>
        {credit.expiresAt
          ? t("workspace.codexResetCreditExpiresAt", {
              time: formatCodexResetAt(credit.expiresAt, language)
            })
          : t("workspace.codexResetCreditNoExpiry")}
      </small>
    </div>
  );
}

function CodexLimitRow({
  label,
  usage,
  leftLabel,
  resetLabel
}: {
  label: string;
  usage: CodexUsageWindow;
  leftLabel: string;
  resetLabel: string;
}) {
  const isWarning = usage.leftPercent <= 20 && usage.leftPercent > 0;
  const isDanger = usage.leftPercent === 0;
  const barClass = isDanger ? "limit-danger" : isWarning ? "limit-warning" : "";

  return (
    <div className="codex-limit-row">
      <div className="codex-limit-meta">
        <strong>{label}</strong>
        <span className={barClass ? `antigravity-limit-badge ${barClass}` : undefined}>
          {leftLabel}
        </span>
      </div>
      <div className="codex-limit-track" aria-hidden="true">
        <span
          className={`codex-limit-fill ${barClass}`}
          style={{ width: `${usage.leftPercent}%` }}
        />
      </div>
      <small>{resetLabel}</small>
    </div>
  );
}

function codexUsageWindowLabel(
  windowSeconds: number,
  t: TFunction
): string {
  if (windowSeconds === 604_800) return t("workspace.codexUsageWeekly");
  if (windowSeconds === 86_400) return t("workspace.codexUsageDaily");
  if (windowSeconds > 0 && windowSeconds % 3_600 === 0) {
    return t("workspace.codexUsageHours", { hours: windowSeconds / 3_600 });
  }
  return t("workspace.codexUsageWindow");
}

function AntigravityLimitRow({
  label,
  bucket,
  leftLabel,
  resetLabel
}: {
  label: string;
  bucket: AntigravityQuotaBucket;
  leftLabel: string;
  resetLabel?: string;
}) {
  const isWarning = bucket.leftPercent <= 20 && bucket.leftPercent > 0;
  const isDanger = bucket.leftPercent === 0;
  const barClass = isDanger ? "limit-danger" : isWarning ? "limit-warning" : "";

  return (
    <div className="codex-limit-row">
      <div className="codex-limit-meta">
        <strong>{label}</strong>
        <span className={barClass ? `antigravity-limit-badge ${barClass}` : undefined}>
          {leftLabel}
        </span>
      </div>
      <div className="codex-limit-track" aria-hidden="true">
        <span
          className={`codex-limit-fill ${barClass}`}
          style={{ width: `${bucket.leftPercent}%` }}
        />
      </div>
      {resetLabel && <small>{resetLabel}</small>}
    </div>
  );
}

function antigravityUsageWindowLabel(
  bucket: AntigravityQuotaBucket,
  t: TFunction
): string {
  if (bucket.window === "5h") return t("workspace.antigravityLimit5h");
  if (bucket.window === "weekly" || bucket.windowSeconds === 604_800) {
    return t("workspace.antigravityLimitWeekly");
  }
  if (bucket.window === "daily" || bucket.windowSeconds === 86_400) {
    return t("workspace.antigravityLimitDaily");
  }
  return bucket.displayName || t("workspace.antigravityUsageWindow");
}

function codexResetCreditStatusKey(status: string): "available" | "used" | "unknown" {
  if (status === "available" || status === "used") return status;
  return "unknown";
}

function latestPlanFromMessages(
  messages: ConversationMessage[]
): PlanItem | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const items = parseMessageItems(message.content);
    for (let j = items.length - 1; j >= 0; j -= 1) {
      const item = items[j];
      if (isPlanItem(item)) return item;
    }
  }
  return undefined;
}

function parseMessageItems(content: string): unknown[] {
  try {
    const items = JSON.parse(content);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function isPlanItem(item: unknown): item is PlanItem {
  if (!item || typeof item !== "object") return false;
  const candidate = item as { kind?: unknown; entries?: unknown };
  if (candidate.kind !== "plan" || !Array.isArray(candidate.entries)) {
    return false;
  }
  return candidate.entries.every(isPlanEntry);
}

function isPlanEntry(entry: unknown): entry is PlanEntry {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as {
    content?: unknown;
    priority?: unknown;
    status?: unknown;
  };
  return (
    typeof candidate.content === "string" &&
    (candidate.priority === "high" ||
      candidate.priority === "medium" ||
      candidate.priority === "low") &&
    (candidate.status === "pending" ||
      candidate.status === "in_progress" ||
      candidate.status === "completed" ||
      candidate.status === "cancelled")
  );
}

function formatCodexResetAt(
  resetAt: number,
  lang: string,
  variant: "time" | "dateTime" = "dateTime"
): string {
  const millis = resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return "";
  if (variant === "time") {
    return new Intl.DateTimeFormat(lang || undefined, {
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(lang || undefined, {
    year: sameYear ? undefined : "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
