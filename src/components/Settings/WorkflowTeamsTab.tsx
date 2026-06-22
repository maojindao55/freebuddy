import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useWorkflowTeamStore } from "@/store/workflowTeamStore";
import type { WorkflowTeam } from "@/services/workflowTeams/types";
import { WorkflowTeamList } from "./WorkflowTeamList";
import { WorkflowTeamEditor } from "./WorkflowTeamEditor";

export function WorkflowTeamsTab() {
  const { t } = useTranslation();
  const loaded = useWorkflowTeamStore((s) => s.loaded);
  const load = useWorkflowTeamStore((s) => s.load);
  const teams = useWorkflowTeamStore((s) => s.teams);
  const [editing, setEditing] = useState<WorkflowTeam | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  return (
    <div className="settings-tab">
      <div className="settings-section-heading">
        <h3 className="settings-section-title">{t("workflow.teamList")}</h3>
        <span className="settings-section-desc">
          {t("workflow.teamExecutionHint")}
        </span>
      </div>

      {editing || creating ? (
        <WorkflowTeamEditor
          team={editing ?? undefined}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
          }}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
        />
      ) : (
        <WorkflowTeamList
          teams={teams}
          onNew={() => setCreating(true)}
          onEdit={(t) => setEditing(t)}
        />
      )}
    </div>
  );
}
