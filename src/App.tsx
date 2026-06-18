import { useEffect, useMemo, useState } from "react";

import { ChatView } from "./components/CLI/ChatView";
import { ConversationList } from "./components/CLI/ConversationList";
import { NewConversationDialog } from "./components/CLI/NewConversationDialog";
import { WorkspacePanel } from "./components/CLI/WorkspacePanel";
import { SettingsModal } from "./components/Settings/SettingsModal";
import { useCliExecutorStore } from "./store/cliExecutorStore";
import { useConversationStore } from "./store/conversationStore";

type Theme = "light" | "dark";

function App() {
  const [theme, setTheme] = useState<Theme>("light");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

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
  const activeConversation = conversations.find((c) => c.id === activeId);
  const runningCount = conversations.filter(
    (c) => live[c.id]?.status === "running" || live[c.id]?.status === "starting"
  ).length;

  return (
    <div
      className={`app-shell${isElectron ? " electron-shell" : ""}`}
      data-theme={theme}
    >
      <aside className="activity-bar" aria-label="Primary">
        <button className="activity-dot active" title="Chat" aria-label="Chat">
          <span className="icon">fb</span>
        </button>
        <button
          className="activity-dot bottom"
          title="Settings"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <span className="icon-glyph">⚙︎</span>
        </button>
        <button
          className="activity-dot"
          title="Toggle theme"
          aria-label="Toggle theme"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          <span className="icon">{theme === "dark" ? "sun" : "moon"}</span>
        </button>
      </aside>

      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <h1>FreeBuddy</h1>
            <p>Local CLI agent workspace</p>
          </div>
        </div>

        <ConversationList onNew={() => setNewOpen(true)} />

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
            <span>/</span>
            <strong>{activeConversation?.title ?? "Chat"}</strong>
          </div>
          <div className="titlebar-actions">
            <button className="text-button">Ask</button>
            <button className="text-button active">Craft</button>
            <button className="text-button">Plan</button>
          </div>
        </header>

        <section className="chat-section" aria-label="Chat">
          <ChatView />
        </section>
      </main>

      <WorkspacePanel
        runtime={runtime}
        theme={theme}
        runningCount={runningCount}
      />

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {newOpen && <NewConversationDialog onClose={() => setNewOpen(false)} />}
    </div>
  );
}

export default App;
