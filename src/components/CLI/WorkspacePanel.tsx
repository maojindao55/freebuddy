import { useMemo } from "react";

import { useConversationStore } from "@/store/conversationStore";

export function WorkspacePanel({
  runtime,
  theme,
  runningCount
}: {
  runtime: string;
  theme: "light" | "dark";
  runningCount: number;
}) {
  const activeId = useConversationStore((s) => s.activeId);
  const conversations = useConversationStore((s) => s.conversations);
  const messagesMap = useConversationStore((s) => s.messages);
  const liveMap = useConversationStore((s) => s.live);

  const active = conversations.find((c) => c.id === activeId);
  const messages = activeId ? messagesMap[activeId] ?? [] : [];
  const live = activeId ? liveMap[activeId] : undefined;

  const status = live?.status ?? "ready";
  const assistantTurns = useMemo(
    () => messages.filter((m) => m.role === "assistant").length,
    [messages]
  );

  return (
    <aside className="details-panel workspace-panel" aria-label="Workspace panel">
      <div className="panel-tabs">
        <button className="panel-tab active">Tasks</button>
        <button className="panel-tab">Context</button>
        <button className="panel-tab">Files</button>
      </div>

      <section className="side-card active-agent-card">
        <div className="side-card-header">
          <span>Active Agent</span>
          <strong>{status}</strong>
        </div>
        <div className="agent-lockup">
          <span className="agent-avatar">
            {(active?.agentName ?? "FB").slice(0, 2).toUpperCase()}
          </span>
          <div>
            <strong>{active?.agentName ?? "No conversation"}</strong>
            <small>{active?.adapter ?? "Create a conversation to begin"}</small>
          </div>
        </div>
      </section>

      <section className="side-card">
        <div className="side-card-header">
          <span>Run State</span>
          <strong>{runningCount > 0 ? `${runningCount} live` : "idle"}</strong>
        </div>
        <dl className="compact-dl">
          <div>
            <dt>Runtime</dt>
            <dd>{runtime}</dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>{active?.cwd ? shortPath(active.cwd) : "Not set"}</dd>
          </div>
          <div>
            <dt>Messages</dt>
            <dd>{messages.length}</dd>
          </div>
          <div>
            <dt>Agent turns</dt>
            <dd>{assistantTurns}</dd>
          </div>
          <div>
            <dt>Theme</dt>
            <dd>{theme === "dark" ? "Dark" : "Light"}</dd>
          </div>
        </dl>
      </section>

      <section className="side-card run-queue-card">
        <div className="side-card-header">
          <span>Execution Queue</span>
          <strong>{status}</strong>
        </div>
        <article className="queue-row">
          <span className={`queue-icon ${live ? "running" : ""}`} />
          <div>
            <strong>{live ? "CLI response stream" : "Waiting for prompt"}</strong>
            <p>{live?.pid ? `pid ${live.pid}` : "Send a message to start a run"}</p>
          </div>
        </article>
        <article className="queue-row">
          <span className="queue-icon" />
          <div>
            <strong>Tool session</strong>
            <p>{live?.resumedFromSessionId ? "resumed context" : "fresh or saved context"}</p>
          </div>
        </article>
        <article className="queue-row">
          <span className="queue-icon" />
          <div>
            <strong>Message snapshot</strong>
            <p>{messages.length ? "persisted locally" : "no history yet"}</p>
          </div>
        </article>
      </section>
    </aside>
  );
}

function shortPath(path: string) {
  return path.split(/[/\\]/).filter(Boolean).slice(-2).join("/") || path;
}
