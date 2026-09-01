import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Pause,
  Play,
  Square
} from "lucide-react";

import {
  eventsForRosterRole,
  resolveActiveDelegationRoleId
} from "@freebuddy/delegation-core";
import {
  delegationClient,
  type DelegationEventRow,
  type DelegationEventStatus
} from "@/services/delegation/client";
import { cliClient } from "@/services/cli/client";
import type { DelegationTeam } from "@/services/workflowTeams/types";
import { useConversationStore } from "@/store/conversationStore";
import { AgentAvatar } from "../CLI/AgentAvatar";

const POLL_MS = 1500;

function formatClock(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(event: DelegationEventRow): string | null {
  const from = event.startedAt ?? event.acceptedAt;
  if (!from) return null;
  const start = new Date(from).getTime();
  const end = event.endedAt ? new Date(event.endedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.round((end - start) / 100) / 10;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function DelegationTeamCard({
  conversationId
}: {
  conversationId: string;
}) {
  const { t } = useTranslation();
  const members = useConversationStore((s) => s.members);
  const liveStatus = useConversationStore((s) => s.live[conversationId]?.status);
  const [team, setTeam] = useState<DelegationTeam | undefined>(undefined);
  const [activeRoleId, setActiveRoleId] = useState<string | undefined>(undefined);
  const [runStatus, setRunStatus] = useState<string | undefined>(undefined);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<DelegationEventRow[]>([]);
  const [modelsByAgent, setModelsByAgent] = useState<Record<string, string>>({});
  const [expandedMemberIds, setExpandedMemberIds] = useState<Set<string>>(
    () => new Set()
  );
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(
    () => new Set()
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setExpandedMemberIds(new Set());
    setExpandedEventIds(new Set());
  }, [conversationId]);

  // Extract model per agent from the conversation's streamed config-options
  // items — same mechanism as WorkspacePanel's sessionConfigSummary.
  useEffect(() => {
    if (!team) return;
    let cancelled = false;
    (async () => {
      try {
        const messages = await cliClient.listMessages(conversationId);
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const msg of messages) {
          if (msg.role !== "assistant" || !msg.agentId) continue;
          try {
            const items = JSON.parse(msg.content);
            if (!Array.isArray(items)) continue;
            for (const item of items) {
              if (item.kind === "config-options" && Array.isArray(item.options)) {
                const modelOpt = item.options.find((o: any) => o.id === "model");
                if (modelOpt?.currentLabel || modelOpt?.currentValue) {
                  map[msg.agentId] = modelOpt.currentLabel ?? modelOpt.currentValue;
                }
              }
            }
          } catch {}
        }
        for (const r of team.roster) {
          if (r.model && !map[r.agentId]) map[r.agentId] = r.model;
        }
        if (!cancelled) setModelsByAgent(map);
      } catch {
        if (!cancelled) setModelsByAgent({});
      }
    })();
    return () => { cancelled = true; };
  }, [team, conversationId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const run = await delegationClient.getRunByConversation(conversationId);
        if (!run || !run.teamId) {
          if (!cancelled) {
            setTeam(undefined);
            setActiveRoleId(undefined);
            setRunStatus(undefined);
            setRunId(undefined);
            setEvents([]);
          }
          return;
        }
        if (!cancelled) {
          setRunStatus(run.status);
          setRunId(run.id);
        }
        let currentTeam = team;
        if (!currentTeam) {
          const loaded = await delegationClient.get(run.teamId);
          if (!cancelled) setTeam(loaded ?? undefined);
          currentTeam = loaded ?? undefined;
        }

        // Determine the active role from run + events (bus is source of truth):
        // 1. Child event (depth>0) "running" → that child's roster role
        // 2. Else if run is running/blocked → entry role is active (turning or parked)
        // Roles that share a CLI adapter must not inherit each other's live slot.
        const events = await delegationClient.listEvents(run.id);
        if (cancelled) return;
        setEvents(events);
        if (!currentTeam) {
          setActiveRoleId(undefined);
          return;
        }
        setActiveRoleId(
          resolveActiveDelegationRoleId({
            roster: currentTeam.roster,
            entryRoleId: currentTeam.entryRoleId,
            events,
            runStatus: run.status,
            liveStatus
          })
        );
      } catch {
        if (!cancelled) {
          setActiveRoleId(undefined);
          setRunStatus(undefined);
        }
      }
    };

    const schedule = () => {
      timer = setTimeout(async () => {
        if (cancelled) return;
        await poll();
        schedule();
      }, POLL_MS);
    };

    void poll();
    schedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, liveStatus, team]);

  if (!team) return null;

  const memberName = (agentId: string): string =>
    members.find((m) => m.id === agentId)?.name ?? agentId;
  const memberAdapter = (agentId: string): string | undefined =>
    members.find((m) => m.id === agentId)?.cli.adapter;

  const runBadge =
    runStatus === "running"
      ? t("status.running")
      : runStatus === "paused"
        ? t("workflow.status.paused", { defaultValue: "paused" })
        : runStatus === "blocked"
          ? t("status.blocked", { defaultValue: "blocked" })
          : runStatus === "completed"
            ? t("status.done", { defaultValue: "done" })
            : runStatus === "failed" || runStatus === "killed"
              ? t("status.failed", { defaultValue: runStatus })
              : "";

  const onPause = async () => {
    if (!runId || busy) return;
    setBusy(true);
    try {
      await delegationClient.pauseRun(runId);
      setRunStatus("paused");
    } finally {
      setBusy(false);
    }
  };

  const onResume = async () => {
    if (!runId || busy) return;
    setBusy(true);
    try {
      await delegationClient.resumeRun(runId);
      setRunStatus("running");
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    if (!runId || busy) return;
    setBusy(true);
    try {
      await delegationClient.stopRun(runId);
      setRunStatus("killed");
    } finally {
      setBusy(false);
    }
  };

  const showRunControls =
    Boolean(runId) &&
    (runStatus === "running" || runStatus === "blocked" || runStatus === "paused");

  const statusLabel = (status: DelegationEventStatus): string => {
    const defaults: Record<DelegationEventStatus, string> = {
      pending: "queued",
      running: "running",
      done: "done",
      failed: "failed",
      timeout: "timeout",
      cancelled: "cancelled"
    };
    return t(`workflow.delegation.status.${status}`, { defaultValue: defaults[status] });
  };

  const toggleMember = (memberId: string) => {
    setExpandedMemberIds((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  };

  const toggleEvent = (eventId: string) => {
    setExpandedEventIds((current) => {
      const next = new Set(current);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  return (
    <div className="delegation-roster-stack">
      {showRunControls ? (
        <div className="delegation-run-toolbar">
          {runBadge ? (
            <span className={`workflow-run-status ${runStatus ?? ""}`}>{runBadge}</span>
          ) : (
            <span />
          )}
          <div className="delegation-run-actions">
            {runStatus === "running" || runStatus === "blocked" ? (
              <button type="button" disabled={busy} onClick={() => void onPause()}>
                <Pause aria-hidden="true" /> {t("workflow.pause")}
              </button>
            ) : null}
            {runStatus === "paused" ? (
              <button type="button" disabled={busy} onClick={() => void onResume()}>
                <Play aria-hidden="true" /> {t("workflow.resume")}
              </button>
            ) : null}
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void onStop()}
            >
              <Square aria-hidden="true" /> {t("workflow.stop")}
            </button>
          </div>
        </div>
      ) : null}
      <div className="delegation-members-heading">
        <span>
          {t("workflow.delegation.membersActivity", {
            defaultValue: "Members and activity"
          })}
        </span>
        <strong>
          {t("workflow.delegation.taskCount", {
            count: events.length,
            defaultValue: `${events.length} tasks`
          })}
        </strong>
      </div>
      <div className="delegation-member-list" aria-live="polite">
      {team.roster.map((r) => {
        const isEntry = r.id === team.entryRoleId;
        const isActive = activeRoleId === r.id;
        const memberEvents = eventsForRosterRole(events, r, team.roster);
        const newestFirst = [...memberEvents].reverse();
        const activeEvent = newestFirst.find(
          (event) => event.status === "running" || event.status === "pending"
        );
        const primaryEvent = activeEvent ?? newestFirst[0];
        const memberExpanded = expandedMemberIds.has(r.id);
        const visibleEvents = memberExpanded
          ? newestFirst
          : primaryEvent
            ? [primaryEvent]
            : [];
        // Entry is parked when the run is live but a child agent owns the active slot.
        const parkedEntry =
          isEntry && runStatus === "running" && Boolean(activeRoleId) && !isActive;
        const badge = isActive
          ? t("status.running")
          : parkedEntry
            ? t("workflow.delegation.parked", { defaultValue: "parked" })
            : primaryEvent
              ? statusLabel(primaryEvent.status)
              : "";
        const memberState = isActive
          ? "running"
          : parkedEntry
            ? "pending"
            : primaryEvent?.status ?? "idle";
        const rwLabel = r.canWrite
          ? t("workflow.delegation.canWrite")
          : t("workflow.delegation.readonly", { defaultValue: "read-only" });

        return (
          <section
            key={r.id}
            className={`side-card delegation-member-card${isActive ? " delegation-roster-active" : ""}`}
          >
            <div className="delegation-member-summary">
              <AgentAvatar
                adapter={memberAdapter(r.agentId)}
                agentId={r.agentId}
                className="agent-avatar delegation-member-avatar"
                fallback={
                  <div className="agent-avatar" style={{ background: "rgba(128,128,128,0.2)" }}>
                    <span>{r.label.slice(0, 2).toUpperCase()}</span>
                  </div>
                }
              />
              <div className="delegation-member-identity">
                <div className="delegation-member-role-line">
                  <span>{r.label}</span>
                  {isEntry ? (
                    <em>{t("workflow.delegation.entry", { defaultValue: "entry" })}</em>
                  ) : null}
                </div>
                <strong>{memberName(r.agentId)}</strong>
                <small>
                  {modelsByAgent[r.agentId] ? `${modelsByAgent[r.agentId]} · ` : ""}
                  {r.capability}
                </small>
              </div>
              <div className="delegation-member-badges">
                {badge ? (
                  <span className={`delegation-member-state ${memberState}`}>
                    {badge}
                  </span>
                ) : null}
                <span className="delegation-member-access">{rwLabel}</span>
              </div>
            </div>
            <div
              id={`delegation-member-${r.id}-activity`}
              className="delegation-member-activity"
            >
              {visibleEvents.length === 0 ? (
                <div className="delegation-member-empty">
                  {t("workflow.delegation.noMemberTasks", {
                    defaultValue: "No delegated tasks yet"
                  })}
                </div>
              ) : (
                visibleEvents.map((event) => {
                  const duration = formatDuration(event);
                  const eventExpanded = expandedEventIds.has(event.id);
                  const failureReason =
                    (event.status === "failed" || event.status === "timeout") &&
                    event.resultSummary?.trim()
                      ? event.resultSummary.trim()
                      : undefined;
                  return (
                    <article
                      key={event.id}
                      className={`delegation-activity-item ${event.status}`}
                    >
                      <div className="delegation-activity-head">
                        <span
                          className={`delegation-activity-dot ${event.status}`}
                          aria-hidden="true"
                        />
                        <span className={`delegation-event-status ${event.status}`}>
                          {statusLabel(event.status)}
                        </span>
                        {duration ? (
                          <span className="delegation-event-duration">{duration}</span>
                        ) : null}
                        <button
                          type="button"
                          className="delegation-activity-detail-toggle"
                          aria-expanded={eventExpanded}
                          aria-controls={`delegation-event-${event.id}`}
                          onClick={() => toggleEvent(event.id)}
                        >
                          {eventExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                          {eventExpanded
                            ? t("workflow.delegation.hide", { defaultValue: "Hide" })
                            : t("workflow.delegation.details", { defaultValue: "Details" })}
                        </button>
                      </div>
                      <p
                        className={`delegation-activity-task${eventExpanded ? " expanded" : ""}`}
                        title={event.taskText}
                      >
                        {event.taskText}
                      </p>
                      {failureReason ? (
                        <div
                          className="delegation-event-failure"
                          role="alert"
                          title={failureReason}
                        >
                          <strong>{t("workflow.failureReason")}</strong>
                          <span>{failureReason}</span>
                        </div>
                      ) : null}
                      {eventExpanded ? (
                        <div
                          id={`delegation-event-${event.id}`}
                          className="delegation-activity-details"
                        >
                          <div className="delegation-event-timing">
                            {t("workflow.delegation.acceptedAt", { defaultValue: "Accepted" })} {formatClock(event.acceptedAt)}
                            {event.startedAt
                              ? ` · ${t("workflow.delegation.startedAt", { defaultValue: "Started" })} ${formatClock(event.startedAt)}`
                              : ""}
                            {event.endedAt
                              ? ` · ${t("workflow.delegation.endedAt", { defaultValue: "Ended" })} ${formatClock(event.endedAt)}`
                              : ""}
                          </div>
                          {event.verdict ? (
                            <div className={`delegation-activity-verdict ${event.verdict}`}>
                              {event.verdict}
                              {event.verdictSummary ? ` · ${event.verdictSummary}` : ""}
                            </div>
                          ) : null}
                          {event.resultSummary && !failureReason ? (
                            <div className="delegation-event-result">
                              <strong>
                                {t("workflow.delegation.result", { defaultValue: "Result" })}
                              </strong>
                              <p>{event.resultSummary}</p>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })
              )}
              {memberEvents.length > 1 ? (
                <button
                  type="button"
                  className="delegation-member-history-toggle"
                  aria-expanded={memberExpanded}
                  aria-controls={`delegation-member-${r.id}-activity`}
                  onClick={() => toggleMember(r.id)}
                >
                  {memberExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                  {memberExpanded
                    ? t("workflow.delegation.collapseHistory", {
                        defaultValue: "Collapse history"
                      })
                    : t("workflow.delegation.showHistory", {
                        count: memberEvents.length,
                        defaultValue: `View all ${memberEvents.length} tasks`
                      })}
                </button>
              ) : null}
            </div>
          </section>
        );
      })}
      </div>
    </div>
  );
}
