import { useEffect, useMemo, useRef, useState } from "react";

import { useConversationStore } from "@/store/conversationStore";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { cliClient } from "@/services/cli/client";
import { MessageBubble } from "./MessageBubble";

const EMPTY_MESSAGES: never[] = [];
const starterPrompts = [
  "先分析当前项目结构，给我下一步实现建议",
  "检查刚才的改动有没有 UI/UX 问题",
  "帮我实现一个小功能，并说明验证步骤"
];

export function ChatView() {
  const activeId = useConversationStore((s) => s.activeId);
  const conversations = useConversationStore((s) => s.conversations);
  const members = useConversationStore((s) => s.members);
  const messagesMap = useConversationStore((s) => s.messages);
  const liveMap = useConversationStore((s) => s.live);
  const pendingMap = useConversationStore((s) => s.pendingFreshContext);
  const sendMessage = useConversationStore((s) => s.sendMessage);
  const stopActive = useConversationStore((s) => s.stopActive);
  const resetContext = useConversationStore((s) => s.resetContext);

  const messages = useMemo(
    () => (activeId ? messagesMap[activeId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES),
    [activeId, messagesMap]
  );
  const live = activeId ? liveMap[activeId] : undefined;
  const pendingFresh = activeId
    ? pendingMap[activeId] === true
    : false;

  const resolve = useCliExecutorStore((s) => s.resolve);
  const check = useCliExecutorStore((s) => s.check);

  const [draft, setDraft] = useState("");
  const [preflightMsg, setPreflightMsg] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const conv = conversations.find((c) => c.id === activeId);
  const member = conv ? members.find((m) => m.id === conv.agentId) : undefined;
  const running =
    live?.status === "running" || live?.status === "starting";

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  if (!conv) {
    return (
      <div className="chat-empty chat-empty-hero">
        <p className="eyebrow">FreeBuddy Workspace</p>
        <h2>Start with a local CLI agent.</h2>
        <p className="muted">
          Create a conversation to bind an agent, workspace, and tool session.
        </p>
      </div>
    );
  }

  const onSend = async () => {
    if (!conv || !member || !draft.trim() || running) return;
    setPreflightMsg(null);
    const r = await cliClient.check(member.cli.adapter, member.cli.binary);
    await check(member.cli.adapter);
    if (!r.installed) {
      const resolved = resolve(member.cli.adapter);
      setPreflightMsg(
        `${resolved?.label ?? member.cli.adapter} is not installed. Open Settings → CLI Adapters to install.`
      );
      return;
    }
    const prompt = draft;
    setDraft("");
    await sendMessage({ conversationId: conv.id, prompt });
  };

  return (
    <div className="chat-view">
      <header className="chat-header">
        <div>
          <h2>{conv.title}</h2>
          <small className="muted">
            {conv.agentName} / {conv.adapter}
            {conv.cwd ? ` · ${conv.cwd}` : ""}
          </small>
        </div>
        <div className="chat-header-actions">
          <span className={`status-pill ${running ? live?.status : "ready"}`}>
            {running ? live?.status : "ready"}
          </span>
          {pendingFresh && (
            <span className="status-pill warn">fresh context next</span>
          )}
          <button
            className="ghost"
            disabled={running}
            onClick={() => resetContext(conv.id)}
            title="Start next reply with no tool resume"
          >
            Reset context
          </button>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty chat-empty-hero">
            <p className="eyebrow">New Agent Chat</p>
            <h2>What should {member?.name} work on?</h2>
            <p className="muted">
              Use this thread for coding tasks, project inspection, and focused fixes.
            </p>
            <div className="starter-prompts">
              {starterPrompts.map((prompt) => (
                <button key={prompt} onClick={() => setDraft(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>

      {preflightMsg && <div className="preflight-warn">{preflightMsg}</div>}

      <div className="chat-composer">
        <div className="composer-context-row">
          <span>{member?.name ?? "Agent"}</span>
          <span>{conv.cwd ? conv.cwd : "No workspace selected"}</span>
        </div>
        <textarea
          rows={3}
          value={draft}
          disabled={running}
          placeholder={
            running
              ? "Agent is running…"
              : `Message ${member?.name ?? "agent"}…`
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void onSend();
            }
          }}
        />
        <div className="chat-composer-actions">
          <div className="composer-tools">
            <button type="button" title="Attach file">Attach</button>
            <button type="button" title="Mention workspace">@ Workspace</button>
            <span className="muted">Cmd/Ctrl + Enter</span>
          </div>
          {running ? (
            <button className="danger" onClick={() => void stopActive(conv.id)}>
              Stop
            </button>
          ) : (
            <button
              className="primary"
              disabled={!draft.trim()}
              onClick={onSend}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
