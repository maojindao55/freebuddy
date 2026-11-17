import {
  AlarmClock,
  Gift,
  ListTodo,
  MessageSquarePlus,
  UsersRound
} from "lucide-react";
import { useTranslation } from "react-i18next";

export type WorkspaceView = "chat" | "conversationBoard" | "todos" | "scheduledTasks" | "workflowTeams" | "freebie";

export function SidebarNavigation({
  workspaceView,
  isNewTask,
  todoCount = 0,
  onNewTask,
  onOpenTodos,
  onOpenScheduledTasks,
  onOpenTeams,
  onOpenFreebie
}: {
  workspaceView: WorkspaceView;
  isNewTask: boolean;
  todoCount?: number;
  onNewTask: () => void;
  onOpenTodos?: () => void;
  onOpenScheduledTasks: () => void;
  onOpenTeams: () => void;
  onOpenFreebie: () => void;
}) {
  const { t } = useTranslation();
  const newTaskActive = workspaceView === "chat" && isNewTask;
  const todosActive = workspaceView === "todos";
  const scheduledTasksActive = workspaceView === "scheduledTasks";
  const workflowTeamsActive = workspaceView === "workflowTeams";
  const freebieActive = workspaceView === "freebie";

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
        {onOpenTodos && (
          <button
            type="button"
            className={`sidebar-primary-item${todosActive ? " active" : ""}`}
            aria-current={todosActive ? "page" : undefined}
            onClick={onOpenTodos}
          >
            <span className="sidebar-primary-icon" aria-hidden="true">
              <ListTodo />
            </span>
            <span>{t("sidebar.todos")}</span>
            {todoCount > 0 && (
              <span
                className="sidebar-primary-badge"
                aria-label={t("sidebar.todosCount", { count: todoCount })}
              >
                {todoCount}
              </span>
            )}
          </button>
        )}
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
          className={`sidebar-primary-item${freebieActive ? " active" : ""}`}
          aria-current={freebieActive ? "page" : undefined}
          onClick={onOpenFreebie}
        >
          <span className="sidebar-primary-icon freebie" aria-hidden="true">
            <Gift />
          </span>
          <span>{t("sidebar.freebie")}</span>
        </button>
      </nav>
    </>
  );
}
