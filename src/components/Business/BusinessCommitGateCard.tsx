import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BusinessCommitGate } from "@/services/businessWorkspaces/types";

export function BusinessCommitGateCard({
  commitGate,
  errors,
  onApprove,
  onCancel,
  onClearErrors
}: {
  commitGate: BusinessCommitGate | null;
  errors: string[];
  onApprove: (opts: {
    allowCommitWithFailures: boolean;
    allowOutOfScope: boolean;
  }) => void;
  onCancel: () => void;
  onClearErrors: () => void;
}) {
  const { t } = useTranslation();
  const [allowFailures, setAllowFailures] = useState(
    commitGate?.allowCommitWithFailures ?? false
  );
  const [allowOutOfScope, setAllowOutOfScope] = useState(false);

  // Sync the allow-failures checkbox when the gate (re)loads from the server,
  // e.g. when policy says allowCommitWithFailures=true.
  useEffect(() => {
    setAllowFailures(commitGate?.allowCommitWithFailures ?? false);
  }, [commitGate?.allowCommitWithFailures]);

  const hasOutOfScope =
    !!commitGate &&
    commitGate.repositories.some(
      (r) => (r.outOfScopeFiles ?? []).length > 0
    );
  const committed = commitGate?.status === "committed";

  return (
    <div className="business-commit-gate">
      <div className="business-commit-gate-header">
        <h4>{t("business.commitGate")}</h4>
        {commitGate && (
          <p className={`muted small ${commitGate.contractConsistency.status}`}>
            {commitGate.contractConsistency.summary}
          </p>
        )}
      </div>

      {errors.length > 0 && (
        <div className="business-commit-gate-errors">
          <ul className="workflow-team-editor-errors">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <button type="button" className="small" onClick={onClearErrors}>
            {t("common.dismiss")}
          </button>
        </div>
      )}

      {commitGate && (
        <>
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

                {(repo.outOfScopeFiles ?? []).length > 0 && (
                  <div className="business-commit-gate-outofscope">
                    <span className="muted small">
                      {t("business.outOfScope")}:
                    </span>
                    <ul>
                      {(repo.outOfScopeFiles ?? []).map((file) => (
                        <li key={file}>{file}</li>
                      ))}
                    </ul>
                    <p className="muted small">{t("business.outOfScopeHint")}</p>
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

          {!committed && (
            <div className="business-commit-gate-actions">
              <div className="business-commit-gate-toggles">
                <label className="workflow-team-editor-toggle">
                  <input
                    type="checkbox"
                    checked={allowFailures}
                    onChange={(e) => setAllowFailures(e.target.checked)}
                  />
                  <span>{t("business.allowFailures")}</span>
                </label>
                {hasOutOfScope && (
                  <label className="workflow-team-editor-toggle">
                    <input
                      type="checkbox"
                      checked={allowOutOfScope}
                      onChange={(e) => setAllowOutOfScope(e.target.checked)}
                    />
                    <span>{t("business.allowOutOfScope")}</span>
                  </label>
                )}
              </div>
              <button type="button" onClick={onCancel}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={hasOutOfScope && !allowOutOfScope}
                title={
                  hasOutOfScope && !allowOutOfScope
                    ? t("business.outOfScopeBlockHint")
                    : undefined
                }
                onClick={() =>
                  onApprove({ allowCommitWithFailures: allowFailures, allowOutOfScope })
                }
              >
                {t("business.approveCommit")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
