import { useEffect, useMemo, useState } from "react";

import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { displayAgentName } from "@/config/agentDisplay";
import { cliClient } from "@/services/cli/client";
import type {
  CodexResetCredit,
  CodexUsageResult,
  CodexUsageWindow,
  ConversationMessage
} from "@/services/cli/types";
import type { CliStreamItem } from "@/services/cli/parsers";
import { useConversationStore } from "@/store/conversationStore";
import { useReplayStore } from "@/store/replayStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { formatDuration } from "@/utils/duration";
import { AgentAvatar } from "./AgentAvatar";
import { InfoCardHost } from "../InfoCards/InfoCardHost";
import { WorkflowRunPanel } from "../Workflows/WorkflowRunPanel";
import { mergeSessionMetaItems } from "@/store/sessionMetaUtils";

type PlanItem = Extract<CliStreamItem, { kind: "plan" }>;
type PlanEntry = PlanItem["entries"][number];

// Stable empty array so the active-slice selectors below return a constant
// reference when there is no active conversation (avoids re-renders).
const EMPTY_MESSAGES: ConversationMessage[] = [];

export function WorkspacePanel({
  runningCount
}: {
  runningCount: number;
}) {
  const { t, i18n } = useTranslation();
  const activeId = useConversationStore((s) => s.activeId);
  const conversations = useConversationStore((s) => s.conversations);
  // Subscribe only to the active conversation's slices so background
  // conversations streaming events don't re-render this panel.
  const messages = useConversationStore((s) =>
    s.activeId ? s.messages[s.activeId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );
  const live = useConversationStore((s) =>
    s.activeId ? s.live[s.activeId] : undefined
  );
  const [now, setNow] = useState(() => Date.now());
  const [codexUsage, setCodexUsage] = useState<CodexUsageResult | undefined>();
  const [codexUsageLoading, setCodexUsageLoading] = useState(false);
  const [resetCreditsExpanded, setResetCreditsExpanded] = useState(false);
  const [copiedSession, setCopiedSession] = useState(false);
  const loadWorkflowForConversation = useWorkflowStore((s) => s.loadForConversation);
  const activeRun = useWorkflowStore((s) => s.activeRun);
  const workflowSteps = useWorkflowStore((s) => s.steps);
  const replayConvId = useReplayStore((s) => s.conversationId);
  const replayIndex = useReplayStore((s) => s.index);
  const replayFrames = useReplayStore((s) => s.frames);

  useEffect(() => {
    if (!activeId) return;
    void loadWorkflowForConversation(activeId);
  }, [activeId, loadWorkflowForConversation]);

  const replayFrame =
    replayConvId === activeId && replayIndex >= 0
      ? replayFrames[replayIndex]
      : undefined;
  const replayWorkflow = replayFrame?.workflow;
  const displayMessages = replayFrame
    ? messages.slice(0, replayFrame.messageIndex + 1)
    : messages;
  const displayLive = replayFrame ? undefined : live;
  const displayRun = replayWorkflow?.run ?? activeRun;

  const active = conversations.find((c) => c.id === activeId);
  const activeAgentName = displayAgentName(active?.agentName, active?.adapter);
  const isCodexAgent =
    active?.adapter === "codex-acp" || active?.agentId === "cli-codex-acp";

  const status = displayLive?.status ?? "ready";
  const isLive = status === "running" || status === "starting";

  const isTeamRun = !!displayRun && displayRun.conversationId === activeId;
  const isTeamLive =
    !replayFrame &&
    isTeamRun &&
    (displayRun!.status === "running" ||
      displayRun!.status === "paused" ||
      displayRun!.status === "blocked");

  useEffect(() => {
    if (!isLive && !isTeamLive) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
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

  const latestUsage = useMemo(() => {
    for (let i = displayMessages.length - 1; i >= 0; i -= 1) {
      const message = displayMessages[i];
      if (message.role !== "assistant") continue;
      try {
        const items = JSON.parse(message.content) as unknown[];
        if (!Array.isArray(items)) continue;
        for (let j = items.length - 1; j >= 0; j -= 1) {
          const item = items[j] as {
            kind?: string;
            contextUsed?: number;
            contextSize?: number;
            costAmount?: number;
            costCurrency?: string;
            inputTokens?: number;
            outputTokens?: number;
            totalCost?: number;
          };
          if (item?.kind === "usage") return item;
        }
      } catch {
        // ignore
      }
    }
    return undefined;
  }, [displayMessages]);

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
    if (isTeamRun && displayRun?.createdAt) {
      const start = Date.parse(displayRun.createdAt);
      const end = replayWorkflow?.at
        ? Date.parse(replayWorkflow.at)
        : displayRun.endedAt
          ? Date.parse(displayRun.endedAt)
          : now;
      if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
      const ms = end - start;
      return Math.max(ms, 0);
    }
    const replayMessage = replayFrame ? messages[replayFrame.messageIndex] : undefined;
    for (let i = displayMessages.length - 1; i >= 0; i -= 1) {
      const message = displayMessages[i];
      if (message.role !== "assistant") continue;
      const start = Date.parse(message.createdAt);
      const replayingMessage = Boolean(replayFrame && message.id === replayMessage?.id);
      const end = replayingMessage
        ? Date.parse(replayFrame?.messageComplete ? message.updatedAt : message.createdAt)
        : isLive
          ? now
          : Date.parse(message.updatedAt);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
      const ms = end - start;
      return Math.max(ms, 0);
    }
    return undefined;
  }, [
    isTeamRun,
    displayRun?.createdAt,
    displayRun?.endedAt,
    replayWorkflow?.at,
    replayFrame,
    replayFrame?.messageComplete,
    messages,
    displayMessages,
    isLive,
    now
  ]);

  const sessionConfigSummary = useMemo(() => {
    const sessionConfigValues = latestConfigOptions
      .map((option) => option.currentLabel ?? option.currentValue)
      .filter((value): value is string => Boolean(value));
    return sessionConfigValues.length > 0
      ? sessionConfigValues.join(" / ")
      : t("workspace.localAgent");
  }, [latestConfigOptions, t]);

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

  return (
    <div className="workspace-cards" aria-label={t("workspace.panelAria")}>
      <WorkflowRunPanel />

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

      <section className="side-card">
        <div className="side-card-header">
          <span>{t("workspace.runState")}</span>
          <strong>
            {runningCount > 0
              ? t("workspace.liveCount", { count: runningCount })
              : t("status.idle")}
          </strong>
        </div>
        <dl className="compact-dl">
          <div>
            <dt>{t("workspace.workspace")}</dt>
            <dd>{active?.cwd ? shortPath(active.cwd) : t("workspace.notSet")}</dd>
          </div>
          {!isTeamRun && (
            <div>
              <dt>{t("workspace.sessionId")}</dt>
              <dd>
                <button
                  className="session-id-copy"
                  type="button"
                  disabled={!latestSessionId}
                  title={
                    latestSessionId
                      ? t("workspace.copySession", { id: latestSessionId })
                      : t("workspace.noSession")
                  }
                  onClick={() => {
                    if (!latestSessionId) return;
                    void navigator.clipboard.writeText(latestSessionId);
                    setCopiedSession(true);
                    window.setTimeout(() => setCopiedSession(false), 1200);
                  }}
                >
                  {copiedSession
                    ? t("workspace.copied")
                    : latestSessionId
                      ? shortSessionId(latestSessionId)
                      : t("workspace.notCaptured")}
                </button>
              </dd>
            </div>
          )}
          <div>
            <dt>{t("workspace.messages")}</dt>
            <dd>{totalMessages}</dd>
          </div>
          <div>
            <dt>{t("workspace.agentTurns")}</dt>
            <dd>{assistantTurns}</dd>
          </div>
          {durationMs != null && (
            <div>
              <dt>{t("workspace.duration")}</dt>
              <dd>{formatDuration(durationMs)}</dd>
            </div>
          )}
          {latestUsage?.contextUsed != null && (
            <div>
              <dt>{t("workspace.context")}</dt>
              <dd>
                {formatTokens(latestUsage.contextUsed)}
                {latestUsage.contextSize != null
                  ? ` / ${formatTokens(latestUsage.contextSize)}`
                  : ""}
              </dd>
            </div>
          )}
          {latestUsage?.costAmount != null && (
            <div>
              <dt>{t("workspace.cost")}</dt>
              <dd>{formatCost(latestUsage.costAmount, latestUsage.costCurrency)}</dd>
            </div>
          )}
          {latestUsage?.contextUsed == null &&
            latestUsage?.costAmount == null &&
            (latestUsage?.inputTokens != null ||
              latestUsage?.outputTokens != null) && (
              <div>
                <dt>{t("workspace.tokens")}</dt>
                <dd>
                  {t("workspace.tokenBreakdown", {
                    input: latestUsage.inputTokens ?? "\u2013",
                    output: latestUsage.outputTokens ?? "\u2013"
                  })}
                </dd>
              </div>
            )}
        </dl>
      </section>

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
  return (
    <div className="codex-limit-row">
      <div className="codex-limit-meta">
        <strong>{label}</strong>
        <span>{leftLabel}</span>
      </div>
      <div className="codex-limit-track" aria-hidden="true">
        <span
          className="codex-limit-fill"
          style={{ width: `${usage.usedPercent}%` }}
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

function shortPath(path: string) {
  return path.split(/[/\\]/).filter(Boolean).slice(-2).join("/") || path;
}

function shortSessionId(id: string) {
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}\u2026${id.slice(-6)}`;
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

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatCost(amount: number, currency?: string): string {
  const value = amount.toFixed(amount < 0.01 ? 4 : 2);
  return currency === "USD" ? `$${value}` : `${value} ${currency ?? ""}`.trim();
}
