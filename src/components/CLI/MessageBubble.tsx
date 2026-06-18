import { useMemo } from "react";

import type { ConversationMessage } from "@/services/cli/types";
import type { CliStreamItem } from "@/services/cli/parsers";
import { StreamItem } from "./StreamItem";

export function MessageBubble({ message }: { message: ConversationMessage }) {
  const items = useMemo<CliStreamItem[]>(() => {
    if (message.role !== "assistant") return [];
    try {
      const parsed = JSON.parse(message.content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [{ kind: "raw", content: message.content }];
    }
  }, [message.role, message.content]);

  if (message.role === "user") {
    return (
      <div className="msg msg-user">
        <span className="msg-author">You</span>
        <div className="msg-bubble">
          <pre>{message.content}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="msg msg-assistant">
      <span className="msg-author">Agent</span>
      <div className="msg-bubble">
        <div className="msg-meta">
          <span className={`status-pill ${message.status}`}>
            {message.status}
          </span>
        </div>
        <div className="msg-items">
          {items.length === 0 && <div className="muted">…</div>}
          {items.map((it, i) => (
            <StreamItem key={i} item={it} />
          ))}
        </div>
      </div>
    </div>
  );
}
