import { useConversationStore } from "@/store/conversationStore";

export function ConversationList({
  onNew
}: {
  onNew: () => void;
}) {
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const setActive = useConversationStore((s) => s.setActive);
  const live = useConversationStore((s) => s.live);
  const remove = useConversationStore((s) => s.deleteConversation);
  const rename = useConversationStore((s) => s.renameConversation);

  return (
    <div className="conv-list">
      <div className="conv-list-header">
        <h2>Conversations</h2>
        <button className="ghost" onClick={onNew}>
          + New
        </button>
      </div>
      <ul>
        {conversations.length === 0 && (
          <li className="conv-empty muted">No conversations yet.</li>
        )}
        {conversations.map((c) => {
          const running =
            live[c.id]?.status === "running" || live[c.id]?.status === "starting";
          return (
            <li
              key={c.id}
              className={`conv-item${activeId === c.id ? " active" : ""}`}
              onClick={() => void setActive(c.id)}
            >
              {running && <span className="conv-running-dot" />}
              <div className="conv-item-main">
                <strong>{c.title}</strong>
                <small>
                  {c.agentName}
                  {c.cwd ? ` · ${c.cwd.split(/[/\\]/).slice(-2).join("/")}` : ""}
                </small>
              </div>
              <div className="conv-item-side">
                <button
                  className="icon-btn"
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = window.prompt("Rename conversation", c.title);
                    if (next && next.trim()) void rename(c.id, next.trim());
                  }}
                >
                  ✎
                </button>
                <button
                  className="icon-btn danger"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Delete "${c.title}"?`))
                      void remove(c.id);
                  }}
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
