import { useEffect } from "react";
import { AlarmClock, ChevronRight, Ellipsis, MessageSquarePlus, Plus, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { workflowTeamName } from "@/services/workflowTeams/types";
import { useWorkflowTeamStore } from "@/store/workflowTeamStore";

export type WorkspaceView = "chat" | "scheduledTasks" | "workflowTeams";

export function SidebarNavigation({
  workspaceView,
  isNewTask,
  activeTeamId,
  onNewTask,
  onOpenScheduledTasks,
  onOpenTeams,
  onCreateTeam,
  onStartTeam
}: {
  workspaceView: WorkspaceView;
  isNewTask: boolean;
  activeTeamId?: string;
  onNewTask: () => void;
  onOpenScheduledTasks: () => void;
  onOpenTeams: () => void;
  onCreateTeam: () => void;
  onStartTeam: (teamId: string) => void;
}) {
  const { t } = useTranslation();
  const loaded = useWorkflowTeamStore((state) => state.loaded);
  const teams = useWorkflowTeamStore((state) => state.teams);
  const loadTeams = useWorkflowTeamStore((state) => state.load);

  useEffect(() => {
    if (!loaded) void loadTeams();
  }, [loaded, loadTeams]);

  const enabledTeams = teams.filter((team) => team.enabled);
  const activeTeam = activeTeamId
    ? enabledTeams.find((team) => team.id === activeTeamId)
    : undefined;
  const visibleTeams = activeTeam
    ? [activeTeam, ...enabledTeams.filter((team) => team.id !== activeTeam.id)].slice(0, 2)
    : enabledTeams.slice(0, 2);
  const hiddenTeamCount = Math.max(teams.length - visibleTeams.length, 0);

  return (
    <>
      <nav className="sidebar-primary-nav" aria-label={t("sidebar.primaryNavigation")}>
        <button
          type="button"
          className={`sidebar-primary-item${workspaceView === "chat" && isNewTask && !activeTeamId ? " active" : ""}`}
          onClick={onNewTask}
        >
          <span className="sidebar-primary-icon new-task" aria-hidden="true">
            <MessageSquarePlus />
          </span>
          <span>{t("sidebar.newConversation")}</span>
        </button>
        <button
          type="button"
          className={`sidebar-primary-item${workspaceView === "scheduledTasks" ? " active" : ""}`}
          onClick={onOpenScheduledTasks}
        >
          <span className="sidebar-primary-icon" aria-hidden="true">
            <AlarmClock />
          </span>
          <span>{t("sidebar.scheduledTasks")}</span>
        </button>
      </nav>

      <section className="sidebar-team-section" aria-label={t("sidebar.teams")}>
        <div className="sidebar-section-header">
          <button
            type="button"
            className="sidebar-section-title"
            onClick={onOpenTeams}
          >
            {t("sidebar.teams")}
          </button>
          <button
            type="button"
            className="sidebar-section-add"
            title={t("workflow.newTeam")}
            aria-label={t("workflow.newTeam")}
            onClick={onCreateTeam}
          >
            <Plus aria-hidden="true" />
          </button>
        </div>
        <ul className="sidebar-team-list">
          {visibleTeams.map((team) => (
            <li key={team.id}>
              <button
                type="button"
                className={`sidebar-team-item${activeTeamId === team.id && workspaceView === "chat" && isNewTask ? " active" : ""}`}
                title={workflowTeamName(team, t)}
                onClick={() => onStartTeam(team.id)}
              >
                <UsersRound aria-hidden="true" />
                <span>{workflowTeamName(team, t)}</span>
              </button>
            </li>
          ))}
          {hiddenTeamCount > 0 ? (
            <li>
              <button type="button" className="sidebar-team-more" onClick={onOpenTeams}>
                <Ellipsis className="sidebar-team-more-icon" aria-hidden="true" />
                <span>{t("sidebar.allTeams")}</span>
                <ChevronRight className="sidebar-team-more-chevron" aria-hidden="true" />
              </button>
            </li>
          ) : null}
        </ul>
      </section>
    </>
  );
}
