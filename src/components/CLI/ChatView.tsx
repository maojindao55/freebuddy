import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import { useConversationStore } from "@/store/conversationStore";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { cliClient } from "@/services/cli/client";
import type { ChatAttachment, ConversationMessage } from "@/services/cli/types";
import type { WorkflowPlan } from "@/services/workflows/types";
import { displayAgentName } from "@/config/agentDisplay";
import {
  attachmentPreviewUrl,
  createChatAttachment,
  formatBytes,
  MAX_ATTACHMENTS_PER_MESSAGE,
  validateAttachmentCandidate
} from "@/utils/chatAttachments";
import { MessageBubble } from "./MessageBubble";
import { WorkflowPlanCard } from "../Workflows/WorkflowPlanCard";

const EMPTY_MESSAGES: never[] = [];

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
  const { t } = useTranslation();
  if (attachments.length === 0) return null;

  return (
    <div className="attachment-tray" aria-label={t("chat.pendingAttachmentsAria")}>
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
            aria-label={t("chat.removeAttachmentAria", { name: attachment.name })}
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
  const { t } = useTranslation();
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

  const [workflowMode, setWorkflowMode] = useState(false);
  const pendingPlan = useWorkflowStore((s) => s.pendingPlan);
  const pendingErrors = useWorkflowStore((s) => s.pendingErrors);
  const previewReviewLoop = useWorkflowStore((s) => s.previewReviewLoop);
  const createAndStartWorkflow = useWorkflowStore((s) => s.createAndStart);
  const clearPendingPlan = useWorkflowStore((s) => s.clearPending);
  const activeConversationId = useConversationStore((s) => s.activeId);

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
    (submitPreview !== null && submitPreview.conversationId === conv?.id);
  const starterPrompts = [
    t("chat.starter.one"),
    t("chat.starter.two"),
    t("chat.starter.three")
  ];

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
    clearPendingPlan();
  }, [activeConversationId, clearPendingPlan]);

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
        warnings.push(t("errors.attachmentLimit", { count: MAX_ATTACHMENTS_PER_MESSAGE }));
        break;
      }

      const attachment = createChatAttachment(candidate);
      const validation = validateAttachmentCandidate(attachment);
      if (!validation.ok) {
        const name = candidate.name || candidate.path;
        warnings.push(
          validation.reason === "file_too_large"
            ? t("errors.attachmentTooLarge", { name })
            : t("errors.attachmentType", { name })
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
      setPreflightMsg(t("errors.attachmentDesktopOnly"));
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
      setPreflightMsg(t("errors.attachmentSelectFailed", { err: error instanceof Error ? error.message : String(error) }));
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
      setPreflightMsg(t("errors.cliBridgeUnavailable"));
      return false;
    }
    try {
      const r = await cliClient.check(targetMember.cli.adapter, targetMember.cli.binary);
      await check(targetMember.cli.adapter);
      if (!r.installed) {
        const resolved = resolve(targetMember.cli.adapter);
        setPreflightMsg(
          t("errors.agentNotInstalled", { agent: resolved?.label ?? t("chat.agent") })
        );
        return false;
      }
      return true;
    } catch (err) {
      setPreflightMsg(t("errors.checkFailed", { err: err instanceof Error ? err.message : String(err) }));
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
        title: (prompt || attachmentsToSend[0]?.name || t("chat.defaultAttachmentTitle")).slice(0, 24),
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
      setPreflightMsg(t("errors.taskFailed", { err: e instanceof Error ? e.message : String(e) }));
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
      setPreflightMsg(t("errors.sendFailed", { err: e instanceof Error ? e.message : String(e) }));
    }
  };

  const handleGeneratePlan = async () => {
    const prompt = draft.trim() || newTaskDraft.trim();
    if (!prompt) return;
    try {
      await previewReviewLoop({
        goal: prompt,
        cwd: conv?.cwd || newTaskCwd || undefined
      });
    } catch (e) {
      setPreflightMsg(t("errors.sendFailed", { err: e instanceof Error ? e.message : String(e) }));
    }
  };

  const onCreateWorkflowConversation = async () => {
    if (!pendingPlan) return;
    const selectedMember = members.find((m) => m.id === selectedMemberId) ?? members[0];
    if (!selectedMember) return;
    const cwd = newTaskCwd.trim() || pendingPlan.cwd;
    setPreflightMsg(null);
    try {
      if (!(await preflightMember(selectedMember))) return;
      const newConv = await createConversation({
        member: selectedMember,
        cwd,
        title: pendingPlan.name.slice(0, 24),
        approvalMode: permissionMode
      });
      setNewTaskDraft("");
      setNewTaskPendingAttachments([]);
      await createAndStartWorkflow({
        conversationId: newConv.id,
        plan: { ...pendingPlan, cwd }
      });
    } catch (e) {
      setPreflightMsg(t("errors.taskFailed", { err: e instanceof Error ? e.message : String(e) }));
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
        workflowMode={workflowMode}
        pendingPlan={pendingPlan}
        pendingErrors={pendingErrors}
        preflightMsg={preflightMsg}
        onDraft={setNewTaskDraft}
        onMember={setSelectedMemberId}
        onCwd={setNewTaskCwd}
        onPermissionMode={setPermissionMode}
        onSelectAttachments={() => void handleSelectAttachments("new")}
        onRemoveAttachment={handleRemoveNewTaskPendingAttachment}
        onWorkflowMode={setWorkflowMode}
        onGeneratePlan={() => void handleGeneratePlan()}
        onCreateWorkflowConversation={onCreateWorkflowConversation}
        onSubmit={() => void onCreateAndSend()}
      />
    );
  }



  return (
    <div className="chat-view">
      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {messages.length === 0 && (
          <div className="chat-empty chat-empty-hero">
            <p className="eyebrow">{t("chat.newAgentChat")}</p>
            <h2>{t("chat.emptyHeroHeading", { name: member?.name ?? "" })}</h2>
            <p className="muted">
              {t("chat.emptyHeroBody")}
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

      {(pendingPlan || pendingErrors.length > 0) && (
        <div className="workflow-plan-preview">
          {pendingErrors.length > 0 && (
            <div className="preflight-warn">{t("workflow.invalidPlan")}: {pendingErrors.join("; ")}</div>
          )}
          {pendingPlan && (
            <WorkflowPlanCard
              plan={pendingPlan}
              conversationId={activeConversationId ?? undefined}
            />
          )}
        </div>
      )}

      <div className="chat-composer">
        <div className="composer-context-row">
          <span>{agentDisplayName}</span>
          <span>{conv.cwd ? conv.cwd : t("chat.noWorkspace")}</span>
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
              ? t("chat.agentRunning")
              : t("chat.inputPlaceholder")
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
              title={t("chat.attachFile")}
              disabled={sending || pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              onClick={() => void handleSelectAttachments("chat")}
            >
              <PaperclipIcon />
              <span>{t("chat.attach")}</span>
            </button>
            <label
              className="composer-permission"
              title={t("chat.permissionHint")}
            >
              <span className="composer-permission-label">{t("chat.permission")}</span>
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
                <option value="auto">{t("chat.approvalAuto")}</option>
                <option value="ask">{t("chat.approvalAsk")}</option>
              </select>
            </label>
            <button
              className={`composer-tool-chip${workflowMode ? " active" : ""}`}
              type="button"
              title={t("workflow.modeHint")}
              aria-pressed={workflowMode}
              onClick={() => setWorkflowMode((v) => !v)}
              disabled={sending}
            >
              <span>{t("workflow.mode")}</span>
            </button>
          </div>
          <div className="composer-tail">
            <span className="composer-hint">{t("chat.enterHint")}</span>
            {sending ? (
              <button
                className="danger stop-icon-button"
                type="button"
                disabled={!running}
                title={running ? t("chat.stop") : t("status.starting")}
                aria-label={running ? t("chat.stopAria") : t("chat.startingAria")}
                onClick={() => void stopActive(conv.id)}
              >
                {running ? "■" : "…"}
              </button>
            ) : (
              <button
                className="primary send-icon-button"
                type="button"
                disabled={!(draft.trim() || pendingAttachments.length > 0)}
                title={t("chat.send")}
                aria-label={t("chat.sendAria")}
                onClick={workflowMode ? () => void handleGeneratePlan() : onSend}
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
  workflowMode,
  pendingPlan,
  pendingErrors,
  preflightMsg,
  onDraft,
  onMember,
  onCwd,
  onPermissionMode,
  onSelectAttachments,
  onRemoveAttachment,
  onWorkflowMode,
  onGeneratePlan,
  onCreateWorkflowConversation,
  onSubmit
}: {
  draft: string;
  members: ReturnType<typeof useConversationStore.getState>["members"];
  selectedMemberId: string;
  cwd: string;
  permissionMode: "auto" | "ask";
  pendingAttachments: ChatAttachment[];
  workflowMode: boolean;
  pendingPlan: WorkflowPlan | null;
  pendingErrors: string[];
  preflightMsg: string | null;
  onDraft: (value: string) => void;
  onMember: (value: string) => void;
  onCwd: (value: string) => void;
  onPermissionMode: (value: "auto" | "ask") => void;
  onSelectAttachments: () => void;
  onRemoveAttachment: (id: string) => void;
  onWorkflowMode: (value: boolean) => void;
  onGeneratePlan: () => void;
  onCreateWorkflowConversation: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="new-task-view">
      <div className="new-task-stack">
        <h1 className="new-task-title">{t("chat.heroTitle")}</h1>
        {(pendingPlan || pendingErrors.length > 0) && (
          <div className="workflow-plan-preview">
            {pendingErrors.length > 0 && (
              <div className="preflight-warn">
                {t("workflow.invalidPlan")}: {pendingErrors.join("; ")}
              </div>
            )}
            {pendingPlan && (
              <WorkflowPlanCard
                plan={pendingPlan}
                onRun={() => void onCreateWorkflowConversation()}
              />
            )}
          </div>
        )}
        <section className="new-task-composer" aria-label={t("chat.newTaskAria")}>
        <AttachmentTray
          attachments={pendingAttachments}
          onRemove={onRemoveAttachment}
        />
        <textarea
          ref={textareaRef}
          autoFocus
          rows={4}
          value={draft}
          placeholder={t("chat.inputPlaceholder")}
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
            <span>{t("chat.agent")}</span>
            <select value={selectedMemberId} onChange={(event) => onMember(event.target.value)}>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("chat.permission")}</span>
            <select value={permissionMode} onChange={(event) => onPermissionMode(event.target.value as "auto" | "ask")}>
              <option value="auto">{t("chat.approvalAuto")}</option>
              <option value="ask">{t("chat.approvalAsk")}</option>
            </select>
          </label>
          <button
            className="composer-tool-chip"
            type="button"
            title={t("chat.attachFile")}
            disabled={pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
            onClick={onSelectAttachments}
          >
            <PaperclipIcon />
            <span>{t("chat.attach")}</span>
          </button>
          <button
            className="composer-tool-chip"
            type="button"
            title={t("chat.selectCwd")}
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
            <span>{t("chat.workspace")}</span>
          </button>
          <button
            className={`composer-tool-chip${workflowMode ? " active" : ""}`}
            type="button"
            title={t("workflow.modeHint")}
            aria-pressed={workflowMode}
            onClick={() => onWorkflowMode(!workflowMode)}
          >
            <span>{t("workflow.mode")}</span>
          </button>
          <input
            className="new-task-cwd-input"
            value={cwd}
            onChange={(event) => onCwd(event.target.value)}
          />

          <div className="new-task-toolbar-tail">
            <button
              className="new-task-send send-icon-button"
              type="button"
              disabled={
                workflowMode
                  ? !draft.trim() || members.length === 0
                  : !(draft.trim() || pendingAttachments.length > 0) || members.length === 0
              }
              title={t("chat.startTask")}
              aria-label={t("chat.startTask")}
              onClick={workflowMode ? onGeneratePlan : onSubmit}
            >
              ↑
            </button>
          </div>
        </div>

        {preflightMsg && <div className="preflight-warn new-task-warn">{preflightMsg}</div>}
      </section>
      </div>
    </div>
  );
}
