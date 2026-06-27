import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { BusinessCommitGate } from "@/services/businessWorkspaces/types";

export function BusinessCommitGateCard({
  commitGate,
  errors,
  onApprove,
  onCancel
}: {
  commitGate: BusinessCommitGate | null;
  errors: string[];
  onApprove: (allowCommitWithFailures: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [allowFailures, setAllowFailures] = useState(
    commitGate?.allowCommitWithFailures ?? false
  );

  if (errors.length > 0) {
    return (
      <div className="business-commit-gate">
        <ul className="workflow-team-editor-errors">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
        <button type="button" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    );
  }

  if (!commitGate) return null;

  return (
    <div className="business-commit-gate">
      <div className="business-commit-gate-header">
        <h4>{t("business.commitGate")}</h4>
        <p className={`muted small ${commitGate.contractConsistency.status}`}>
          {commitGate.contractConsistency.summary}
        </p>
      </div>

      <ul className="business-commit-gate-repos">
        {commitGate.repositories.map((repo) => (
          <li key={repo.surfaceId} className="business-commit-gate-repo">
            <div className="business-commit-gate-repo-head">
              <strong>{repo.surfaceId}</strong>
              <span className="workflow-team-badge muted">{repo.branchName}</span>
              {repo.commitSha && (
                <span className="workflow-team-badge write">
                  {repo.commitSha.slice(0, 8)}
                </span>
              )}
            </div>
            <p className="muted small">{repo.repoPath}</p>

            <label className="workflow-team-editor-field">
              <span>{t("business.commitMessage")}</span>
              <textarea rows={2} defaultValue={repo.commitMessage} readOnly />
            </label>

            {repo.diffFiles.length > 0 && (
              <div className="business-commit-gate-diff">
                <span className="muted small">{t("business.diffFiles")}:</span>
                <ul>
                  {repo.diffFiles.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="business-commit-gate-verify">
              {repo.verificationResults.map((v, i) => (
                <span
                  key={i}
                  className={`workflow-team-badge ${v.status === "passed" ? "write" : "muted"}`}
                >
                  {v.command}: {v.status}
                </span>
              ))}
            </div>

            {repo.risks.length > 0 && (
              <ul className="business-commit-gate-risks">
                {repo.risks.map((risk, i) => (
                  <li key={i} className="muted small">
                    {risk}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {commitGate.status !== "committed" && (
        <div className="business-commit-gate-actions">
          <label className="workflow-team-editor-toggle">
            <input
              type="checkbox"
              checked={allowFailures}
              onChange={(e) => setAllowFailures(e.target.checked)}
            />
            <span>{t("business.allowFailures")}</span>
          </label>
          <button type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="primary" onClick={() => onApprove(allowFailures)}>
            {t("business.approveCommit")}
          </button>
        </div>
      )}
    </div>
  );
}
