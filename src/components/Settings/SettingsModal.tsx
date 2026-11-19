import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  AlarmClock,
  Archive,
  Bot,
  ChartColumn,
  Cog,
  Cpu,
  Gift,
  Info,
  Layers,
  ListTodo,
  Newspaper,
  Pin,
  Puzzle,
  Share2,
  Server,
  UsersRound
} from "lucide-react";
import { AboutTab } from "./AboutTab";
import { ArchivedConversationsTab } from "./ArchivedConversationsTab";
import { CLIAdaptersTab } from "./CLIAdaptersTab";
import { ProvidersTab } from "./ProvidersTab";
import { SettingsTabErrorBoundary } from "./SettingsTabErrorBoundary";
import { GeneralTab } from "./GeneralTab";
import { InfoCardsTab } from "./InfoCardsTab";
import { ScheduledTasksTab } from "./ScheduledTasksTab";
import { SkillsTab } from "./SkillsTab";
import { PluginsTab } from "./PluginsTab";
import { RemoteTab } from "./RemoteTab";
import { UsageTab } from "./UsageTab";
import { WorkflowTeamsTab } from "./WorkflowTeamsTab";
import { McpServersTab } from "./McpServersTab";
import { TodoConversationsPanel } from "@/components/CLI/TodoConversationsPanel";
import { FreebiePage } from "@/components/Freebie/FreebiePage";
import {
  isPinnableSidebarNavId,
  type PinnableSidebarNavId
} from "@/config/sidebarNavigation";
import { useConversationStore } from "@/store/conversationStore";
import { useSettingsStore } from "@/store/settingsStore";

export type SettingsTab = "todos" | "scheduledTasks" | "workflowTeams" | "freebie" | "general" | "cli" | "providers" | "mcp" | "skills" | "plugins" | "feed" | "usage" | "archived" | "remote" | "about";

export const SETTINGS_TABS: { key: SettingsTab; labelKey: string }[] = [
  { key: "todos", labelKey: "settings.tabs.todos" },
  { key: "scheduledTasks", labelKey: "settings.tabs.scheduledTasks" },
  { key: "workflowTeams", labelKey: "settings.tabs.workflowTeams" },
  { key: "freebie", labelKey: "settings.tabs.freebie" },
  { key: "cli", labelKey: "settings.tabs.cli" },
  { key: "providers", labelKey: "settings.tabs.providers" },
  { key: "mcp", labelKey: "settings.tabs.mcp" },
  { key: "skills", labelKey: "settings.tabs.skills" },
  { key: "plugins", labelKey: "settings.tabs.plugins" },
  { key: "feed", labelKey: "settings.tabs.feed" },
  { key: "usage", labelKey: "settings.tabs.usage" },
  { key: "archived", labelKey: "settings.tabs.archived" },
  { key: "general", labelKey: "settings.tabs.general" },
  { key: "remote", labelKey: "settings.tabs.remote" },
  { key: "about", labelKey: "settings.tabs.about" }
];

/** Per-tab icon so the sidebar is scannable at a glance. */
const TAB_ICONS: Record<SettingsTab, ComponentType<{ size?: number | string }>> = {
  todos: ListTodo,
  scheduledTasks: AlarmClock,
  workflowTeams: UsersRound,
  freebie: Gift,
  general: Cog,
  cli: Bot,
  providers: Cpu,
  mcp: Server,
  skills: Layers,
  plugins: Puzzle,
  feed: Newspaper,
  usage: ChartColumn,
  archived: Archive,
  remote: Share2,
  about: Info,
};

/** Grouped sidebar sections; every tab key above appears exactly once. */
const TAB_GROUPS: { groupKey: string; items: SettingsTab[] }[] = [
  { groupKey: "settings.navGroup.workspace", items: ["todos", "scheduledTasks", "workflowTeams", "freebie"] },
  { groupKey: "settings.navGroup.ai", items: ["cli", "providers", "mcp", "skills", "plugins"] },
  { groupKey: "settings.navGroup.data", items: ["feed", "usage", "archived"] },
  { groupKey: "settings.navGroup.system", items: ["general", "remote", "about"] },
];

export interface SettingsWorkspaceHandlers {
  onOpenConversation?: (conversationId: string) => void;
  onOpenFile?: (conversationId: string, messageId: string, path: string) => void;
  onOpenAllConversations?: () => void;
  onNewConversation?: (options?: { agentId?: string }) => void;
  teamPageRequest?: { key: number; teamId?: string; create?: boolean };
}

interface SettingsSurfaceProps extends SettingsWorkspaceHandlers {
  onClose: () => void;
  initialTab?: SettingsTab;
}

interface ControlledSettingsSurfaceProps extends SettingsSurfaceProps {
  activeTab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
}

export function SettingsNav({
  activeTab,
  onTabChange,
  className = "",
  hiddenTabs = [],
  pinnedItems = [],
  onTogglePin,
  todoCount = 0
}: {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  className?: string;
  hiddenTabs?: SettingsTab[];
  pinnedItems?: readonly PinnableSidebarNavId[];
  onTogglePin?: (id: PinnableSidebarNavId) => void;
  todoCount?: number;
}) {
  const { t } = useTranslation();
  const labelByKey = new Map(SETTINGS_TABS.map((tab) => [tab.key, tab.labelKey]));
  const hiddenSet = new Set(hiddenTabs);
  const pinnedSet = new Set(pinnedItems);
  return (
    <nav className={`settings-nav${className ? ` ${className}` : ""}`}>
      {TAB_GROUPS.map((group) => {
        const visibleItems = group.items.filter((key) => !hiddenSet.has(key));
        if (visibleItems.length === 0) return null;
        return (
          <div key={group.groupKey} className="settings-nav-group">
            <div className="settings-nav-group-title">{t(group.groupKey)}</div>
            {visibleItems.map((key) => {
              const Icon = TAB_ICONS[key];
              const isActive = activeTab === key;
              if (isPinnableSidebarNavId(key)) {
                const isPinned = pinnedSet.has(key);
                const pinLabel = t(
                  isPinned ? "settings.unpinFromSidebar" : "settings.pinToSidebar"
                );
                return (
                  <div
                    key={key}
                    className={`settings-nav-row${isActive ? " active" : ""}${isPinned ? " is-pinned" : ""}`}
                  >
                    <button
                      type="button"
                      className={`settings-nav-item${isActive ? " active" : ""}`}
                      onClick={() => onTabChange(key)}
                    >
                      <Icon size={14} />
                      <span className="settings-nav-label">{t(labelByKey.get(key)!)}</span>
                      {key === "todos" && todoCount > 0 && (
                        <span
                          className="settings-nav-badge"
                          aria-label={t("sidebar.todosCount", { count: todoCount })}
                        >
                          {todoCount}
                        </span>
                      )}
                    </button>
                    {onTogglePin && (
                      <button
                        type="button"
                        className={`settings-nav-pin-btn${isPinned ? " is-pinned" : ""}`}
                        aria-pressed={isPinned}
                        aria-label={pinLabel}
                        title={pinLabel}
                        onClick={() => onTogglePin(key)}
                      >
                        <Pin size={13} strokeWidth={1.9} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              }
              return (
                <button
                  key={key}
                  type="button"
                  className={`settings-nav-item${isActive ? " active" : ""}`}
                  onClick={() => onTabChange(key)}
                >
                  <Icon size={14} />
                  <span className="settings-nav-label">{t(labelByKey.get(key)!)}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

function SettingsContent({
  onClose,
  initialTab = "cli",
  activeTab: controlledActiveTab,
  onTabChange,
  onOpenConversation,
  onOpenFile,
  onOpenAllConversations,
  onNewConversation,
  teamPageRequest,
  surface = "modal",
  showHeader = true,
  showNav = true
}: ControlledSettingsSurfaceProps & {
  surface?: "modal" | "page";
  showHeader?: boolean;
  showNav?: boolean;
}) {
  const { t } = useTranslation();
  const currentUser = useConversationStore((s) => s.currentUser);
  const todoCount = useConversationStore((s) =>
    s.conversations.reduce((count, entry) => (entry.todo ? count + 1 : count), 0)
  );
  const sidebarPinnedItems = useSettingsStore((s) => s.sidebarPinnedItems);
  const toggleSidebarNavPinned = useSettingsStore((s) => s.toggleSidebarNavPinned);
  const [internalActiveTab, setInternalActiveTab] = useState<SettingsTab>(initialTab);
  const activeTab = controlledActiveTab ?? internalActiveTab;

  const hiddenTabs = useMemo<SettingsTab[]>(() => {
    const hidden: SettingsTab[] = [];
    const remoteWeb =
      typeof window !== "undefined" && window.freebuddy?.platform === "web";
    if (remoteWeb || (currentUser && !currentUser.isOwner)) {
      hidden.push("mcp");
    }
    return hidden;
  }, [currentUser]);

  useEffect(() => {
    if (!controlledActiveTab) setInternalActiveTab(initialTab);
  }, [controlledActiveTab, initialTab]);

  const handleTabChange = (tab: SettingsTab) => {
    onTabChange?.(tab);
    if (!controlledActiveTab) setInternalActiveTab(tab);
  };

  const handleOpenConversation = (conversationId: string) => {
    if (onOpenConversation) {
      onOpenConversation(conversationId);
      return;
    }
    onClose();
    void useConversationStore.getState().setActive(conversationId);
  };

  const handleNewConversation = (options?: { agentId?: string }) => {
    if (onNewConversation) {
      onNewConversation(options);
      return;
    }
    onClose();
  };

  const isFlushPanel = activeTab === "todos" || activeTab === "freebie";

  const activeContent = (
    <>
      {activeTab === "todos" && (
        <SettingsTabErrorBoundary>
          <TodoConversationsPanel
            fullscreen={false}
            onOpenAllConversations={onOpenAllConversations}
            onOpenConversation={handleOpenConversation}
            onOpenFile={onOpenFile}
            onNewConversation={() => handleNewConversation()}
          />
        </SettingsTabErrorBoundary>
      )}
      {activeTab === "scheduledTasks" && (
        <SettingsTabErrorBoundary>
          <div className="settings-tab-scroll">
            <div className="settings-tab-scroll-inner">
              <ScheduledTasksTab
                onOpenConversation={(conversationId) => {
                  handleOpenConversation(conversationId);
                }}
              />
            </div>
          </div>
        </SettingsTabErrorBoundary>
      )}
      {activeTab === "workflowTeams" && (
        <SettingsTabErrorBoundary>
          <div className="settings-tab-scroll">
            <div className="settings-tab-scroll-inner">
              <WorkflowTeamsTab
                key={teamPageRequest?.key ?? 0}
                initialTeamId={teamPageRequest?.teamId}
                startCreating={teamPageRequest?.create}
              />
            </div>
          </div>
        </SettingsTabErrorBoundary>
      )}
      {activeTab === "freebie" && (
        <SettingsTabErrorBoundary>
          <div className="settings-freebie-host">
            <FreebiePage
              onStartChat={(agentId) => handleNewConversation({ agentId })}
              onOpenAgentSettings={() => handleTabChange("cli")}
            />
          </div>
        </SettingsTabErrorBoundary>
      )}
      {activeTab === "general" && <GeneralTab />}
      {activeTab === "cli" && (
        <SettingsTabErrorBoundary>
          <CLIAdaptersTab />
        </SettingsTabErrorBoundary>
      )}
      {activeTab === "providers" && (
        <SettingsTabErrorBoundary>
          <ProvidersTab />
        </SettingsTabErrorBoundary>
      )}
      {activeTab === "mcp" && !hiddenTabs.includes("mcp") && (
        <SettingsTabErrorBoundary>
          <McpServersTab />
        </SettingsTabErrorBoundary>
      )}
      {activeTab === "skills" && <SkillsTab />}
      {activeTab === "plugins" && <PluginsTab />}
      {activeTab === "feed" && <InfoCardsTab />}
      {activeTab === "usage" && (
        <SettingsTabErrorBoundary>
          <UsageTab />
        </SettingsTabErrorBoundary>
      )}
      {activeTab === "archived" && (
        <SettingsTabErrorBoundary>
          <ArchivedConversationsTab />
        </SettingsTabErrorBoundary>
      )}
      {activeTab === "remote" && <RemoteTab />}
      {activeTab === "about" && <AboutTab />}
    </>
  );

  return (
    <div className={`settings-surface settings-surface-${surface}`}>
      {showHeader && (
        <header className="settings-surface-header">
          <div>
            <h2>{t("common.settings")}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </header>
      )}
      <div className={`settings-layout${showNav ? "" : " settings-layout-content-only"}`}>
        {showNav && (
          <SettingsNav
            activeTab={activeTab}
            onTabChange={handleTabChange}
            hiddenTabs={hiddenTabs}
            pinnedItems={sidebarPinnedItems}
            onTogglePin={(id) => void toggleSidebarNavPinned(id)}
            todoCount={todoCount}
          />
        )}
        <div
          className={`settings-panel${showNav ? "" : " settings-panel-full"}${isFlushPanel ? " settings-panel--flush" : ""}`}
        >
          {activeContent}
        </div>
      </div>
    </div>
  );
}

export function SettingsPage(props: ControlledSettingsSurfaceProps) {
  return (
    <section className="settings-page-shell" aria-label="Settings">
      <SettingsContent {...props} surface="page" showHeader={false} showNav={false} />
    </section>
  );
}

export function SettingsModal(props: SettingsSurfaceProps) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <SettingsContent {...props} surface="modal" />
      </div>
    </div>
  );
}
