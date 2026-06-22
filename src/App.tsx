import { useEffect, useState } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";

import sidebarLogoUrl from "../assets/sidebar-logo.png";
import { ChatView } from "./components/CLI/ChatView";
import { ConversationList } from "./components/CLI/ConversationList";
import { ImageLightboxProvider } from "./components/CLI/ImageLightbox";
import { PermissionDialog } from "./components/CLI/PermissionDialog";
import { WorkspacePanel } from "./components/CLI/WorkspacePanel";
import { SettingsModal } from "./components/Settings/SettingsModal";
import { useCliExecutorStore } from "./store/cliExecutorStore";
import { useConversationStore } from "./store/conversationStore";
import { useSettingsStore } from "./store/settingsStore";
import i18next from "i18next";
import { useTranslation } from "react-i18next";

type Theme = "light" | "dark";

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

function SunIcon() {
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
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
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
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
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
  const [theme, setTheme] = useState<Theme>("light");
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    document.documentElement.lang = i18next.language ?? "en";
    const handler = (lng: string) => {
      document.documentElement.lang = lng;
    };
    i18next.on("languageChanged", handler);
    return () => i18next.off("languageChanged", handler);
  }, []);

  const conversations = useConversationStore((s) => s.conversations);
  const live = useConversationStore((s) => s.live);
  const activeId = useConversationStore((s) => s.activeId);
  const setActive = useConversationStore((s) => s.setActive);
  const activeConversation = conversations.find((c) => c.id === activeId);
  const isNewTask = !activeConversation;
  const runningCount = conversations.filter(
    (c) => live[c.id]?.status === "running" || live[c.id]?.status === "starting"
  ).length;

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
    >
      {sidebarCollapsed && renderToggleButton("floating")}
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
            onClick={() => setSettingsOpen(true)}
          >
            <GearIcon />
            {t("common.settings")}
          </button>
          <button
            className="footer-toggle"
            title={t("sidebar.toggleTheme")}
            aria-label={t("sidebar.toggleTheme")}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="titlebar">
          <div className="breadcrumb">
            <strong>{activeConversation?.title ?? t("app.chat")}</strong>
          </div>

        </header>

        <section className="chat-section" aria-label={t("app.chat")}>
          <ChatView />
        </section>
      </main>

      {activeConversation && (
        <WorkspacePanel runningCount={runningCount} />
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <PermissionDialog />
    </div>
    </ImageLightboxProvider>
    </ConfigProvider>
  );
}

export default App;
