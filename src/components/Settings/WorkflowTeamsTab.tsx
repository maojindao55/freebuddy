import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useWorkflowTeamStore } from "@/store/workflowTeamStore";
import { useDelegationTeamStore } from "@/store/delegationStore";
import { workflowTeamsClient } from "@/services/workflowTeams/client";
import { delegationClient } from "@/services/delegation/client";
import type {
  AnyTeam,
  DelegationTeam,
  WorkflowTeam
} from "@/services/workflowTeams/types";
import { isDelegationTeam } from "@/services/workflowTeams/types";
import { WorkflowTeamList } from "./WorkflowTeamList";
import { WorkflowTeamEditor } from "./WorkflowTeamEditor";
import { DelegationTeamEditor } from "./DelegationTeamEditor";

type EditingTarget =
  | { kind: "workflow"; team: WorkflowTeam }
  | { kind: "delegation"; team: DelegationTeam }
  | null;

export function WorkflowTeamsTab({
  initialTeamId,
  startCreating = false
}: {
  initialTeamId?: string;
  startCreating?: boolean;
}) {
  const { t } = useTranslation();
  const refresh = useWorkflowTeamStore((s) => s.refresh);
  const teams = useWorkflowTeamStore((s) => s.teams);

  const delRefresh = useDelegationTeamStore((s) => s.refresh);
  const delegationTeams = useDelegationTeamStore((s) => s.teams);

  const [editing, setEditing] = useState<EditingTarget>(null);
  const [creatingKind, setCreatingKind] = useState<"workflow" | "delegation" | null>(
    startCreating ? "workflow" : null
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void delRefresh();
  }, [delRefresh]);

  useEffect(() => {
    const off = workflowTeamsClient.onChanged(() => {
      void refresh();
    });
    return () => {
      off?.();
    };
  }, [refresh]);

  useEffect(() => {
    const off = delegationClient.onChanged(() => {
      void delRefresh();
    });
    return () => {
      off?.();
    };
  }, [delRefresh]);

  const allTeams = useMemo<AnyTeam[]>(
    () => [...teams, ...delegationTeams],
    [teams, delegationTeams]
  );

  useEffect(() => {
    if (startCreating || !initialTeamId) return;
    const wf = teams.find((entry) => entry.id === initialTeamId);
    if (wf) {
      setCreatingKind(null);
      setEditing({ kind: "workflow", team: wf });
      return;
    }
    const dl = delegationTeams.find((entry) => entry.id === initialTeamId);
    if (dl) {
      setCreatingKind(null);
      setEditing({ kind: "delegation", team: dl });
    }
  }, [initialTeamId, startCreating, teams, delegationTeams]);

  const stopEditing = () => {
    setEditing(null);
    setCreatingKind(null);
  };

  const isDelegationEditor =
    editing?.kind === "delegation" || creatingKind === "delegation";
  const isEditingOrCreating = editing !== null || creatingKind !== null;

  return (
    <div className="settings-tab">
      <div className="settings-section-heading">
        <h3 className="settings-section-title">{t("workflow.teamList")}</h3>
        <span className="settings-section-desc">
          {t("workflow.teamExecutionHint")}
        </span>
      </div>

      {isEditingOrCreating ? (
        isDelegationEditor ? (
          <DelegationTeamEditor
            teamId={
              editing?.kind === "delegation" ? editing.team.id : undefined
            }
            onDone={stopEditing}
          />
        ) : (
          <WorkflowTeamEditor
            team={editing?.kind === "workflow" ? editing.team : undefined}
            onSaved={stopEditing}
            onCancel={stopEditing}
          />
        )
      ) : (
        <WorkflowTeamList
          teams={allTeams}
          onNew={() => setCreatingKind("workflow")}
          onNewDelegation={() => setCreatingKind("delegation")}
          onEdit={(team) =>
            setEditing(
              isDelegationTeam(team)
                ? { kind: "delegation", team }
                : { kind: "workflow", team }
            )
          }
        />
      )}
    </div>
  );
}
