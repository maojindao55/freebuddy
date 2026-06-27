import { useTranslation } from "react-i18next";

import type {
  BusinessAssignmentPlan,
  BusinessContractDraft
} from "@/services/businessWorkspaces/types";

export function BusinessAssignmentPreviewCard({
  assignmentPlan,
  contractDraft,
  errors,
  onRun,
  onCancel
}: {
  assignmentPlan: BusinessAssignmentPlan | null;
  contractDraft: BusinessContractDraft | null;
  errors: string[];
  onRun: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  if (errors.length > 0) {
    return (
      <div className="business-assignment-preview">
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

  if (!assignmentPlan) return null;

  return (
    <div className="business-assignment-preview">
      <div className="business-assignment-preview-header">
        <h4>{t("business.assignmentPreview")}</h4>
        <p className="muted small">{assignmentPlan.summary}</p>
      </div>

      <ul className="business-assignment-surfaces">
        {assignmentPlan.surfaces.map((surface) => (
          <li key={surface.surfaceId} className="business-assignment-surface">
            <div className="business-assignment-surface-head">
              <strong>{surface.surfaceId}</strong>
              <span className="workflow-team-badge muted">{surface.agentId}</span>
              {surface.writes && (
                <span className="workflow-team-badge write">{t("workflow.writeNodes")}</span>
              )}
            </div>
            <div className="business-assignment-surface-meta">
              <span className="muted small">{surface.repoPath}</span>
            </div>
            <ul className="business-assignment-tasks">
              {surface.tasks.map((task, i) => (
                <li key={i}>{task}</li>
              ))}
            </ul>
            {surface.dependsOnSurfaceIds.length > 0 && (
              <p className="muted small">
                {t("business.surfaces")}: {surface.dependsOnSurfaceIds.join(", ")}
              </p>
            )}
            {surface.verifyCommands.length > 0 && (
              <p className="muted small">
                {t("business.verifyCommands")}: {surface.verifyCommands.join(", ")}
              </p>
            )}
          </li>
        ))}
      </ul>

      {contractDraft && (
        <div className="business-assignment-contract">
          <h5>{t("business.contractDraft")}</h5>
          <p className="muted small">{contractDraft.title}</p>
          <div className="business-assignment-contract-meta">
            <span>
              {contractDraft.providerSurfaceIds.join(", ")} →{" "}
              {contractDraft.consumerSurfaceIds.join(", ")}
            </span>
            <span>·</span>
            <span>
              {contractDraft.endpoints.length} {t("business.contractDraft").toLowerCase()}
            </span>
          </div>
        </div>
      )}

      <div className="business-assignment-preview-actions">
        <button type="button" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className="primary" onClick={onRun}>
          {t("business.approveAndRun")}
        </button>
      </div>
    </div>
  );
}
