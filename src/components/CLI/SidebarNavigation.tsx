import { AlarmClock, ChartNoAxesCombined, MessageSquarePlus, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";

export type WorkspaceView = "chat" | "scheduledTasks" | "workflowTeams" | "usage";

export function SidebarNavigation({
  workspaceView,
  isNewTask,
  onNewTask,
  onOpenScheduledTasks,
  onOpenTeams,
  onOpenUsage
}: {
  workspaceView: WorkspaceView;
  isNewTask: boolean;
  onNewTask: () => void;
  onOpenScheduledTasks: () => void;
  onOpenTeams: () => void;
  onOpenUsage: () => void;
}) {
  const { t } = useTranslation();
  const newTaskActive = workspaceView === "chat" && isNewTask;
  const scheduledTasksActive = workspaceView === "scheduledTasks";
  const workflowTeamsActive = workspaceView === "workflowTeams";
  const usageActive = workspaceView === "usage";

  return (
    <>
      <nav className="sidebar-primary-nav" aria-label={t("sidebar.primaryNavigation")}>
        <button
          type="button"
          className={`sidebar-primary-item${newTaskActive ? " active" : ""}`}
          aria-current={newTaskActive ? "page" : undefined}
          onClick={onNewTask}
        >
          <span className="sidebar-primary-icon new-task" aria-hidden="true">
            <MessageSquarePlus />
          </span>
          <span>{t("sidebar.newConversation")}</span>
        </button>
        <button
          type="button"
          className={`sidebar-primary-item${scheduledTasksActive ? " active" : ""}`}
          aria-current={scheduledTasksActive ? "page" : undefined}
          onClick={onOpenScheduledTasks}
        >
          <span className="sidebar-primary-icon" aria-hidden="true">
            <AlarmClock />
          </span>
          <span>{t("sidebar.scheduledTasks")}</span>
        </button>
        <button
          type="button"
          className={`sidebar-primary-item${workflowTeamsActive ? " active" : ""}`}
          aria-current={workflowTeamsActive ? "page" : undefined}
          onClick={onOpenTeams}
        >
          <span className="sidebar-primary-icon" aria-hidden="true">
            <UsersRound />
          </span>
          <span>{t("sidebar.teams")}</span>
        </button>
        <button
          type="button"
          className={`sidebar-primary-item${usageActive ? " active" : ""}`}
          aria-current={usageActive ? "page" : undefined}
          onClick={onOpenUsage}
        >
          <span className="sidebar-primary-icon" aria-hidden="true">
            <ChartNoAxesCombined />
          </span>
          <span>{t("sidebar.usage")}</span>
        </button>
      </nav>
    </>
  );
}
