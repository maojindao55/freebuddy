import { useEffect, useState, type CSSProperties } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import { Menu, Monitor, Moon, PanelLeft, Sun } from "lucide-react";

import sidebarLogoUrl from "../assets/sidebar-logo.png";
import { ChatView } from "./components/CLI/ChatView";
import { ReplayButton } from "./components/CLI/ReplayBar";
import { ConversationList } from "./components/CLI/ConversationList";
import {
  SidebarNavigation,
  type WorkspaceView
} from "./components/CLI/SidebarNavigation";
import { ImageLightboxProvider } from "./components/CLI/ImageLightbox";
import { PermissionDialog } from "./components/CLI/PermissionDialog";
import { AuthenticationDialog } from "./components/CLI/AuthenticationDialog";
import { DetailColumn } from "./components/CLI/DetailColumn";
import { AgentBridgeListener } from "./components/AgentBridge/AgentBridgeListener";
import { AgentBridgeToasts } from "./components/AgentBridge/AgentBridgeToasts";
import {
  SettingsNav,
  SettingsPage,
  type SettingsTab
} from "./components/Settings/SettingsModal";
import { CliInstallPanelHost } from "./components/Settings/CliInstallPanelHost";
import { ScheduledTasksTab } from "./components/Settings/ScheduledTasksTab";
import { WorkflowTeamsTab } from "./components/Settings/WorkflowTeamsTab";
import { useCliExecutorStore } from "./store/cliExecutorStore";
import { useConversationStore } from "./store/conversationStore";
import { useSettingsStore } from "./store/settingsStore";
import { useUpdaterStore } from "./store/updaterStore";
import { useDetailLayoutStore, selectDetailWidth, DETAIL_MIN_WIDTH } from "./store/detailLayoutStore";
import { useNewTaskUiStore } from "./store/newTaskUiStore";
import i18next from "i18next";
import { useTranslation } from "react-i18next";

function GearIcon() {
  return (
    <svg
      className="footer-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function nextThemePreference(theme: "system" | "light" | "dark") {
  if (theme === "system") return "light";
  if (theme === "light") return "dark";
  return "system";
}

function BrandMark() {
  return (
    <span className="sidebar-logo" aria-hidden="true">
      <img src={sidebarLogoUrl} alt="" className="sidebar-logo-img" />
    </span>
  );
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  const Icon = collapsed ? Menu : PanelLeft;
  return <Icon className="footer-icon" strokeWidth={1.7} aria-hidden="true" />;
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>("cli");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("chat");
  const [teamPageRequest, setTeamPageRequest] = useState<{
    key: number;
    teamId?: string;
    create?: boolean;
  }>({ key: 0 });

  const isElectron =
    Boolean(window.freebuddy?.cli) || navigator.userAgent.includes("Electron");
  const platform = window.freebuddy?.platform ?? "";

  const loadExecutors = useCliExecutorStore((s) => s.load);
  const loadConversations = useConversationStore((s) => s.load);
  const refreshConversationList = useConversationStore((s) => s.refreshList);
  useEffect(() => {
    void (async () => {
      await loadExecutors();
      await loadConversations();
    })();
  }, [loadExecutors, loadConversations]);

  useEffect(() => {
    const off = window.freebuddy?.scheduledTasks?.onChanged?.((task) => {
      if (!task || task.lastStatus === "completed" || task.lastStatus === "failed") {
        void refreshConversationList();
      }
    });
    return () => off?.();
  }, [refreshConversationList]);

  useEffect(() => {
    const off = window.freebuddy?.window?.onChromeVisible?.((visible) => {
      setChromeVisible(visible);
    });
    return () => {
      off?.();
    };
  }, []);

  const { t } = useTranslation();
  const loadSettings = useSettingsStore((s) => s.load);
  const themePreference = useSettingsStore((s) => s.theme);
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const refreshSystemTheme = useSettingsStore((s) => s.refreshSystemTheme);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => refreshSystemTheme();
    media.addEventListener?.("change", handleChange);
    return () => {
      media.removeEventListener?.("change", handleChange);
    };
  }, [refreshSystemTheme]);

  const loadUpdater = useUpdaterStore((s) => s.load);
  useEffect(() => {
    void loadUpdater();
  }, [loadUpdater]);
  const loadDetailLayout = useDetailLayoutStore((s) => s.load);
  const activeDetailTab = useDetailLayoutStore((s) => s.activeTab);
  const detailWidth = useDetailLayoutStore(selectDetailWidth);
  useEffect(() => {
    void loadDetailLayout();
  }, [loadDetailLayout]);
  useEffect(() => {
    if (activeDetailTab === "preview") {
      setSidebarCollapsed(true);
    }
  }, [activeDetailTab]);

  const [winWidth, setWinWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280
  );
  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const sidebarWidth = sidebarCollapsed ? 0 : 272;
  const effectiveDetailWidth = Math.min(
    detailWidth,
    Math.max(DETAIL_MIN_WIDTH, winWidth - sidebarWidth - 420 - 8)
  );
  const updateStatus = useUpdaterStore((s) => s.status);
  const appVersion = useUpdaterStore((s) => s.appVersion);
  const latestVersion = useUpdaterStore((s) => s.latestVersion);
  const downloadPercent = useUpdaterStore((s) => s.downloadPercent);

  const openSettings = (tab: SettingsTab = "cli") => {
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  };

  const showUpdateCapsule =
    updateStatus === "available" ||
    updateStatus === "downloading" ||
    updateStatus === "downloaded";
  const updateCapsuleText =
    updateStatus === "downloaded"
      ? t("updater.footerInstall")
      : updateStatus === "downloading"
        ? t("updater.footerDownloading", { percent: Math.round(downloadPercent) })
        : t("updater.footerUpdate");

  useEffect(() => {
    document.documentElement.lang = i18next.language ?? "en";
    const handler = (lng: string) => {
      document.documentElement.lang = lng;
    };
    i18next.on("languageChanged", handler);
    return () => i18next.off("languageChanged", handler);
  }, []);

  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const setActive = useConversationStore((s) => s.setActive);
  const activeConversation = conversations.find((c) => c.id === activeId);
  const isNewTask = !activeConversation;
  const setNewTaskMode = useNewTaskUiStore((s) => s.setTaskMode);
  const setRequestedTeamId = useNewTaskUiStore((s) => s.setRequestedTeamId);
  const startNewTask = () => {
    setRequestedTeamId(undefined);
    setNewTaskMode("normal");
    setSettingsOpen(false);
    setWorkspaceView("chat");
    void setActive(undefined);
  };
  const openScheduledTasks = () => {
    setSettingsOpen(false);
    setWorkspaceView("scheduledTasks");
    void setActive(undefined);
  };
  const openWorkflowTeams = (request?: { teamId?: string; create?: boolean }) => {
    setSettingsOpen(false);
    setWorkspaceView("workflowTeams");
    setTeamPageRequest((current) => ({
      key: current.key + 1,
      teamId: request?.teamId,
      create: request?.create
    }));
    void setActive(undefined);
  };

  useEffect(() => {
    if (activeId) setWorkspaceView("chat");
  }, [activeId]);

  const workspaceTitle = settingsOpen
    ? t("common.settings")
    : workspaceView === "scheduledTasks"
      ? t("scheduledTasks.title")
      : workspaceView === "workflowTeams"
        ? t("workflow.teamList")
        : activeConversation?.title ?? t("app.chat");
  // Select the running *count* rather than the whole live map: App (the root)
  // re-renders only when the number of running conversations changes, not on
  // every streaming chunk. Otherwise every background event would re-render
  // the entire tree.
  const runningCount = useConversationStore((s) => {
    let n = 0;
    for (const c of s.conversations) {
      const st = s.live[c.id]?.status;
      if (st === "running" || st === "starting") n += 1;
    }
    return n;
  });

  const renderToggleButton = (extraClass = "") => (
    <button
      type="button"
      className={`sidebar-toggle${extraClass ? ` ${extraClass}` : ""}`}
      title={t(sidebarCollapsed ? "sidebar.expand" : "sidebar.collapse")}
      aria-label={t(sidebarCollapsed ? "sidebar.expand" : "sidebar.collapse")}
      aria-expanded={!sidebarCollapsed}
      onClick={() => setSidebarCollapsed((v) => !v)}
    >
      <SidebarToggleIcon collapsed={sidebarCollapsed} />
    </button>
  );

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#10b981",
          colorSuccess: "#10b981",
          colorError: "#ef4444",
          colorText: theme === "dark" ? "#f8fafc" : "#0f172a",
          colorTextDescription: theme === "dark" ? "#64748b" : "#6b7280",
          colorBgContainer: theme === "dark" ? "#111b2d" : "#ffffff",
          fontFamily: "var(--fb-font)",
          borderRadius: 8,
          wireframe: false
        },
        algorithm:
          theme === "dark"
            ? antdTheme.darkAlgorithm
            : antdTheme.defaultAlgorithm
      }}
    >
    <ImageLightboxProvider>
    <div
      className={`app-shell${isElectron ? " electron-shell" : ""}${!settingsOpen && workspaceView === "chat" && isNewTask ? " new-task-mode" : ""}${!settingsOpen && workspaceView !== "chat" ? " tool-page-mode" : ""}${settingsOpen ? " settings-mode" : ""}${!settingsOpen && sidebarCollapsed ? " sidebar-collapsed" : ""}${!chromeVisible ? " chrome-hidden" : ""}${platform ? ` platform-${platform}` : ""}`}
      data-theme={theme}
      style={{ "--fb-detail-width": `${effectiveDetailWidth}px` } as CSSProperties}
    >
      <aside className={`sidebar${settingsOpen ? " settings-sidebar" : ""}`}>
        {settingsOpen ? (
          <>
            <div className="settings-sidebar-header">
              <button
                type="button"
                className="settings-back-button"
                onClick={() => setSettingsOpen(false)}
              >
                <span aria-hidden="true">←</span>
                {t("settings.backToApp")}
              </button>
            </div>
            <SettingsNav
              activeTab={settingsInitialTab}
              onTabChange={setSettingsInitialTab}
              className="settings-nav-sidebar"
            />
          </>
        ) : (
          <>
            <div className="sidebar-header">
              <div className="sidebar-brand">
                <BrandMark />
                <div className="sidebar-brand-text">
                  <h1>{t("app.brand")}</h1>
                </div>
              </div>
              {renderToggleButton()}
            </div>

            <SidebarNavigation
              workspaceView={workspaceView}
              isNewTask={isNewTask}
              onNewTask={startNewTask}
              onOpenScheduledTasks={openScheduledTasks}
              onOpenTeams={() => openWorkflowTeams()}
            />
            <ConversationList />

            <div className="sidebar-footer">
              <button
                className="footer-action"
                onClick={() => openSettings("cli")}
              >
                <GearIcon />
                {t("common.settings")}
              </button>
              {appVersion && (
                <span className="footer-version-wrap">
                  <span className="footer-version">v{appVersion}</span>
                  {showUpdateCapsule && (
                    <button
                      type="button"
                      className={`footer-update-pill ${updateStatus}`}
                      title={t("updater.footerOpen", { version: latestVersion ?? "" })}
                      aria-label={t("updater.footerOpen", { version: latestVersion ?? "" })}
                      onClick={() => openSettings("about")}
                    >
                      {updateCapsuleText}
                    </button>
                  )}
                </span>
              )}
              <button
                className="footer-toggle"
                title={t("sidebar.toggleTheme")}
                aria-label={t("sidebar.toggleTheme")}
                data-theme-preference={themePreference}
                onClick={() => void setTheme(nextThemePreference(themePreference))}
              >
                {themePreference === "system" ? (
                  <Monitor className="footer-icon" strokeWidth={1.7} />
                ) : themePreference === "dark" ? (
                  <Sun className="footer-icon" strokeWidth={1.7} />
                ) : (
                  <Moon className="footer-icon" strokeWidth={1.7} />
                )}
              </button>
            </div>
          </>
        )}
      </aside>

      <main className={`workspace${settingsOpen ? " settings-workspace" : ""}`}>
        <header className="titlebar">
          {sidebarCollapsed && renderToggleButton("floating")}
          <div
            className="breadcrumb"
            title={workspaceTitle}
          >
            <strong>{workspaceTitle}</strong>
          </div>
          {settingsOpen ? (
            <div className="titlebar-actions titlebar-actions-plain">
              <button
                type="button"
                className="text-button"
                onClick={() => setSettingsOpen(false)}
              >
                {t("common.close")}
              </button>
            </div>
          ) : workspaceView === "chat" && activeConversation && (
            <div className="titlebar-actions titlebar-actions-plain">
              <ReplayButton />
            </div>
          )}

        </header>

        <section
          className={`chat-section${settingsOpen ? " settings-section-host" : ""}`}
          aria-label={workspaceTitle}
        >
          {settingsOpen ? (
            <SettingsPage
              activeTab={settingsInitialTab}
              onTabChange={setSettingsInitialTab}
              onClose={() => setSettingsOpen(false)}
            />
          ) : workspaceView === "scheduledTasks" ? (
            <section className="workspace-tool-page">
              <div className="workspace-tool-page-inner">
                <ScheduledTasksTab
                  onOpenConversation={(conversationId) => {
                    void loadConversations().then(() => setActive(conversationId));
                    setWorkspaceView("chat");
                  }}
                />
              </div>
            </section>
          ) : workspaceView === "workflowTeams" ? (
            <section className="workspace-tool-page">
              <div className="workspace-tool-page-inner">
                <WorkflowTeamsTab
                  key={teamPageRequest.key}
                  initialTeamId={teamPageRequest.teamId}
                  startCreating={teamPageRequest.create}
                />
              </div>
            </section>
          ) : (
            <ChatView />
          )}
        </section>
      </main>

      {activeConversation && !settingsOpen && workspaceView === "chat" && (
        <DetailColumn runningCount={runningCount} />
      )}

      <CliInstallPanelHost />
      <PermissionDialog />
      <AuthenticationDialog />
      <AgentBridgeListener />
      <AgentBridgeToasts />
    </div>
    </ImageLightboxProvider>
    </ConfigProvider>
  );
}

export default App;
