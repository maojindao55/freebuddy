import { useTranslation } from "react-i18next";

import type { BusinessWorkspace } from "@/services/businessWorkspaces/types";
import { useBusinessWorkspaceStore } from "@/store/businessWorkspaceStore";

export function BusinessWorkspaceList({
  workspaces,
  onNew,
  onEdit
}: {
  workspaces: BusinessWorkspace[];
  onNew: () => void;
  onEdit: (workspace: BusinessWorkspace) => void;
}) {
  const { t } = useTranslation();
  const update = useBusinessWorkspaceStore((s) => s.update);
  const remove = useBusinessWorkspaceStore((s) => s.remove);

  return (
    <div className="business-workspace-list">
      <div className="business-workspace-list-actions">
        <button type="button" className="primary" onClick={onNew}>
          + {t("business.newWorkspace")}
        </button>
      </div>
      {workspaces.length === 0 ? (
        <p className="muted">{t("business.noWorkspaces")}</p>
      ) : (
        <ul className="business-workspace-list-items">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="business-workspace-card">
              <div className="business-workspace-card-main">
                <div className="business-workspace-card-title">
                  <strong>{workspace.name || workspace.id}</strong>
                  {!workspace.surfaces.some((s) => s.enabled) && (
                    <span className="workflow-team-badge muted">
                      {t("workflow.disableTeam")}
                    </span>
                  )}
                </div>
                {workspace.description && (
                  <p className="business-workspace-card-desc">{workspace.description}</p>
                )}
                <div className="business-workspace-card-meta">
                  <span>
                    {workspace.surfaces.length} {t("business.surfaces").toLowerCase()}
                  </span>
                  <span>·</span>
                  <span>
                    {workspace.surfaces.filter((s) => s.enabled).length}/
                    {workspace.surfaces.length} {t("business.surface").toLowerCase()}
                  </span>
                  {workspace.defaultTeamId && (
                    <>
                      <span>·</span>
                      <span>{workspace.defaultTeamId}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="business-workspace-card-actions">
                <button type="button" onClick={() => onEdit(workspace)}>
                  {t("common.edit")}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    if (window.confirm(t("business.confirmDeleteWorkspace"))) {
                      void remove(workspace.id);
                    }
                  }}
                >
                  {t("common.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
