import { useTranslation } from "react-i18next";

import { useBusinessRequirementRunStore } from "@/store/businessRequirementRunStore";

function shortPath(repoPath: string): string {
  return repoPath.split(/[/\\]/).filter(Boolean).slice(-2).join("/") || repoPath;
}

export function BusinessSurfaceRunPanel() {
  const { t } = useTranslation();
  const run = useBusinessRequirementRunStore((s) => s.activeRun);

  if (!run) return null;

  return (
    <section className="side-card business-surface-run-panel">
      <div className="side-card-header">
        <span>{t("business.runStatus")}</span>
        <strong>{run.status}</strong>
      </div>
      <p className="muted small">{run.goal}</p>

      <ul className="business-surface-runs">
        {run.surfaceRuns.map((surfaceRun) => (
          <li key={surfaceRun.id} className={`business-surface-run ${surfaceRun.status}`}>
            <div className="business-surface-run-head">
              <strong>{surfaceRun.surfaceId}</strong>
              <span className="workflow-team-badge muted">{surfaceRun.agentId}</span>
              <span className={`workflow-team-badge ${surfaceRun.status === "done" ? "write" : "muted"}`}>
                {surfaceRun.status}
              </span>
            </div>
            <div className="business-surface-run-meta">
              <span className="muted small">{shortPath(surfaceRun.repoPath)}</span>
            </div>
            {surfaceRun.verificationResults.length > 0 && (
              <ul className="business-surface-verify">
                {surfaceRun.verificationResults.map((v, i) => (
                  <li key={i} className="muted small">
                    {v.command}: {v.status}
                    {v.exitCode != null ? ` (${v.exitCode})` : ""}
                  </li>
                ))}
              </ul>
            )}
            {surfaceRun.diffSummary && (
              <pre className="business-surface-diff muted small">
                {surfaceRun.diffSummary}
              </pre>
            )}
            {surfaceRun.riskSummary && (
              <p className="business-surface-risk muted small">{surfaceRun.riskSummary}</p>
            )}
            {surfaceRun.commitSha && (
              <p className="business-surface-commit">
                {surfaceRun.branchName} · {surfaceRun.commitSha.slice(0, 8)}
              </p>
            )}
          </li>
        ))}
      </ul>

      {run.commitGate && (
        <div className="business-commit-gate-summary">
          <span className="muted small">
            {t("business.commitGate")}: {run.commitGate.status}
          </span>
        </div>
      )}
    </section>
  );
}
