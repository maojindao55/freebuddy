import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";

import { useConversationStore } from "@/store/conversationStore";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { cliClient } from "@/services/cli/client";
import type { ChatAttachment, ConversationMessage } from "@/services/cli/types";
import { displayAgentName } from "@/config/agentDisplay";
import {
  attachmentPreviewUrl,
  createChatAttachment,
  formatBytes,
  MAX_ATTACHMENTS_PER_MESSAGE,
  validateAttachmentCandidate
} from "@/utils/chatAttachments";
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

function attachmentSummary(attachment: ChatAttachment): string {
  return [
    attachment.mimeType || attachment.extension || attachment.kind,
    typeof attachment.size === "number" ? formatBytes(attachment.size) : ""
  ]
    .filter(Boolean)
    .join(" - ");
}

function PaperclipIcon() {
  return (
    <svg
      className="tool-chip-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.57 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      className="tool-chip-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

function AttachmentTray({
  attachments,
  onRemove
}: {
  attachments: ChatAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="attachment-tray" aria-label="Pending attachments">
      {attachments.map((attachment) => (
        <div className="attachment-chip" key={attachment.id} title={attachment.path}>
          <span className="attachment-chip-icon">
            {attachment.kind === "image" ? (
              <>
                <img
                  src={attachmentPreviewUrl(attachment.path)}
                  alt=""
                  loading="lazy"
                  className="attachment-chip-icon-img"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                    const sibling = event.currentTarget
                      .nextElementSibling as HTMLElement | null;
                    if (sibling) sibling.style.display = "inline";
                  }}
                />
                <span
                  className="attachment-chip-icon-fallback"
                  style={{ display: "none" }}
                >
                  IMG
                </span>
              </>
            ) : attachment.kind === "code" ? (
              "CODE"
            ) : (
              "FILE"
            )}
          </span>
          <span className="attachment-chip-main">
            <span className="attachment-chip-name">{attachment.name}</span>
            <span className="attachment-chip-meta">{attachmentSummary(attachment)}</span>
          </span>
          <button
            type="button"
            className="attachment-chip-remove"
            aria-label={`Remove ${attachment.name}`}
            onClick={() => onRemove(attachment.id)}
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}

export function ChatView() {
  const activeId = useConversationStore((s) => s.activeId);
  const conversations = useConversationStore((s) => s.conversations);
  const members = useConversationStore((s) => s.members);
  const messagesMap = useConversationStore((s) => s.messages);
  const liveMap = useConversationStore((s) => s.live);
  const createConversation = useConversationStore((s) => s.newConversation);
  const sendMessage = useConversationStore((s) => s.sendMessage);
  const stopActive = useConversationStore((s) => s.stopActive);
  const setApprovalMode = useConversationStore(
    (s) => s.setConversationApprovalMode
  );

  const messages = useMemo(
    () => (activeId ? messagesMap[activeId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES),
    [activeId, messagesMap]
  );
  const live = activeId ? liveMap[activeId] : undefined;

  const resolve = useCliExecutorStore((s) => s.resolve);
  const check = useCliExecutorStore((s) => s.check);

  const [draft, setDraft] = useState("");
  const [newTaskDraft, setNewTaskDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [newTaskPendingAttachments, setNewTaskPendingAttachments] = useState<ChatAttachment[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState(members[0]?.id ?? "");
  const [newTaskCwd, setNewTaskCwd] = useState("");
  const [permissionMode, setPermissionMode] = useState<"auto" | "ask">("auto");
  const [preflightMsg, setPreflightMsg] = useState<string | null>(null);
  const [submitPreview, setSubmitPreview] = useState<{
    conversationId: string;
    prompt: string;
    attachments: ChatAttachment[];
    createdAt: string;
    userMessageId: string;
    assistantMessageId: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);

  const conv = conversations.find((c) => c.id === activeId);
  const member = conv ? members.find((m) => m.id === conv.agentId) : undefined;
  const agentDisplayName = displayAgentName(member?.name ?? conv?.agentName, conv?.adapter);
  const running =
    live?.status === "running" || live?.status === "starting";
  const sending =
    running ||
    (submitPreview?.conversationId === conv?.id);

  const previewMessages = useMemo<ConversationMessage[]>(() => {
    if (!conv || submitPreview?.conversationId !== conv.id) return [];
    const existing = new Set(messages.map((m) => m.id));
    const preview: ConversationMessage[] = [
      {
        id: submitPreview.userMessageId,
        conversationId: conv.id,
        role: "user",
        status: "sent",
        content: submitPreview.prompt,
        attachments: submitPreview.attachments,
        createdAt: submitPreview.createdAt,
        updatedAt: submitPreview.createdAt
      },
      {
        id: submitPreview.assistantMessageId,
        conversationId: conv.id,
        role: "assistant",
        status: "starting",
        content: "[]",
        createdAt: submitPreview.createdAt,
        updatedAt: submitPreview.createdAt
      }
    ];
    // Once the real (same-id) message is in the store, drop the preview copy so
    // the same React element (stable key) takes over without a remount/flash.
    return preview.filter((m) => !existing.has(m.id));
  }, [conv, submitPreview, messages]);

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
    isNearBottomRef.current = true;
  }, [activeId]);

  useEffect(() => {
    const resolved = conv?.approvalMode ?? member?.cli.approvalMode;
    if (resolved) {
      setPermissionMode(resolved);
    }
  }, [activeId, conv?.approvalMode, member?.cli.approvalMode]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, live, submitPreview]);

  const mergeSelectedAttachments = (
    current: ChatAttachment[],
    selected: Awaited<ReturnType<typeof cliClient.selectAttachments>>
  ) => {
    const byPath = new Map(current.map((attachment) => [attachment.path, attachment]));
    const warnings: string[] = [];

    for (const candidate of selected) {
      if (byPath.size >= MAX_ATTACHMENTS_PER_MESSAGE) {
        warnings.push(`每条消息最多添加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件。`);
        break;
      }

      const attachment = createChatAttachment(candidate);
      const validation = validateAttachmentCandidate(attachment);
      if (!validation.ok) {
        const name = candidate.name || candidate.path;
        warnings.push(
          validation.reason === "file_too_large"
            ? `${name} 超过 50 MB 附件大小限制。`
            : `${name} 不是支持的附件类型。`
        );
        continue;
      }
      if (!attachment || byPath.has(attachment.path)) continue;
      byPath.set(attachment.path, attachment);
    }

    return { attachments: Array.from(byPath.values()), warnings };
  };

  const handleSelectAttachments = async (target: "chat" | "new") => {
    if (sending) return;
    if (!cliClient.isAvailable()) {
      setPreflightMsg("附件功能需要在 Electron 桌面端使用。");
      return;
    }

    try {
      const selected = await cliClient.selectAttachments();
      if (selected.length === 0) return;
      const current =
        target === "chat" ? pendingAttachments : newTaskPendingAttachments;
      const { attachments, warnings } = mergeSelectedAttachments(current, selected);
      if (target === "chat") {
        setPendingAttachments(attachments);
      } else {
        setNewTaskPendingAttachments(attachments);
      }
      setPreflightMsg(warnings[0] ?? null);
    } catch (error) {
      setPreflightMsg(`选择附件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleRemovePendingAttachment = (id: string) => {
    setPendingAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  };

  const handleRemoveNewTaskPendingAttachment = (id: string) => {
    setNewTaskPendingAttachments((prev) =>
      prev.filter((attachment) => attachment.id !== id)
    );
  };

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
          `${resolved?.label ?? "Agent"} is not installed. Open Settings -> Cli Agents to install.`
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
    const attachmentsToSend = newTaskPendingAttachments;
    const selectedMember = members.find((m) => m.id === selectedMemberId) ?? members[0];
    if ((!prompt && attachmentsToSend.length === 0) || !selectedMember) return;

    setPreflightMsg(null);
    try {
      if (!(await preflightMember(selectedMember))) return;

      const newConv = await createConversation({
        member: selectedMember,
        cwd: newTaskCwd.trim() || undefined,
        title: (prompt || attachmentsToSend[0]?.name || "附件").slice(0, 24),
        approvalMode: permissionMode
      });
      setNewTaskDraft("");
      setNewTaskPendingAttachments([]);
      await sendMessage({
        conversationId: newConv.id,
        prompt,
        attachments: attachmentsToSend,
        approvalModeOverride: permissionMode
      });
    } catch (e) {
      setNewTaskDraft(prompt);
      setNewTaskPendingAttachments(attachmentsToSend);
      setPreflightMsg(`Task failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onSend = async () => {
    const prompt = draft.trim();
    const attachmentsToSend = pendingAttachments;
    if (!conv || !member || (!prompt && attachmentsToSend.length === 0) || sending) return;
    setPreflightMsg(null);
    isNearBottomRef.current = true;
    const userMessageId = nanoid();
    const assistantMessageId = nanoid();
    const preview = {
      conversationId: conv.id,
      prompt,
      attachments: attachmentsToSend,
      createdAt: new Date().toISOString(),
      userMessageId,
      assistantMessageId
    };
    setSubmitPreview(preview);
    setDraft("");
    setPendingAttachments([]);
    try {
      if (!(await preflightMember(member))) {
        setSubmitPreview(null);
        setDraft(prompt);
        setPendingAttachments(attachmentsToSend);
        return;
      }
      // submitPreview stays set until the real (same-id) messages are in the
      // store; the deduped merged list hands off in place (no remount/flash).
      await sendMessage({
        conversationId: conv.id,
        prompt,
        attachments: attachmentsToSend,
        userMessageId,
        assistantMessageId,
        approvalModeOverride: permissionMode
      });
      setSubmitPreview(null);
    } catch (e) {
      setSubmitPreview(null);
      setDraft(prompt);
      setPendingAttachments(attachmentsToSend);
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
        pendingAttachments={newTaskPendingAttachments}
        preflightMsg={preflightMsg}
        onDraft={setNewTaskDraft}
        onMember={setSelectedMemberId}
        onCwd={setNewTaskCwd}
        onPermissionMode={setPermissionMode}
        onSelectAttachments={() => void handleSelectAttachments("new")}
        onRemoveAttachment={handleRemoveNewTaskPendingAttachment}
        onPrompt={(prompt) => setNewTaskDraft(prompt)}
        onSubmit={() => void onCreateAndSend()}
      />
    );
  }



  return (
    <div className="chat-view">
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
        {[...messages, ...previewMessages].map((m) => (
          <MessageBubble key={m.id} message={m} adapter={conv?.adapter} />
        ))}
      </div>

      {preflightMsg && <div className="preflight-warn">{preflightMsg}</div>}

      <div className="chat-composer">
        <div className="composer-context-row">
          <span>{agentDisplayName}</span>
          <span>{conv.cwd ? conv.cwd : "No workspace selected"}</span>
        </div>
        <AttachmentTray
          attachments={pendingAttachments}
          onRemove={handleRemovePendingAttachment}
        />
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
            <button
              className="composer-tool-chip"
              type="button"
              title="Attach file"
              disabled={sending || pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              onClick={() => void handleSelectAttachments("chat")}
            >
              <PaperclipIcon />
              <span>Attach</span>
            </button>
            <label
              className="composer-permission"
              title="Permission mode for tool execution"
            >
              <span className="composer-permission-label">权限</span>
              <select
                className="composer-permission-select"
                value={permissionMode}
                disabled={sending}
                onChange={(event) => {
                  const next = event.target.value as "auto" | "ask";
                  setPermissionMode(next);
                  if (conv?.id) void setApprovalMode(conv.id, next);
                }}
              >
                <option value="auto">自动</option>
                <option value="ask">每次询问</option>
              </select>
            </label>
          </div>
          <div className="composer-tail">
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
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
                disabled={!(draft.trim() || pendingAttachments.length > 0)}
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
    </div>
  );
}

function NewTaskHome({
  draft,
  members,
  selectedMemberId,
  cwd,
  permissionMode,
  pendingAttachments,
  preflightMsg,
  onDraft,
  onMember,
  onCwd,
  onPermissionMode,
  onSelectAttachments,
  onRemoveAttachment,
  onPrompt,
  onSubmit
}: {
  draft: string;
  members: ReturnType<typeof useConversationStore.getState>["members"];
  selectedMemberId: string;
  cwd: string;
  permissionMode: "auto" | "ask";
  pendingAttachments: ChatAttachment[];
  preflightMsg: string | null;
  onDraft: (value: string) => void;
  onMember: (value: string) => void;
  onCwd: (value: string) => void;
  onPermissionMode: (value: "auto" | "ask") => void;
  onSelectAttachments: () => void;
  onRemoveAttachment: (id: string) => void;
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
          <AttachmentTray
            attachments={pendingAttachments}
            onRemove={onRemoveAttachment}
          />
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
              disabled={!(draft.trim() || pendingAttachments.length > 0) || members.length === 0}
              title="开始任务"
              aria-label="开始任务"
              onClick={onSubmit}
            >
              ↑
            </button>
          </div>

          <div className="workspace-picker">
            <div className="new-task-tools">
              <button
                className="composer-tool-chip"
                type="button"
                title="Attach file"
                disabled={pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                onClick={onSelectAttachments}
              >
                <PaperclipIcon />
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
                <FolderIcon />
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
