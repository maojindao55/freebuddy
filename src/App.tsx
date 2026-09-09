import { useEffect, useState, type CSSProperties } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import { Menu, Monitor, Moon, PanelLeft, PanelRight, Search, Share2, Sun } from "lucide-react";

import sidebarLogoUrl from "../assets/sidebar-logo.png";
import { ChatView } from "./components/CLI/ChatView";
import { TitlebarOverflowMenu } from "./components/CLI/ReplayBar";
import { ConversationList } from "./components/CLI/ConversationList";
import { ConversationCommandPalette } from "./components/CLI/ConversationCommandPalette";
import { ConversationContextDialog } from "./components/CLI/ConversationContextDialog";
import { ImportCodexSessionDialog } from "./components/CLI/ImportCodexSessionDialog";
import {
  SidebarNavigation,
  type WorkspaceView
} from "./components/CLI/SidebarNavigation";
import { ImageLightboxProvider } from "./components/CLI/ImageLightbox";
import { PermissionDialog } from "./components/CLI/PermissionDialog";
import { AuthenticationDialog } from "./components/CLI/AuthenticationDialog";
import { TaskReceiptDialog } from "./components/ButlerBuddy/TaskReceiptDialog";
import { ExportDebugLogsDialog } from "./components/Settings/ExportDebugLogsDialog";
import { DetailColumn } from "./components/CLI/DetailColumn";
import { AgentBridgeListener } from "./components/AgentBridge/AgentBridgeListener";
import { AgentBridgeToasts } from "./components/AgentBridge/AgentBridgeToasts";
import {
  SettingsNav,
  SettingsPage,
  type SettingsTab
} from "./components/Settings/SettingsModal";
import { SidebarUserMenu } from "./components/SidebarUserMenu";
import { CliInstallPanelHost } from "./components/Settings/CliInstallPanelHost";
import { ScheduledTasksTab } from "./components/Settings/ScheduledTasksTab";
import { WorkflowTeamsTab } from "./components/Settings/WorkflowTeamsTab";
import { AgentUsagePage } from "./components/Usage/AgentUsagePage";
import { useCliExecutorStore } from "./store/cliExecutorStore";
import { useConversationStore } from "./store/conversationStore";
import { useSettingsStore } from "./store/settingsStore";
import { useSkillStore } from "./store/skillStore";
import { useUpdaterStore } from "./store/updaterStore";
import { useDetailLayoutStore, selectDetailWidth, DETAIL_MIN_WIDTH } from "./store/detailLayoutStore";
import { useNewTaskUiStore } from "./store/newTaskUiStore";
import { useProjectStore } from "./store/projectStore";
import { useWorkflowStore } from "./store/workflowStore";
import { useTaskReceiptStore } from "./store/taskReceiptStore";
import {
  notifyTaskFinished,
  playTaskFailure,
  playTaskSuccess
} from "./utils/soundEffects";
import { isAppInBackground } from "./utils/appFocus";
import { startScheduledSendRunner } from "./services/scheduledSend/runner";
import i18next from "i18next";
import { useTranslation } from "react-i18next";

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
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [contextSourceId, setContextSourceId] = useState<string>();
  const [codexImportOpen, setCodexImportOpen] = useState(false);
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
  const refreshProjects = useProjectStore((s) => s.refresh);
  useEffect(() => {
    void (async () => {
      await loadExecutors();
      await Promise.all([loadConversations(), refreshProjects()]);
    })();
  }, [loadExecutors, loadConversations, refreshProjects]);

  useEffect(() => startScheduledSendRunner(), []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    document.title = "FreeBuddy [DEV]";
    const preview = new URLSearchParams(window.location.search).get(
      "taskReceiptPreview"
    );
    if (preview !== "1") return;
    const state = useTaskReceiptStore.getState();
    const titles = [
      i18next.t("taskReceipt.previewTasks.quarterlyReport"),
      i18next.t("taskReceipt.previewTasks.releaseConfig"),
      i18next.t("taskReceipt.previewTasks.userFeedback")
    ];
    titles.forEach((title, index) => {
      state.recordCompletion({
        id: `task-receipt-preview-${index}`,
        title,
        result: "success",
        completedAt: new Date(Date.now() - index * 60_000).toISOString()
      });
    });
    state.openReport();
  }, []);

  useEffect(() => {
    const lastStatusMap = new Map<string, string | undefined>();
    const off = window.freebuddy?.scheduledTasks?.onChanged?.((task) => {
      if (!task || task.lastStatus === "completed" || task.lastStatus === "failed") {
        void refreshConversationList();
      }
      if (task?.id) {
        const prev = lastStatusMap.get(task.id);
        const next = task.lastStatus;
        lastStatusMap.set(task.id, next);
        if (prev !== next) {
          if (next === "completed") {
            if (task.lastConversationId) {
              useConversationStore
                .getState()
                .markConversationCompletedUnread(task.lastConversationId, "success");
            }
            playTaskSuccess(true);
            notifyTaskFinished(
              "success",
              i18next.t("notifications.taskSucceededTitle"),
              i18next.t("notifications.taskSucceededBody", {
                title: task?.title ?? i18next.t("conversations.untitled")
              }),
              task.lastConversationId,
              {
                eventId: `scheduled:${task.id}:${task.lastRunAt ?? task.updatedAt}`,
                taskTitle: task.title,
                completedAt: task.lastRunAt
              }
            );
          } else if (next === "failed") {
            if (task.lastConversationId) {
              useConversationStore
                .getState()
                .markConversationCompletedUnread(task.lastConversationId, "failure");
            }
            playTaskFailure(true);
            notifyTaskFinished(
              "failure",
              i18next.t("notifications.taskFailedTitle"),
              i18next.t("notifications.taskFailedBody", {
                title: task?.title ?? i18next.t("conversations.untitled")
              }),
              task.lastConversationId,
              {
                eventId: `scheduled:${task.id}:${task.lastRunAt ?? task.updatedAt}`,
                taskTitle: task.title,
                completedAt: task.lastRunAt
              }
            );
          }
        }
      }
    });
    return () => off?.();
  }, [refreshConversationList]);

  useEffect(() => {
    const off = window.freebuddy?.cli?.onConversationsChanged?.(() => {
      void refreshConversationList();
    });
    return () => off?.();
  }, [refreshConversationList]);

  useEffect(() => {
    const off = window.freebuddy?.skills?.onChanged?.(() => {
      void useSkillStore.getState().load();
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    const off = window.freebuddy?.cli?.onMessagesChanged?.((conversationId) => {
      const state = useConversationStore.getState();
      if (conversationId !== state.activeId || isAppInBackground()) {
        state.markConversationUnread(conversationId);
        void state.refreshList();
        if (conversationId !== state.activeId) return;
      }
      // Skip conversations this client is already live-streaming (e.g. the
      // current user's own active run) — live streaming owns those updates.
      // Other clients, including the conversation owner while an admin is
      // contributing, must reload the shared message snapshot.
      const live = state.live[conversationId];
      const isStreaming = !!live && (live.status === "starting" || live.status === "running");
      if (isStreaming) return;
      void state.loadMessages(conversationId);
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    const handleFocus = () => {
      const state = useConversationStore.getState();
      if (state.activeId && state.unreadConversations[state.activeId]) {
        state.markConversationRead(state.activeId);
      }
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);

  useEffect(() => {
    const off = window.freebuddy?.window?.onChromeVisible?.((visible) => {
      setChromeVisible(visible);
    });
    return () => {
      off?.();
    };
  }, []);

  useEffect(() => {
    const off = window.freebuddy?.window?.onOpenConversation?.((conversationId) => {
      setSettingsOpen(false);
      setWorkspaceView("chat");
      void useConversationStore.getState().setActive(conversationId);
    });
    return () => {
      off?.();
    };
  }, []);

  useEffect(() => {
    const off = window.freebuddy?.window?.onNewConversation?.(() => {
      startNewTask();
    });
    return () => {
      off?.();
    };
  }, []);

  useEffect(() => {
    const off = window.freebuddy?.window?.onOpenTaskReceipt?.(() => {
      setSettingsOpen(false);
      useTaskReceiptStore.getState().openReport();
    });
    return () => {
      off?.();
    };
  }, []);

  useEffect(() => {
    const off = window.freebuddy?.window?.onOpenSettings?.((tab) => {
      setSettingsInitialTab(tab as SettingsTab);
      setSettingsOpen(true);
    });
    return () => {
      off?.();
    };
  }, []);

  useEffect(() => {
    const off = window.freebuddy?.window?.onAppearanceChanged?.((theme) => {
      if (theme === "system" || theme === "light" || theme === "dark") {
        void useSettingsStore.getState().setTheme(theme, { syncPeers: false });
      }
    });
    return () => {
      off?.();
    };
  }, []);

  useEffect(() => {
    const off = window.freebuddy?.butlerBuddy?.onPreferencesChanged?.((prefs) => {
      useSettingsStore.getState().applyButlerBuddyPreferences(prefs);
    });
    return () => {
      off?.();
    };
  }, []);

  useEffect(() => {
    const handleTeamRunFinished = (
      event: {
        runId: string;
        conversationId?: string;
        status: string;
        name: string;
      },
      source: "workflow" | "delegation"
    ) => {
      const success = event.status === "completed" || event.status === "partial";
      if (success) playTaskSuccess(true);
      else playTaskFailure(true);
      if (event.conversationId) {
        if (event.status !== "killed") {
          useConversationStore
            .getState()
            .markConversationCompletedUnread(
              event.conversationId,
              success ? "success" : "failure"
            );
        }
        notifyTaskFinished(
          success ? "success" : "failure",
          success
            ? i18next.t("notifications.taskSucceededTitle")
            : i18next.t("notifications.taskFailedTitle"),
          success
            ? i18next.t("notifications.taskSucceededBody", { title: event.name })
            : i18next.t("notifications.taskFailedBody", { title: event.name }),
          event.conversationId,
          {
            eventId: `${source}:${event.runId}`,
            taskTitle: event.name
          }
        );
      }
    };

    const offWorkflow = window.freebuddy?.workflow?.onRunFinished?.((event) => {
      handleTeamRunFinished(event, "workflow");
    });
    const offDelegation = window.freebuddy?.delegation?.onRunFinished?.((event) => {
      handleTeamRunFinished(event, "delegation");
    });
    return () => {
      offWorkflow?.();
      offDelegation?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setCommandPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const { t } = useTranslation();
  // Locale-specific secondary brand name; empty in locales that only use "FreeBuddy".
  const brandSub = t("app.brandSub", { defaultValue: "" }).trim();
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
  const detailCollapsed = useDetailLayoutStore((s) => s.detailCollapsed);
  const setDetailCollapsed = useDetailLayoutStore((s) => s.setDetailCollapsed);
  const toggleDetailCollapsed = useDetailLayoutStore((s) => s.toggleDetailCollapsed);
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

  const [wasNarrow, setWasNarrow] = useState<boolean | null>(null);
  useEffect(() => {
    const isNarrow = winWidth < 1080;
    if (wasNarrow === null) {
      setWasNarrow(isNarrow);
      if (isNarrow && !detailCollapsed) {
        setDetailCollapsed(true);
      }
      return;
    }

    if (isNarrow && !wasNarrow) {
      setDetailCollapsed(true);
      setWasNarrow(true);
    } else if (!isNarrow && wasNarrow) {
      setDetailCollapsed(false);
      setWasNarrow(false);
    }
  }, [winWidth, wasNarrow, detailCollapsed, setDetailCollapsed]);

  const sidebarWidth = sidebarCollapsed ? 0 : 272;
  const effectiveDetailWidth = detailCollapsed
    ? 0
    : Math.min(
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
  const unreadCount = useConversationStore((s) =>
    s.conversations.reduce(
      (n, c) => n + (s.unreadConversations[c.id] ? 1 : 0),
      0
    )
  );
  // Completion metadata can change without changing the total unread count,
  // so keep a separate primitive subscription for the pet's task queue.
  const completedUnreadTasksJson = useConversationStore((s) =>
    JSON.stringify(
      s.conversations.reduce<
        Array<{
          id: string;
          title: string;
          result: "success" | "failure";
          completedAt: string;
        }>
      >((tasks, conversation) => {
        const unread = s.unreadConversations[conversation.id];
        if (unread?.kind === "success" || unread?.kind === "failure") {
          tasks.push({
            id: conversation.id,
            title: conversation.title,
            result: unread.kind,
            completedAt: unread.at
          });
        }
        return tasks;
      }, [])
    )
  );
  const members = useConversationStore((s) => s.members);
  const activeId = useConversationStore((s) => s.activeId);
  const setActive = useConversationStore((s) => s.setActive);
  const activeConversation = conversations.find((c) => c.id === activeId);
  const contextSource = conversations.find((c) => c.id === contextSourceId);
  const activeConversationRunning = useConversationStore((s) => {
    if (!activeId) return false;
    const status = s.live[activeId]?.status;
    if (status === "running" || status === "starting") return true;
    // Delegation turns stream via workflow://message (DB message status), not
    // conversationStore.live — still count them as in-progress for the pet.
    return (
      s.messages[activeId]?.some(
        (message) =>
          message.role === "assistant" &&
          (message.status === "running" || message.status === "starting")
      ) ?? false
    );
  });
  // Keep the selector primitive so root rendering does not follow every stream
  // chunk. The value changes only when the set of running conversations does.
  const runningConversationIds = useConversationStore((s) =>
    s.conversations
      .filter((conversation) => {
        const status = s.live[conversation.id]?.status;
        if (status === "running" || status === "starting") return true;
        return (
          s.messages[conversation.id]?.some(
            (message) =>
              message.role === "assistant" &&
              (message.status === "running" || message.status === "starting")
          ) ?? false
        );
      })
      .map((conversation) => conversation.id)
      .join("\u001f")
  );
  const runningCount = runningConversationIds
    ? runningConversationIds.split("\u001f").length
    : 0;

  useEffect(() => {
    const member = members.find((m) => m.id === activeConversation?.agentId);
    const runningIds = new Set(
      runningConversationIds ? runningConversationIds.split("\u001f") : []
    );
    const snapshot = {
      workspaceView,
      settingsOpen,
      settingsTab: settingsOpen ? settingsInitialTab : null,
      activeConversation: activeConversation
        ? {
            id: activeConversation.id,
            title: activeConversation.title,
            agentId: activeConversation.agentId,
            agentName:
              member?.name ??
              activeConversation.agentName ??
              activeConversation.agentId
          }
        : null,
      streaming: activeConversationRunning,
      runningTasks: conversations
        .filter((conversation) => runningIds.has(conversation.id))
        .map((conversation) => ({
          id: conversation.id,
          title: conversation.title
        })),
      completedUnreadTasks: JSON.parse(completedUnreadTasksJson) as Array<{
        id: string;
        title: string;
        result: "success" | "failure";
        completedAt: string;
      }>,
      unreadCount,
      updatedAt: new Date().toISOString()
    };
    const timer = window.setTimeout(() => {
      window.freebuddy?.window?.setUiPresence?.(snapshot);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    workspaceView,
    settingsOpen,
    settingsInitialTab,
    activeConversation?.id,
    activeConversation?.title,
    activeConversation?.agentId,
    activeConversation?.agentName,
    activeConversationRunning,
    runningConversationIds,
    completedUnreadTasksJson,
    unreadCount,
    members,
    conversations
  ]);

  const activeWorkflowRunning = useWorkflowStore((s) =>
    Boolean(activeId && s.activeRuns.some((run) => run.conversationId === activeId))
  );
  const activeConversationHasContent = useConversationStore((s) =>
    Boolean(
      activeId &&
      s.messages[activeId]?.some(
        (message) =>
          message.role === "user" ||
          (message.role === "assistant" && message.status !== "running")
      )
    )
  );
  const transferDisabled = activeConversationRunning || activeWorkflowRunning;
  const isNewTask = !activeConversation;
  const setNewTaskMode = useNewTaskUiStore((s) => s.setTaskMode);
  const setRequestedTeamId = useNewTaskUiStore((s) => s.setRequestedTeamId);
  const requestNewTask = useNewTaskUiStore((s) => s.requestNewTask);
  const startNewTask = (options?: { cwd?: string; projectId?: string }) => {
    setRequestedTeamId(undefined);
    setNewTaskMode("normal");
    requestNewTask({ cwd: options?.cwd, projectId: options?.projectId });
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
  const openUsage = () => {
    setSettingsOpen(false);
    setWorkspaceView("usage");
    void setActive(undefined);
  };

  useEffect(() => {
    const off = window.freebuddy?.window?.onOpenView?.((payload) => {
      if (payload.view === "scheduledTasks") {
        openScheduledTasks();
        return;
      }
      if (payload.view === "workflowTeams") {
        openWorkflowTeams({
          teamId: payload.teamId,
          create: payload.create === true
        });
        return;
      }
      if (payload.view === "usage") {
        openUsage();
        return;
      }
      setSettingsOpen(false);
      setWorkspaceView("chat");
    });
    return () => {
      off?.();
    };
  }, []);

  useEffect(() => {
    if (activeId) setWorkspaceView("chat");
  }, [activeId]);

  const workspaceTitle = settingsOpen
    ? t("common.settings")
    : workspaceView === "scheduledTasks"
      ? t("scheduledTasks.title")
      : workspaceView === "workflowTeams"
        ? t("workflow.teamList")
        : workspaceView === "usage"
          ? t("usage.title")
        : activeConversation?.title ?? t("app.chat");
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
      className={`app-shell${isElectron ? " electron-shell" : ""}${!settingsOpen && workspaceView === "chat" && isNewTask ? " new-task-mode" : ""}${!settingsOpen && workspaceView !== "chat" ? " tool-page-mode" : ""}${settingsOpen ? " settings-mode" : ""}${!settingsOpen && sidebarCollapsed ? " sidebar-collapsed" : ""}${!settingsOpen && workspaceView === "chat" && activeConversation && detailCollapsed ? " detail-collapsed" : ""}${!chromeVisible ? " chrome-hidden" : ""}${platform ? ` platform-${platform}` : ""}`}
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
                  <div className="sidebar-brand-row">
                    <h1>{t("app.brand")}</h1>
                    {import.meta.env.DEV && (
                      <span className="sidebar-dev-badge">DEV</span>
                    )}
                  </div>
                  {brandSub && (
                    <span className="sidebar-brand-sub">{brandSub}</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="sidebar-search-button"
                title={t("commandPalette.openShortcut")}
                aria-label={t("commandPalette.open")}
                onClick={() => setCommandPaletteOpen(true)}
              >
                <Search aria-hidden="true" size={16} strokeWidth={1.8} />
              </button>
              {renderToggleButton()}
            </div>

            <SidebarNavigation
              workspaceView={workspaceView}
              isNewTask={isNewTask}
              onNewTask={startNewTask}
              onOpenScheduledTasks={openScheduledTasks}
              onOpenTeams={() => openWorkflowTeams()}
              onOpenUsage={openUsage}
            />
            <ConversationList
              onNewTaskInProject={({ cwd, projectId }) =>
                startNewTask({ cwd, projectId })
              }
            />

            <div className="sidebar-footer">
              <SidebarUserMenu
                onOpenSettings={() => openSettings("cli")}
                showLogout={platform === "web"}
              />
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
              {activeConversationHasContent && (
                <button
                  type="button"
                  className="titlebar-icon-button"
                  disabled={transferDisabled}
                  title={t(
                    transferDisabled
                      ? "conversationContext.stopBeforeAction"
                      : "conversationContext.action"
                  )}
                  aria-label={t(
                    transferDisabled
                      ? "conversationContext.stopBeforeAction"
                      : "conversationContext.action"
                  )}
                  onClick={() => setContextSourceId(activeConversation.id)}
                >
                  <Share2 size={14} aria-hidden="true" />
                </button>
              )}
              <TitlebarOverflowMenu />
              {detailCollapsed && (
                <button
                  type="button"
                  className="titlebar-detail-toggle collapsed"
                  title={t("detail.expand")}
                  aria-label={t("detail.expand")}
                  aria-expanded={false}
                  onClick={toggleDetailCollapsed}
                >
                  <PanelRight size={16} aria-hidden="true" />
                </button>
              )}
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
          ) : workspaceView === "usage" ? (
            <section className="workspace-tool-page usage-workspace-page">
              <div className="workspace-tool-page-inner">
                <AgentUsagePage />
              </div>
            </section>
          ) : (
            <ChatView onOpenAgentSettings={() => openSettings("cli")} />
          )}
        </section>
      </main>

      {activeConversation && !settingsOpen && workspaceView === "chat" && !detailCollapsed && (
        <DetailColumn runningCount={runningCount} />
      )}

      <CliInstallPanelHost />
      <PermissionDialog />
      <ExportDebugLogsDialog />
      <AuthenticationDialog />
      <TaskReceiptDialog />
      <ConversationCommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onNewTask={startNewTask}
        onOpenScheduledTasks={openScheduledTasks}
        onOpenSettings={() => openSettings("cli")}
        onImportCodexSession={() => {
          setCommandPaletteOpen(false);
          setCodexImportOpen(true);
        }}
        onSelectConversation={() => {
          setSettingsOpen(false);
          setWorkspaceView("chat");
        }}
      />
      {contextSource && (
        <ConversationContextDialog
          source={contextSource}
          members={members}
          onClose={() => setContextSourceId(undefined)}
        />
      )}
      {codexImportOpen && (
        <ImportCodexSessionDialog onClose={() => setCodexImportOpen(false)} />
      )}
      <AgentBridgeListener />
      <AgentBridgeToasts />
    </div>
    </ImageLightboxProvider>
    </ConfigProvider>
  );
}

export default App;
