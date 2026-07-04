import { useEffect, useState, type CSSProperties } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import { Monitor, Moon, Sun } from "lucide-react";

import sidebarLogoUrl from "../assets/sidebar-logo.png";
import { ChatView } from "./components/CLI/ChatView";
import { ReplayButton } from "./components/CLI/ReplayBar";
import { ConversationList } from "./components/CLI/ConversationList";
import { ImageLightboxProvider } from "./components/CLI/ImageLightbox";
import { PermissionDialog } from "./components/CLI/PermissionDialog";
import { DetailColumn } from "./components/CLI/DetailColumn";
import { AgentBridgeListener } from "./components/AgentBridge/AgentBridgeListener";
import { AgentBridgeToasts } from "./components/AgentBridge/AgentBridgeToasts";
import { SettingsModal, type SettingsTab } from "./components/Settings/SettingsModal";
import { CliInstallPanelHost } from "./components/Settings/CliInstallPanelHost";
import { useCliExecutorStore } from "./store/cliExecutorStore";
import { useConversationStore } from "./store/conversationStore";
import { useSettingsStore } from "./store/settingsStore";
import { useUpdaterStore } from "./store/updaterStore";
import { useDetailLayoutStore, selectDetailWidth, DETAIL_MIN_WIDTH } from "./store/detailLayoutStore";
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
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
      {collapsed ? (
        <path d="M14 10l3 2-3 2" />
      ) : (
        <path d="M17 10l-3 2 3 2" />
      )}
    </svg>
  );
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>("cli");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);

  const isElectron =
    Boolean(window.freebuddy?.cli) || navigator.userAgent.includes("Electron");
  const platform = window.freebuddy?.platform ?? "";

  const loadExecutors = useCliExecutorStore((s) => s.load);
  const loadConversations = useConversationStore((s) => s.load);
  useEffect(() => {
    void loadExecutors();
    void loadConversations();
  }, [loadExecutors, loadConversations]);

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
      className={`app-shell${isElectron ? " electron-shell" : ""}${isNewTask ? " new-task-mode" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}${!chromeVisible ? " chrome-hidden" : ""}${platform ? ` platform-${platform}` : ""}`}
      data-theme={theme}
      style={{ "--fb-detail-width": `${effectiveDetailWidth}px` } as CSSProperties}
    >
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <BrandMark />
            <div className="sidebar-brand-text">
              <h1>{t("app.brand")}</h1>
            </div>
          </div>
          {renderToggleButton()}
        </div>

        <ConversationList onNew={() => void setActive(undefined)} />

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
      </aside>

      <main className="workspace">
        <header className="titlebar">
          {sidebarCollapsed && renderToggleButton("floating")}
          <div className="breadcrumb">
            <strong>{activeConversation?.title ?? t("app.chat")}</strong>
          </div>
          {activeConversation && (
            <div className="titlebar-actions titlebar-actions-plain">
              <ReplayButton />
            </div>
          )}

        </header>

        <section className="chat-section" aria-label={t("app.chat")}>
          <ChatView />
        </section>
      </main>

      {activeConversation && (
        <DetailColumn runningCount={runningCount} />
      )}

      {settingsOpen && (
        <SettingsModal
          initialTab={settingsInitialTab}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <CliInstallPanelHost />
      <PermissionDialog />
      <AgentBridgeListener />
      <AgentBridgeToasts />
    </div>
    </ImageLightboxProvider>
    </ConfigProvider>
  );
}

export default App;
