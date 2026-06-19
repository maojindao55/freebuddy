import { useMemo, useState } from "react";

import { displayAgentName } from "@/config/agentDisplay";
import { useConversationStore } from "@/store/conversationStore";
import { AgentAvatar } from "./AgentAvatar";

export function WorkspacePanel({
  runningCount
}: {
  runningCount: number;
}) {
  const activeId = useConversationStore((s) => s.activeId);
  const conversations = useConversationStore((s) => s.conversations);
  const messagesMap = useConversationStore((s) => s.messages);
  const liveMap = useConversationStore((s) => s.live);
  const [copiedSession, setCopiedSession] = useState(false);

  const active = conversations.find((c) => c.id === activeId);
  const activeAgentName = displayAgentName(active?.agentName, active?.adapter);
  const messages = activeId ? messagesMap[activeId] ?? [] : [];
  const live = activeId ? liveMap[activeId] : undefined;

  const status = live?.status ?? "ready";
  const assistantTurns = useMemo(
    () => messages.filter((m) => m.role === "assistant").length,
    [messages]
  );
  const latestSessionId = useMemo(() => {
    const fromLive = live?.capturedSessionId ?? live?.resumedFromSessionId;
    if (fromLive) return fromLive;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      try {
        const items = JSON.parse(message.content) as unknown[];
        if (!Array.isArray(items)) continue;
        for (let j = items.length - 1; j >= 0; j -= 1) {
          const item = items[j] as { kind?: string; sessionId?: string };
          if (item?.kind === "session" && item.sessionId) {
            return item.sessionId;
          }
        }
      } catch {
        // Ignore plain or legacy assistant messages.
      }
    }

    return undefined;
  }, [live?.capturedSessionId, live?.resumedFromSessionId, messages]);

  const latestUsage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      try {
        const items = JSON.parse(message.content) as unknown[];
        if (!Array.isArray(items)) continue;
        for (let j = items.length - 1; j >= 0; j -= 1) {
          const item = items[j] as {
            kind?: string;
            contextUsed?: number;
            contextSize?: number;
            costAmount?: number;
            costCurrency?: string;
            inputTokens?: number;
            outputTokens?: number;
            totalCost?: number;
          };
          if (item?.kind === "usage") return item;
        }
      } catch {
        // ignore
      }
    }
    return undefined;
  }, [messages]);

  return (
    <aside className="details-panel workspace-panel" aria-label="Workspace panel">
      <section className="side-card active-agent-card">
        <div className="side-card-header">
          <span>Active Agent</span>
          <strong>{status}</strong>
        </div>
        <div className="agent-lockup">
          <AgentAvatar
            adapter={active?.adapter}
            className="agent-avatar"
            fallback={
              <span>
                {(active ? activeAgentName : "FB").slice(0, 2).toUpperCase()}
              </span>
            }
          />
          <div>
            <strong>{active ? activeAgentName : "No conversation"}</strong>
            <small>{active ? "Local coding agent" : "Create a conversation to begin"}</small>
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
            <dt>Workspace</dt>
            <dd>{active?.cwd ? shortPath(active.cwd) : "Not set"}</dd>
          </div>
          <div>
            <dt>Session ID</dt>
            <dd>
              <button
                className="session-id-copy"
                type="button"
                disabled={!latestSessionId}
                title={latestSessionId ? `Copy ${latestSessionId}` : "No session captured yet"}
                onClick={() => {
                  if (!latestSessionId) return;
                  void navigator.clipboard.writeText(latestSessionId);
                  setCopiedSession(true);
                  window.setTimeout(() => setCopiedSession(false), 1200);
                }}
              >
                {copiedSession
                  ? "Copied"
                  : latestSessionId
                    ? shortSessionId(latestSessionId)
                    : "Not captured"}
              </button>
            </dd>
          </div>
          <div>
            <dt>Messages</dt>
            <dd>{messages.length}</dd>
          </div>
          <div>
            <dt>Agent turns</dt>
            <dd>{assistantTurns}</dd>
          </div>
          {latestUsage?.contextUsed != null && (
            <div>
              <dt>Context</dt>
              <dd>
                {formatTokens(latestUsage.contextUsed)}
                {latestUsage.contextSize != null
                  ? ` / ${formatTokens(latestUsage.contextSize)}`
                  : ""}
              </dd>
            </div>
          )}
          {latestUsage?.costAmount != null && (
            <div>
              <dt>Cost</dt>
              <dd>{formatCost(latestUsage.costAmount, latestUsage.costCurrency)}</dd>
            </div>
          )}
          {latestUsage?.contextUsed == null &&
            latestUsage?.costAmount == null &&
            (latestUsage?.inputTokens != null ||
              latestUsage?.outputTokens != null) && (
              <div>
                <dt>Tokens</dt>
                <dd>
                  in {latestUsage.inputTokens ?? "–"} · out{" "}
                  {latestUsage.outputTokens ?? "–"}
                </dd>
              </div>
            )}
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

function shortSessionId(id: string) {
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatCost(amount: number, currency?: string): string {
  const value = amount.toFixed(amount < 0.01 ? 4 : 2);
  return currency === "USD" ? `$${value}` : `${value} ${currency ?? ""}`.trim();
}
