import { useEffect, useMemo, useState } from "react";

import { useTranslation } from "react-i18next";

import { displayAgentName } from "@/config/agentDisplay";
import type { ConversationMessage } from "@/services/cli/types";
import type { CliStreamItem } from "@/services/cli/parsers";
import { useConversationStore } from "@/store/conversationStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { formatDuration } from "@/utils/duration";
import { AgentAvatar } from "./AgentAvatar";
import { WorkflowRunPanel } from "../Workflows/WorkflowRunPanel";
import {
  mergeSessionMetaItems
} from "@/store/sessionMetaUtils";

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
  const { t } = useTranslation();
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
  const [copiedSession, setCopiedSession] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const loadWorkflowForConversation = useWorkflowStore((s) => s.loadForConversation);
  const activeRun = useWorkflowStore((s) => s.activeRun);
  const workflowSteps = useWorkflowStore((s) => s.steps);

  useEffect(() => {
    if (!activeId) return;
    void loadWorkflowForConversation(activeId);
  }, [activeId, loadWorkflowForConversation]);

  const active = conversations.find((c) => c.id === activeId);
  const activeAgentName = displayAgentName(active?.agentName, active?.adapter);

  const status = live?.status ?? "ready";
  const isLive = status === "running" || status === "starting";

  const isTeamRun = !!activeRun && activeRun.conversationId === activeId;
  const isTeamLive =
    isTeamRun &&
    (activeRun!.status === "running" ||
      activeRun!.status === "paused" ||
      activeRun!.status === "blocked");

  useEffect(() => {
    if (!isLive && !isTeamLive) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isLive, isTeamLive]);

  const totalMessages = useMemo(
    () =>
      isTeamRun
        ? messages.filter((m) => m.role !== "system").length
        : messages.length,
    [isTeamRun, messages]
  );
  const assistantTurns = useMemo(
    () => messages.filter((m) => m.role === "assistant").length,
    [messages]
  );

  const latestSessionId = useMemo(() => {
    if (isTeamRun) return undefined;
    const fromLive = live?.capturedSessionId ?? live?.resumedFromSessionId;
    if (fromLive) return fromLive;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
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
  }, [isTeamRun, live?.capturedSessionId, live?.resumedFromSessionId, messages]);

  const latestUsage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
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
  }, [messages]);

  const latestPlan = useMemo(
    () => (isTeamRun ? undefined : latestPlanFromMessages(messages)),
    [isTeamRun, messages]
  );

  const latestConfigOptions = useMemo(() => {
    if (isTeamRun) return [];
    const messageItems = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => {
        try {
          const items = JSON.parse(message.content);
          return Array.isArray(items) ? items : [];
        } catch {
          return [];
        }
      });
    return mergeSessionMetaItems(messageItems, live?.items).configOptions;
  }, [isTeamRun, live, messages]);

  const durationMs = useMemo(() => {
    if (isTeamRun && activeRun?.createdAt) {
      const start = Date.parse(activeRun.createdAt);
      const end = activeRun.endedAt ? Date.parse(activeRun.endedAt) : now;
      if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
      const ms = end - start;
      return ms >= 0 ? ms : undefined;
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      const start = Date.parse(message.createdAt);
      const end = isLive ? now : Date.parse(message.updatedAt);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
      const ms = end - start;
      return ms >= 0 ? ms : undefined;
    }
    return undefined;
  }, [
    isTeamRun,
    activeRun?.createdAt,
    activeRun?.endedAt,
    messages,
    isLive,
    now
  ]);

  return (
    <aside className="details-panel workspace-panel" aria-label={t("workspace.panelAria")}>
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
              className="agent-avatar"
              fallback={
                <span>
                  {(active ? activeAgentName : "FB").slice(0, 2).toUpperCase()}
                </span>
              }
            />
            <div>
              <strong>{active ? activeAgentName : t("workspace.noConversation")}</strong>
              <small>{active ? t("workspace.localAgent") : t("workspace.createToBegin")}</small>
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

      {latestConfigOptions.length > 0 && (
        <section className="side-card session-config-card">
          <div className="side-card-header">
            <span>{t("workspace.sessionConfig")}</span>
            <strong>{latestConfigOptions.length}</strong>
          </div>
          <div className="session-config-scroll">
            <dl className="compact-dl session-config-list">
              {latestConfigOptions.map((option) => {
                const label = option.name ?? option.id;
                const value =
                  option.currentLabel ?? option.currentValue ?? t("workspace.notSet");
                return (
                  <div key={option.id} className="session-config-row">
                    <dt>
                      <span className="session-config-label" title={label}>
                        {label}
                      </span>
                    </dt>
                    <dd title={value}>{value}</dd>
                  </div>
                );
              })}
            </dl>
          </div>
        </section>
      )}

      {latestPlan && (
        <section className="side-card plan-card">
          <div className="side-card-header">
            <span>{t("workspace.plan")}</span>
            <strong>
              {t("workspace.planProgress", {
                done: latestPlan.entries.filter((entry) => entry.status === "completed").length,
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
    </aside>
  );
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
      candidate.status === "completed")
  );
}

function shortPath(path: string) {
  return path.split(/[/\\]/).filter(Boolean).slice(-2).join("/") || path;
}

function shortSessionId(id: string) {
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}\u2026${id.slice(-6)}`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatCost(amount: number, currency?: string): string {
  const value = amount.toFixed(amount < 0.01 ? 4 : 2);
  return currency === "USD" ? `$${value}` : `${value} ${currency ?? ""}`.trim();
}
