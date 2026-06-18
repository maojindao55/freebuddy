import { useEffect, useMemo, useState } from "react";

import { ChatView } from "./components/CLI/ChatView";
import { ConversationList } from "./components/CLI/ConversationList";
import { WorkspacePanel } from "./components/CLI/WorkspacePanel";
import { SettingsModal } from "./components/Settings/SettingsModal";
import { useCliExecutorStore } from "./store/cliExecutorStore";
import { useConversationStore } from "./store/conversationStore";

type Theme = "light" | "dark";

function App() {
  const [theme, setTheme] = useState<Theme>("light");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isElectron =
    Boolean(window.freebuddy?.cli) || navigator.userAgent.includes("Electron");

  const loadExecutors = useCliExecutorStore((s) => s.load);
  const loadConversations = useConversationStore((s) => s.load);
  useEffect(() => {
    void loadExecutors();
    void loadConversations();
  }, [loadExecutors, loadConversations]);

  const runtime = useMemo(() => {
    const versions = window.freebuddy?.versions;
    return versions?.electron
      ? `Electron ${versions.electron}`
      : "Browser preview";
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

  return (
    <div
      className={`app-shell${isElectron ? " electron-shell" : ""}${isNewTask ? " new-task-mode" : ""}`}
      data-theme={theme}
    >
      <aside className="activity-bar" aria-label="Primary">
        <button className="activity-dot active" title="Chat" aria-label="Chat">
          <span className="icon-glyph">💬</span>
        </button>
        <button
          className="activity-dot bottom"
          title="Settings"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <span className="icon-glyph">⚙</span>
        </button>
        <button
          className="activity-dot"
          title="Toggle theme"
          aria-label="Toggle theme"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          <span className="icon-glyph">{theme === "dark" ? "☀️" : "🌙"}</span>
        </button>
      </aside>

      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <h1>FreeBuddy</h1>
            <p>Local CLI agent workspace</p>
          </div>
        </div>

        <ConversationList onNew={() => void setActive(undefined)} />

        <div className="sidebar-footer">
          <span className="muted">
            {runningCount > 0 ? `${runningCount} running` : "idle"}
          </span>
          <button
            className="footer-action"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="titlebar">
          <div className="breadcrumb">
            <span>FreeBuddy</span>
            <span>›</span>
            <strong>{activeConversation?.title ?? "Chat"}</strong>
          </div>

        </header>

        <section className="chat-section" aria-label="Chat">
          <ChatView />
        </section>
      </main>

      {activeConversation && (
        <WorkspacePanel
          runtime={runtime}
          theme={theme}
          runningCount={runningCount}
        />
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

export default App;
