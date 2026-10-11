import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy, Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyToClipboard } from "@/utils/clipboard";
import { formatDuration } from "@/utils/duration";
import { folderBaseName, formatDisplayPath, pathsEqual, shortPath } from "@/utils/projectPaths";
import { formatTokenCount } from "@/utils/tokenCount";
import { validMetric, type RunCardMetrics } from "./runCardMetrics";
import { DurationValue, firstWaitInfo, runStatusIcon } from "./runMetricsView";

export function AgentSessionCard({ identity, metrics, elapsedMs, status, team = false, teamRunning = false, projectName, cwd, folders, primaryFolder, worktreePath, sessionId, messages, turns, contextUsed, contextSize }: {
  identity?: ReactNode;
  metrics: RunCardMetrics;
  elapsedMs?: number;
  status: string;
  team?: boolean;
  teamRunning?: boolean;
  projectName?: string;
  cwd: string;
  folders: string[];
  primaryFolder?: string;
  worktreePath?: string;
  sessionId?: string;
  messages: number;
  turns: number;
  contextUsed?: number;
  contextSize?: number;
}) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState<"session" | "worktree">();
  const [copyError, setCopyError] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(undefined), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async (value: string, kind: "session" | "worktree") => {
    try { await copyToClipboard(value); setCopied(kind); setCopyError(false); }
    catch { setCopyError(true); }
  };
  const key = "workspace.runMetrics";
  const running = team ? teamRunning : metrics.running;
  const StatusIcon = runStatusIcon(status);
  const statusLabel = t(`${key}.status.${status}`, { defaultValue: t(`${key}.status.unknown`) });
  const firstWait = firstWaitInfo(metrics);
  const firstWaitValue = firstWait.ms !== undefined ? (
    <>
      <DurationValue ms={firstWait.ms} />
      {firstWait.tracked && metrics.firstOutputKind && ` · ${t(`${key}.firstOutputKind.${metrics.firstOutputKind}`)}`}
    </>
  ) : firstWait.unavailable || metrics.status === "unknown" ? t(`${key}.unavailable`) : t(`${key}.${firstWait.waitingKey}`);

  const root = primaryFolder || cwd || folders[0];
  const projectTitle = projectName || (root ? folderBaseName(root) || root : "");
  const used = team ? undefined : validMetric(contextUsed);
  const size = team ? undefined : validMetric(contextSize);
  const percent = used !== undefined && size !== undefined && size > 0 ? used / size * 100 : undefined;
  const percentLabel = percent === undefined ? "—" : new Intl.NumberFormat(i18n.language, { style: "percent", maximumFractionDigits: 1 }).format(percent / 100);
  const contextLabel = `${used === undefined ? "—" : formatTokenCount(used)}${size !== undefined ? ` / ${formatTokenCount(size)}` : ""} Token`;

  return (
    <section className="side-card agent-session-card" aria-label={t("workspace.sessionInfo")}>
      <header className="workspace-overview-heading agent-session-heading">
        {team ? <h2>{t(`${key}.teamRun`)}</h2> : identity}
        <span
          className={`run-metrics-status is-${status}`}
          title={elapsedMs !== undefined && (running || team) ? t(`${key}.${team ? "teamDurationHint" : "durationHint"}`) : undefined}
        >
          <StatusIcon size={13} aria-hidden="true" />
          {statusLabel}
          {elapsedMs !== undefined && (running || team) && ` · ${formatDuration(elapsedMs)}`}
        </span>
      </header>
      {!team && running && (
        <p className="agent-session-live" title={t(`${key}.${firstWait.hintKey}`)}>
          <span className="agent-session-live-label">{t(`${key}.${firstWait.labelKey}`)}</span>{" "}
          <span className="agent-session-live-value">{firstWaitValue}</span>
        </p>
      )}
      {!team && (used !== undefined || size !== undefined) && (
        <div className="workspace-overview-context">
          <div><span>{t("workspace.contextUsage")}</span><strong>{percentLabel}</strong></div>
          {percent !== undefined && <progress max={100} value={Math.min(100, percent)} aria-label={`${t("workspace.contextUsage")} ${percentLabel}, ${contextLabel}`} />}
          <p>{contextLabel}</p>
        </div>
      )}
      <details className="workspace-overview-disclosure">
        <summary><span>{t("workspace.sessionDetails")}</span><span className="workspace-overview-disclosure-hint" title={t(`workspace.${team ? "teamDetailsHint" : "sessionDetailsHint"}`)}>{t(`workspace.${team ? "teamDetailsHint" : "sessionDetailsHint"}`)}</span><ChevronDown size={14} aria-hidden="true" /></summary>
        <div className="workspace-overview-details">
          <div className={`workspace-overview-project${projectTitle ? "" : " is-empty"}`}>
            <span className="workspace-overview-folder-icon"><Folder size={17} aria-hidden="true" /></span>
            {projectTitle ? (
              <div><strong title={projectName || root}>{projectTitle}</strong>{root && <p title={root}>{formatDisplayPath(root)}</p>}</div>
            ) : (
              <p>{t("workspace.noWorkingDirectory")}</p>
            )}
          </div>
          {folders.length > 1 && <div className="workspace-overview-mounts">
            <p>{t("workspace.mountedFolders")}</p>
            <ul className="workspace-mounted-list">{folders.map(folder => <li key={folder} title={folder}><span>{formatDisplayPath(folder)}</span>{root && pathsEqual(folder, root) && <em>{t("workspace.primaryFolder")}</em>}</li>)}</ul>
          </div>}
          <dl className="workspace-overview-detail-list">
            {!team && <div><dt>{t("workspace.sessionId")}</dt><dd>
              <button type="button" className="session-id-copy" disabled={!sessionId} aria-label={t("workspace.copySessionId")} title={sessionId ? t("workspace.copySession", { id: sessionId }) : t("workspace.noSession")} onClick={() => { if (sessionId) void copy(sessionId, "session"); }}>
                <span>{copied === "session" ? t("workspace.copied") : sessionId ? sessionId.length <= 18 ? sessionId : `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}` : t("workspace.notCaptured")}</span>{copied === "session" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              </button>
            </dd></div>}
            {worktreePath && <div className="workspace-worktree-row"><dt>{t("workspace.worktree")}</dt><dd>
              <button type="button" className="session-id-copy workspace-worktree-copy" title={t("workspace.copyWorktree", { path: worktreePath })} aria-label={t("workspace.copyWorktree", { path: worktreePath })} onClick={() => void copy(worktreePath, "worktree")}>
                <span>{copied === "worktree" ? t("workspace.copied") : shortPath(worktreePath)}</span>{copied === "worktree" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              </button>
            </dd></div>}
            <div><dt>{t("workspace.messages")}</dt><dd>{messages}</dd></div>
            <div><dt>{t("workspace.agentTurns")}</dt><dd>{turns}</dd></div>
          </dl>
          <span className="workspace-overview-copy-status" role="status">{copied ? t("workspace.copied") : ""}</span>
          {copyError && <p className="workspace-overview-detail-note" role="alert">{t("workspace.copyFailed")}</p>}
        </div>
      </details>
    </section>
  );
}
