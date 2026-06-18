import { useEffect, useMemo, useRef, useState } from "react";

import { useConversationStore } from "@/store/conversationStore";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { cliClient } from "@/services/cli/client";
import type { ConversationMessage } from "@/services/cli/types";
import { MessageBubble } from "./MessageBubble";

const EMPTY_MESSAGES: never[] = [];
const starterPrompts = [
  "先分析当前项目结构，给我下一步实现建议",
  "检查刚才的改动有没有 UI/UX 问题",
  "帮我实现一个小功能，并说明验证步骤"
];
const newTaskPrompts = [
  ["分析项目", "先分析当前项目结构，告诉我可以先做什么"],
  ["修改代码", "根据我的需求修改代码，并给出验证步骤"],
  ["代码审查", "检查当前改动的风险、问题和可改进点"]
];

export function ChatView() {
  const activeId = useConversationStore((s) => s.activeId);
  const conversations = useConversationStore((s) => s.conversations);
  const members = useConversationStore((s) => s.members);
  const messagesMap = useConversationStore((s) => s.messages);
  const liveMap = useConversationStore((s) => s.live);
  const pendingMap = useConversationStore((s) => s.pendingFreshContext);
  const createConversation = useConversationStore((s) => s.newConversation);
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
  const [newTaskDraft, setNewTaskDraft] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState(members[0]?.id ?? "");
  const [newTaskCwd, setNewTaskCwd] = useState("");
  const [permissionMode, setPermissionMode] = useState<"auto" | "ask">("auto");
  const [preflightMsg, setPreflightMsg] = useState<string | null>(null);
  const [submitPreview, setSubmitPreview] = useState<{
    conversationId: string;
    prompt: string;
    createdAt: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);

  const conv = conversations.find((c) => c.id === activeId);
  const member = conv ? members.find((m) => m.id === conv.agentId) : undefined;
  const running =
    live?.status === "running" || live?.status === "starting";
  const sending =
    running ||
    (submitPreview?.conversationId === conv?.id);

  const previewMessages = useMemo<ConversationMessage[]>(() => {
    if (!conv || submitPreview?.conversationId !== conv.id) return [];
    return [
      {
        id: `preview-user-${submitPreview.createdAt}`,
        conversationId: conv.id,
        role: "user",
        status: "sent",
        content: submitPreview.prompt,
        createdAt: submitPreview.createdAt,
        updatedAt: submitPreview.createdAt
      },
      {
        id: `preview-agent-${submitPreview.createdAt}`,
        conversationId: conv.id,
        role: "assistant",
        status: "starting",
        content: "[]",
        createdAt: submitPreview.createdAt,
        updatedAt: submitPreview.createdAt
      }
    ];
  }, [conv, submitPreview]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const offset = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = offset < 120;
  };

  useEffect(() => {
    if (!selectedMemberId && members[0]) setSelectedMemberId(selectedMemberId);
  }, [members, selectedMemberId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, live, submitPreview]);

  const preflightMember = async (targetMember: typeof members[number]) => {
    if (!cliClient.isAvailable()) {
      setPreflightMsg("FreeBuddy CLI bridge is unavailable. Please run the Electron desktop app.");
      return false;
    }
    try {
      const r = await cliClient.check(targetMember.cli.adapter, targetMember.cli.binary);
      await check(targetMember.cli.adapter);
      if (!r.installed) {
        const resolved = resolve(targetMember.cli.adapter);
        setPreflightMsg(
          `${resolved?.label ?? targetMember.cli.adapter} is not installed. Open Settings -> CLI Adapters to install.`
        );
        return false;
      }
      return true;
    } catch (err) {
      setPreflightMsg(`Check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const onCreateAndSend = async () => {
    const prompt = newTaskDraft.trim();
    const selectedMember = members.find((m) => m.id === selectedMemberId) ?? members[0];
    if (!prompt || !selectedMember) return;

    setPreflightMsg(null);
    try {
      if (!(await preflightMember(selectedMember))) return;

      const newConv = await createConversation({
        member: {
          ...selectedMember,
          cli: {
            ...selectedMember.cli,
            approvalMode: permissionMode
          }
        },
        cwd: newTaskCwd.trim() || undefined,
        title: prompt.slice(0, 24)
      });
      setNewTaskDraft("");
      await sendMessage({ conversationId: newConv.id, prompt });
    } catch (e) {
      setPreflightMsg(`Task failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onSend = async () => {
    const prompt = draft.trim();
    if (!conv || !member || !prompt || sending) return;
    setPreflightMsg(null);
    const preview = {
      conversationId: conv.id,
      prompt,
      createdAt: new Date().toISOString()
    };
    setSubmitPreview(preview);
    setDraft("");
    try {
      if (!(await preflightMember(member))) {
        setSubmitPreview(null);
        setDraft(prompt);
        return;
      }
      const run = sendMessage({ conversationId: conv.id, prompt });
      setSubmitPreview(null);
      await run;
    } catch (e) {
      setSubmitPreview(null);
      setDraft(prompt);
      setPreflightMsg(`Send failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (!conv) {
    return (
      <NewTaskHome
        draft={newTaskDraft}
        members={members}
        selectedMemberId={selectedMemberId}
        cwd={newTaskCwd}
        permissionMode={permissionMode}
        preflightMsg={preflightMsg}
        onDraft={setNewTaskDraft}
        onMember={setSelectedMemberId}
        onCwd={setNewTaskCwd}
        onPermissionMode={setPermissionMode}
        onPrompt={(prompt) => setNewTaskDraft(prompt)}
        onSubmit={() => void onCreateAndSend()}
      />
    );
  }



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
            disabled={sending}
            onClick={() => resetContext(conv.id)}
            title="Start next reply with no tool resume"
          >
            Reset context
          </button>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {messages.length === 0 && (
          <div className="chat-empty chat-empty-hero">
            <p className="eyebrow">New Agent Chat</p>
            <h2>What should {member?.name} work on?</h2>
            <p className="muted">
              Use this thread for coding tasks, project inspection, and focused fixes.
            </p>
            <div className="starter-prompts">
              {starterPrompts.map((prompt) => (
                <button key={prompt} onClick={() => {
                  setDraft(prompt);
                  chatTextareaRef.current?.focus();
                }}>
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {previewMessages.map((m) => (
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
          ref={chatTextareaRef}
          rows={3}
          value={draft}
          disabled={sending}
          placeholder={
            sending
              ? "Agent 正在运行…"
              : "随心输入"
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void onSend();
            }
          }}
        />
        <div className="chat-composer-actions">
          <div className="composer-tools">
            <button className="composer-tool-chip" type="button" title="Attach file">
              <span className="tool-chip-icon">+</span>
              <span>Attach</span>
            </button>
            <button className="composer-tool-chip" type="button" title="Mention workspace">
              <span className="tool-chip-icon">⌂</span>
              <span>Workspace</span>
            </button>
            <span className="muted">Enter 发送 · Shift+Enter 换行</span>
          </div>
          {sending ? (
            <button
              className="danger stop-icon-button"
              type="button"
              disabled={!running}
              title={running ? "停止" : "启动中"}
              aria-label={running ? "停止运行" : "正在启动"}
              onClick={() => void stopActive(conv.id)}
            >
              {running ? "■" : "…"}
            </button>
          ) : (
            <button
              className="primary send-icon-button"
              type="button"
              disabled={!draft.trim()}
              title="发送"
              aria-label="发送消息"
              onClick={onSend}
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function NewTaskHome({
  draft,
  members,
  selectedMemberId,
  cwd,
  permissionMode,
  preflightMsg,
  onDraft,
  onMember,
  onCwd,
  onPermissionMode,
  onPrompt,
  onSubmit
}: {
  draft: string;
  members: ReturnType<typeof useConversationStore.getState>["members"];
  selectedMemberId: string;
  cwd: string;
  permissionMode: "auto" | "ask";
  preflightMsg: string | null;
  onDraft: (value: string) => void;
  onMember: (value: string) => void;
  onCwd: (value: string) => void;
  onPermissionMode: (value: "auto" | "ask") => void;
  onPrompt: (value: string) => void;
  onSubmit: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="new-task-view">
      <section className="new-task-hero" aria-label="New task">
        <h1>
          FreeBuddy
          <span>本地 CLI Agent 工作台</span>
        </h1>
        <p className="new-task-subtitle">
          选择一个本地 agent，给它一个工作目录，然后开始编码、检查或改造项目。
        </p>

        <div className="new-task-chips" aria-label="Common tasks">
          {newTaskPrompts.map(([label, prompt]) => (
            <button
              key={label}
              onClick={() => {
                onPrompt(prompt);
                textareaRef.current?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="new-task-composer">
          <textarea
            ref={textareaRef}
            autoFocus
            rows={4}
            value={draft}
            placeholder="随心输入"
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
          />

          <div className="new-task-toolbar">
            <label>
              <span>Agent</span>
              <select value={selectedMemberId} onChange={(event) => onMember(event.target.value)}>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>权限</span>
              <select value={permissionMode} onChange={(event) => onPermissionMode(event.target.value as "auto" | "ask")}>
                <option value="auto">自动</option>
                <option value="ask">每次询问</option>
              </select>
            </label>
            <button
              className="new-task-send send-icon-button"
              type="button"
              disabled={!draft.trim() || members.length === 0}
              title="开始任务"
              aria-label="开始任务"
              onClick={onSubmit}
            >
              ↑
            </button>
          </div>

          <div className="workspace-picker">
            <div className="new-task-tools">
              <button className="composer-tool-chip" type="button" title="Attach file">
                <span className="tool-chip-icon">+</span>
                <span>Attach</span>
              </button>
              <button
                className="composer-tool-chip"
                type="button"
                title="选择工作目录"
                onClick={async () => {
                  try {
                    const path = await cliClient.selectDirectory();
                    if (path) onCwd(path);
                  } catch (e) {
                    console.error("Error picking directory:", e);
                  }
                }}
              >
                <span className="tool-chip-icon">⌂</span>
                <span>Workspace</span>
              </button>
            </div>
            <input
              value={cwd}
              placeholder="/absolute/path，可选；不填则使用默认运行目录"
              onChange={(event) => onCwd(event.target.value)}
            />
          </div>
        </div>

        {preflightMsg && <div className="preflight-warn new-task-warn">{preflightMsg}</div>}
      </section>
    </div>
  );
}
