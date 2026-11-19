import type { ReactNode } from "react";
import { Dropdown, type MenuProps } from "antd";
import {
  AlarmClock,
  Gift,
  ListTodo,
  MessageSquarePlus,
  PinOff,
  SlidersHorizontal,
  UsersRound
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_PINNED_SIDEBAR_ITEMS,
  type PinnableSidebarNavId
} from "@/config/sidebarNavigation";

export type WorkspaceView = "chat" | "conversationBoard" | "todos" | "scheduledTasks" | "workflowTeams" | "freebie";

export function SidebarNavigation({
  workspaceView,
  isNewTask,
  todoCount = 0,
  pinnedItems = DEFAULT_PINNED_SIDEBAR_ITEMS,
  onNewTask,
  onOpenTodos,
  onOpenScheduledTasks,
  onOpenTeams,
  onOpenFreebie,
  onUnpinItem,
  onCustomizeSidebar
}: {
  workspaceView: WorkspaceView;
  isNewTask: boolean;
  todoCount?: number;
  pinnedItems?: readonly PinnableSidebarNavId[];
  onNewTask: () => void;
  onOpenTodos?: () => void;
  onOpenScheduledTasks: () => void;
  onOpenTeams: () => void;
  onOpenFreebie: () => void;
  onUnpinItem?: (id: PinnableSidebarNavId) => void;
  onCustomizeSidebar?: () => void;
}) {
  const { t } = useTranslation();
  const newTaskActive = workspaceView === "chat" && isNewTask;
  const todosActive = workspaceView === "todos";
  const scheduledTasksActive = workspaceView === "scheduledTasks";
  const workflowTeamsActive = workspaceView === "workflowTeams";
  const freebieActive = workspaceView === "freebie";

  const wrapWithContextMenu = (id: PinnableSidebarNavId, node: ReactNode) => {
    if (!onUnpinItem && !onCustomizeSidebar) return node;
    const menuItems: MenuProps["items"] = [];
    if (onUnpinItem) {
      menuItems.push({
        key: "unpin",
        icon: <PinOff size={14} />,
        label: t("sidebar.unpinFromSidebar")
      });
    }
    if (onCustomizeSidebar) {
      menuItems.push({
        key: "customize",
        icon: <SlidersHorizontal size={14} />,
        label: t("sidebar.customizeSidebar")
      });
    }
    return (
      <Dropdown
        key={id}
        trigger={["contextMenu"]}
        menu={{
          items: menuItems,
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            if (key === "unpin") {
              onUnpinItem?.(id);
            } else if (key === "customize") {
              onCustomizeSidebar?.();
            }
          }
        }}
      >
        {node}
      </Dropdown>
    );
  };

  const renderPinnedItem = (id: PinnableSidebarNavId) => {
    if (id === "todos") {
      if (!onOpenTodos) return null;
      return wrapWithContextMenu(
        id,
        <button
          key={id}
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
      );
    }

    if (id === "scheduledTasks") {
      return wrapWithContextMenu(
        id,
        <button
          key={id}
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
      );
    }

    if (id === "workflowTeams") {
      return wrapWithContextMenu(
        id,
        <button
          key={id}
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
      );
    }

    return wrapWithContextMenu(
      id,
      <button
        key={id}
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
    );
  };

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
        {pinnedItems.map((id) => renderPinnedItem(id))}
      </nav>
    </>
  );
}
