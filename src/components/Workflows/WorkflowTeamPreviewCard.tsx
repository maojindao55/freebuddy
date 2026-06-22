import { useTranslation } from "react-i18next";

import type { WorkflowTeamPreview } from "@/services/workflowTeams/types";

export function WorkflowTeamPreviewCard({
  preview,
  onRun,
  onCancel
}: {
  preview: WorkflowTeamPreview;
  onRun: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="workflow-team-preview-card">
      <header className="workflow-team-preview-header">
        <strong>{preview.teamName}</strong>
        <span className="muted small">{t("workflow.teamPlanPreview")}</span>
      </header>
      <p className="workflow-plan-goal">{preview.goal}</p>

      <dl className="workflow-team-preview-stats">
        <div>
          <dt>{t("workflow.teamRoles")}</dt>
          <dd>{preview.roleSummary.length}</dd>
        </div>
        <div>
          <dt>{t("workflow.steps")}</dt>
          <dd>{preview.routeSummary.length}</dd>
        </div>
        <div>
          <dt>{t("workflow.writeNodes")}</dt>
          <dd>{preview.writeNodeCount}</dd>
        </div>
        <div>
          <dt>{t("workflow.approvalNodes")}</dt>
          <dd>{preview.approvalNodeCount}</dd>
        </div>
        <div>
          <dt>{t("workflow.loops")}</dt>
          <dd>{preview.maxLoops}</dd>
        </div>
      </dl>

      <div className="workflow-team-preview-roles">
        <strong>{t("workflow.worksWith")}</strong>
        <ul className="muted small">
          {preview.roleSummary.map((r) => (
            <li key={r.roleId}>
              {r.roleLabel} - {r.agentName}
            </li>
          ))}
        </ul>
      </div>

      <div className="workflow-team-preview-route">
        <strong>{t("workflow.routeSummary")}</strong>
        <ol>
          {preview.routeSummary.map((node) => (
            <li key={node.nodeId} className={node.mode}>
              {node.title}{" "}
              <small>
                ({node.mode}
                {node.agentName ? ` - ${node.agentName}` : ""})
              </small>
            </li>
          ))}
        </ol>
      </div>

      <div className="workflow-team-preview-actions">
        <button type="button" className="primary" onClick={onRun}>
          {t("workflow.run")}
        </button>
        <button type="button" onClick={onCancel}>
          {t("workflow.cancel")}
        </button>
      </div>
    </section>
  );
}
