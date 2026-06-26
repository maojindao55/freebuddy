import { useTranslation } from "react-i18next";

import type { WorkflowTeam } from "@/services/workflowTeams/types";
import {
  workflowTeamDescription,
  workflowTeamName
} from "@/services/workflowTeams/types";
import { useWorkflowTeamStore } from "@/store/workflowTeamStore";

export function WorkflowTeamList({
  teams,
  onEdit
}: {
  teams: WorkflowTeam[];
  onNew: () => void;
  onEdit: (team: WorkflowTeam) => void;
}) {
  const { t } = useTranslation();
  const update = useWorkflowTeamStore((s) => s.update);
  const remove = useWorkflowTeamStore((s) => s.remove);

  return (
    <div className="workflow-team-list">
      <div className="workflow-team-list-actions">
        <button
          type="button"
          className="primary"
          onClick={() => window.alert(t("workflow.newTeamComingSoon"))}
        >
          + {t("workflow.newTeam")}
        </button>
      </div>
      {teams.length === 0 ? (
        <p className="muted">{t("workflow.noTeams")}</p>
      ) : (
        <ul className="workflow-team-list-items">
          {teams.map((team) => {
            const name = workflowTeamName(team, t);
            const description = workflowTeamDescription(team, t);
            return (
              <li key={team.id} className="workflow-team-card">
                <div className="workflow-team-card-main">
                  <div className="workflow-team-card-title">
                    <strong>{name}</strong>
                    <span
                      className={
                        team.source === "builtin"
                          ? "workflow-team-badge builtin"
                          : "workflow-team-badge user"
                      }
                    >
                      {team.source === "builtin"
                        ? t("workflow.builtinTeam")
                        : t("workflow.userTeam")}
                    </span>
                    {!team.enabled && (
                      <span className="workflow-team-badge muted">
                        {t("workflow.disableTeam")}
                      </span>
                    )}
                  </div>
                  {description && (
                    <p className="workflow-team-card-desc">{description}</p>
                  )}
                  <div className="workflow-team-card-meta">
                    <span>
                      {team.roles.length} {t("workflow.teamRoles").toLowerCase()}
                    </span>
                    <span>·</span>
                    <span>
                      {team.policy.allowWrites
                        ? t("workflow.allowWrites")
                        : t("workflow.allowWrites") + ": " + t("workflow.denied")}
                    </span>
                    <span>·</span>
                    <span>
                      {t("workflow.maxLoops")} {team.policy.maxLoops}
                    </span>
                  </div>
                </div>
                <div className="workflow-team-card-actions">
                  <button type="button" onClick={() => onEdit(team)}>
                    {t("common.edit")}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void update(team.id, { enabled: !team.enabled })
                    }
                  >
                    {team.enabled
                      ? t("workflow.disableTeam")
                      : t("workflow.enableTeam")}
                  </button>
                  {team.source === "user" && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        if (window.confirm(t("workflow.confirmDeleteTeam"))) {
                          void remove(team.id);
                        }
                      }}
                    >
                      {t("workflow.deleteTeam")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
