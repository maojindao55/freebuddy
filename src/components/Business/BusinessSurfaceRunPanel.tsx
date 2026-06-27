import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useBusinessRequirementRunStore } from "@/store/businessRequirementRunStore";
import { BusinessCommitGateCard } from "./BusinessCommitGateCard";

function shortPath(repoPath: string): string {
  return repoPath.split(/[/\\]/).filter(Boolean).slice(-2).join("/") || repoPath;
}

export function BusinessSurfaceRunPanel() {
  const { t } = useTranslation();
  const run = useBusinessRequirementRunStore((s) => s.activeRun);
  const previewCommitGate = useBusinessRequirementRunStore((s) => s.previewCommitGate);
  const approveCommitGate = useBusinessRequirementRunStore((s) => s.approveCommitGate);
  const clearActiveRun = useBusinessRequirementRunStore((s) => s.clearActiveRun);
  const errors = useBusinessRequirementRunStore((s) => s.pendingErrors);
  const previewedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!run) {
      previewedFor.current = null;
      return;
    }
    if (
      run.status === "awaiting_commit_approval" &&
      previewedFor.current !== run.id
    ) {
      previewedFor.current = run.id;
      void previewCommitGate(run.id);
    }
  }, [run, previewCommitGate]);

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

      {(run.status === "awaiting_commit_approval" || run.commitGate) && (
        <BusinessCommitGateCard
          commitGate={run.commitGate ?? null}
          errors={errors}
          onApprove={(allowFailures) => void approveCommitGate(run.id, { allowCommitWithFailures: allowFailures })}
          onCancel={() => clearActiveRun()}
        />
      )}
    </section>
  );
}
