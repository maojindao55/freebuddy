import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import { useConversationStore } from "@/store/conversationStore";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkflowTeamStore } from "@/store/workflowTeamStore";
import { cliClient } from "@/services/cli/client";
import type { ChatAttachment, ConversationMessage } from "@/services/cli/types";
import type {
  WorkflowTeam,
  WorkflowTeamPreview
} from "@/services/workflowTeams/types";
import { workflowTeamName } from "@/services/workflowTeams/types";
import { workflowFollowupAgentId } from "@/services/workflows/types";
import { workflowClient } from "@/services/workflows/client";
import { displayAgentName } from "@/config/agentDisplay";
import {
  attachmentPreviewUrl,
  composeMessageWithAttachments,
  createChatAttachment,
  formatBytes,
  MAX_ATTACHMENTS_PER_MESSAGE,
  validateAttachmentCandidate
} from "@/utils/chatAttachments";
import { MessageBubble } from "./MessageBubble";
import { parseSlashDraft, SlashCommandMenu } from "./SlashCommandMenu";
import {
  mergeSessionMetaItems,
  type AvailableCommandItem
} from "@/store/sessionMetaUtils";
import { upsertConversationMessage } from "@/store/conversationUtils";

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

function StopIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="7" y="5" width="3" height="14" rx="1" />
      <rect x="14" y="5" width="3" height="14" rx="1" />
    </svg>
  );
}

function ResumeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="7 4 19 12 7 20 7 4" fill="currentColor" />
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

function teamConversationMember(
  team: WorkflowTeam,
  members: ReturnType<typeof useConversationStore.getState>["members"]
) {
  const preferredRole =
    team.roles.find((role) => role.kind === "summarizer") ??
    team.roles.find((role) => !role.canWrite) ??
    team.roles[0];
  if (!preferredRole) return members[0];
  return (
    members.find((member) => member.id === preferredRole.agentId) ?? members[0]
  );
}

export function ChatView() {
  const { t } = useTranslation();
  const activeId = useConversationStore((s) => s.activeId);
  const conversations = useConversationStore((s) => s.conversations);
  const members = useConversationStore((s) => s.members);
  // Select only the active conversation's slices so a background conversation
  // streaming events (which always rebuilds the messages/live maps) does not
  // re-render this component.
  const messages = useConversationStore((s) =>
    s.activeId ? s.messages[s.activeId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );
  const live = useConversationStore((s) =>
    s.activeId ? s.live[s.activeId] : undefined
  );
  const createConversation = useConversationStore((s) => s.newConversation);
  const sendMessage = useConversationStore((s) => s.sendMessage);
  const stopActive = useConversationStore((s) => s.stopActive);
  const setApprovalMode = useConversationStore(
    (s) => s.setConversationApprovalMode
  );

  const [taskMode, setTaskMode] = useState<"normal" | "team">(
    "normal"
  );
  const teamMode = taskMode === "team";
  const workflowMode = false;
  const createAndStartTeam = useWorkflowStore((s) => s.createAndStartTeam);
  const activeConversationId = useConversationStore((s) => s.activeId);

  const teams = useWorkflowTeamStore((s) => s.teams);
  const teamsLoaded = useWorkflowTeamStore((s) => s.loaded);
  const loadTeams = useWorkflowTeamStore((s) => s.load);
  const pendingTeamPreview = useWorkflowTeamStore((s) => s.pendingTeamPreview);
  const pendingTeamErrors = useWorkflowTeamStore((s) => s.pendingErrors);
  const previewTeam = useWorkflowTeamStore((s) => s.previewTeam);
  const clearTeamPreview = useWorkflowTeamStore((s) => s.clearPreview);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");

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
  const [slashIndex, setSlashIndex] = useState(0);

  const conv = conversations.find((c) => c.id === activeId);
  const activeRun = useWorkflowStore((s) => s.activeRun);
  const workflowFollowupAgent =
    activeRun && activeRun.conversationId === conv?.id
      ? workflowFollowupAgentId(activeRun)
      : undefined;
  const member = conv
    ? members.find((m) => m.id === (workflowFollowupAgent ?? conv.agentId))
    : undefined;
  const agentDisplayName = displayAgentName(member?.name ?? conv?.agentName, member?.cli.adapter ?? conv?.adapter);
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

  const availableCommands = useMemo(() => {
    if (!conv) return [];
    return mergeSessionMetaItems(
      messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => {
          try {
            const items = JSON.parse(message.content);
            return Array.isArray(items) ? items : [];
          } catch {
            return [];
          }
        }),
      live?.items
    ).commands;
  }, [conv, live?.items, messages]);

  const slashDraft = useMemo(() => parseSlashDraft(draft), [draft]);

  const filteredSlashCommands = useMemo(() => {
    if (!slashDraft) return [];
    const query = slashDraft.query.trim().toLowerCase();
    return availableCommands.filter((command) =>
      command.name.toLowerCase().startsWith(query)
    );
  }, [availableCommands, slashDraft]);

  useEffect(() => {
    setSlashIndex(0);
  }, [draft]);

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
    clearTeamPreview();
  }, [activeConversationId, clearTeamPreview]);

  useEffect(() => {
    if (!teamsLoaded) void loadTeams();
  }, [teamsLoaded, loadTeams]);

  useEffect(() => {
    if (!selectedTeamId && teams.length > 0) {
      const firstEnabled = teams.find((t) => t.enabled);
      if (firstEnabled) setSelectedTeamId(firstEnabled.id);
    }
  }, [teams, selectedTeamId]);

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

    if (teamMode) {
      if ((!prompt && attachmentsToSend.length === 0) || !selectedTeamId) return;
      const team = teams.find((tt) => tt.id === selectedTeamId);
      if (!team) return;
      const teamMember = teamConversationMember(team, members);
      if (!teamMember) return;
      setPreflightMsg(null);
      try {
        if (!(await preflightMember(teamMember))) return;
        const cwd = newTaskCwd.trim() || undefined;
        const newConv = await createConversation({
          member: teamMember,
          cwd,
          title: (
            prompt ||
            attachmentsToSend[0]?.name ||
            t("chat.defaultAttachmentTitle") ||
            team.name
          ).slice(0, 24),
          approvalMode: permissionMode
        });
        setNewTaskDraft("");
        setNewTaskPendingAttachments([]);
        const userMsgId = nanoid();
        const now = new Date().toISOString();
        const savedUser = await cliClient.appendMessage({
          id: userMsgId,
          conversationId: newConv.id,
          role: "user",
          status: "sent",
          content: prompt,
          attachments: attachmentsToSend
        });
        useConversationStore.setState((s) => ({
          messages: {
            ...s.messages,
            [newConv.id]: upsertConversationMessage(
              s.messages[newConv.id] ?? [],
              {
                id: userMsgId,
                conversationId: newConv.id,
                role: "user",
                status: "sent",
                content: prompt,
                ...(attachmentsToSend.length
                  ? { attachments: savedUser.attachments ?? attachmentsToSend }
                  : {}),
                createdAt: now,
                updatedAt: now
              }
            )
          }
        }));
        await createAndStartTeam({
          teamId: team.id,
          conversationId: newConv.id,
          goal: composeMessageWithAttachments(prompt, attachmentsToSend),
          cwd
        });
      } catch (e) {
        setNewTaskDraft(prompt);
        setNewTaskPendingAttachments(attachmentsToSend);
        setPreflightMsg(
          t("errors.taskFailed", {
            err: e instanceof Error ? e.message : String(e)
          })
        );
      }
      return;
    }

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

  const handleSelectSlashCommand = (command: AvailableCommandItem) => {
    setDraft(`/${command.name} `);
    chatTextareaRef.current?.focus();
  };

  const resolveWorkflowFollowupMember = async () => {
    if (!conv || !workflowClient.isAvailable()) return member;
    const run =
      activeRun?.conversationId === conv.id
        ? activeRun
        : (await workflowClient.listRuns(conv.id))[0];
    const agentId = run ? workflowFollowupAgentId(run) : undefined;
    return members.find((m) => m.id === (agentId ?? conv.agentId));
  };

  const onSend = async () => {
    const prompt = draft.trim();
    const attachmentsToSend = pendingAttachments;
    const targetMember = await resolveWorkflowFollowupMember();
    if (!conv || !targetMember || (!prompt && attachmentsToSend.length === 0) || sending) return;
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
      if (!(await preflightMember(targetMember))) {
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
    const prompt = newTaskDraft.trim();
    if (!prompt) return;
    try {
      if (teamMode && selectedTeamId) {
        await previewTeam({
          teamId: selectedTeamId,
          goal: prompt,
          cwd: newTaskCwd || undefined
        });
      }
    } catch (e) {
      setPreflightMsg(t("errors.sendFailed", { err: e instanceof Error ? e.message : String(e) }));
    }
  };

  const onCreateTeamConversation = async () => {
    if (!teamMode) return;
    if (!pendingTeamPreview) return;
    const team = teams.find((tt) => tt.id === pendingTeamPreview.teamId);
    if (!team) return;
    const teamMember = teamConversationMember(team, members);
    if (!teamMember) return;
    const cwd = newTaskCwd.trim() || pendingTeamPreview?.cwd;
    setPreflightMsg(null);
    try {
      if (!(await preflightMember(teamMember))) return;
      const newConv = await createConversation({
        member: teamMember,
        cwd,
        title: (pendingTeamPreview.goal || pendingTeamPreview.teamName || "").slice(0, 24),
        approvalMode: permissionMode
      });
      setNewTaskDraft("");
      setNewTaskPendingAttachments([]);
      clearTeamPreview();
      await createAndStartTeam({
        teamId: pendingTeamPreview.teamId,
        conversationId: newConv.id,
        goal: pendingTeamPreview.goal,
        cwd: pendingTeamPreview.cwd ?? cwd
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
        taskMode={taskMode}
        teams={teams}
        selectedTeamId={selectedTeamId}
        preflightMsg={preflightMsg}
        onDraft={setNewTaskDraft}
        onMember={setSelectedMemberId}
        onCwd={setNewTaskCwd}
        onPermissionMode={setPermissionMode}
        onSelectAttachments={() => void handleSelectAttachments("new")}
        onRemoveAttachment={handleRemoveNewTaskPendingAttachment}
        onTaskMode={(m) => {
          setTaskMode(m);
          clearTeamPreview();
        }}
        onTeam={setSelectedTeamId}
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

      <div className="chat-composer">
        <div className="composer-context-row">
          <span>{agentDisplayName}</span>
          <span>{conv.cwd ? conv.cwd : t("chat.noWorkspace")}</span>
        </div>
        <AttachmentTray
          attachments={pendingAttachments}
          onRemove={handleRemovePendingAttachment}
        />
        <div className="composer-input-wrap">
          {slashDraft && availableCommands.length > 0 ? (
            <SlashCommandMenu
              commands={availableCommands}
              query={slashDraft.query}
              selectedIndex={slashIndex}
              onSelect={handleSelectSlashCommand}
            />
          ) : null}
          <textarea
            ref={chatTextareaRef}
            rows={3}
            value={draft}
            disabled={sending}
            placeholder={
              sending
                ? t("chat.agentRunning")
                : availableCommands.length > 0
                  ? t("chat.inputPlaceholderWithSlash")
                  : t("chat.inputPlaceholder")
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (slashDraft && filteredSlashCommands.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashIndex((index) => (index + 1) % filteredSlashCommands.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashIndex(
                    (index) =>
                      (index - 1 + filteredSlashCommands.length) %
                      filteredSlashCommands.length
                  );
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const selected = filteredSlashCommands[slashIndex];
                  if (selected) handleSelectSlashCommand(selected);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft("");
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
          />
        </div>
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
                {running ? <StopIcon /> : <span className="starting-spinner">…</span>}
              </button>
            ) : (
              <button
                className="primary send-icon-button"
                type="button"
                disabled={!(draft.trim() || pendingAttachments.length > 0)}
                title={t("chat.send")}
                aria-label={t("chat.sendAria")}
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
  taskMode,
  teams,
  selectedTeamId,
  preflightMsg,
  onDraft,
  onMember,
  onCwd,
  onPermissionMode,
  onSelectAttachments,
  onRemoveAttachment,
  onTaskMode,
  onTeam,
  onSubmit
}: {
  draft: string;
  members: ReturnType<typeof useConversationStore.getState>["members"];
  selectedMemberId: string;
  cwd: string;
  permissionMode: "auto" | "ask";
  pendingAttachments: ChatAttachment[];
  taskMode: "normal" | "team";
  teams: WorkflowTeam[];
  selectedTeamId: string;
  preflightMsg: string | null;
  onDraft: (value: string) => void;
  onMember: (value: string) => void;
  onCwd: (value: string) => void;
  onPermissionMode: (value: "auto" | "ask") => void;
  onSelectAttachments: () => void;
  onRemoveAttachment: (id: string) => void;
  onTaskMode: (value: "normal" | "team") => void;
  onTeam: (id: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const teamMode = taskMode === "team";

  return (
    <div className="new-task-view">
      <div className="new-task-stack">
        <h1 className="new-task-title">{t("chat.heroTitle")}</h1>
        <div
          className="new-task-mode-tabs"
          role="tablist"
          aria-label={t("workflow.modeTabsAria")}
        >
          <button
            className={`new-task-mode-tab${taskMode === "normal" ? " active" : ""}`}
            type="button"
            role="tab"
            aria-selected={taskMode === "normal"}
            onClick={() => onTaskMode("normal")}
          >
            {t("workflow.normalMode")}
          </button>
          <button
            className={`new-task-mode-tab${taskMode === "team" ? " active" : ""}`}
            type="button"
            role="tab"
            aria-selected={taskMode === "team"}
            onClick={() => onTaskMode("team")}
          >
            {t("workflow.teamExecution")}
          </button>
        </div>

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
          {teamMode ? (
            <label>
              <span>{t("workflow.selectTeam")}</span>
              {teams.filter((tt) => tt.enabled).length === 0 ? (
                <select disabled value="">
                  <option value="">{t("workflow.noTeams")}</option>
                </select>
              ) : (
                <select
                  value={selectedTeamId}
                  onChange={(event) => onTeam(event.target.value)}
                >
                  {teams
                    .filter((tt) => tt.enabled)
                    .map((tt) => (
                      <option key={tt.id} value={tt.id}>
                        {workflowTeamName(tt, t)}
                      </option>
                    ))}
                </select>
              )}
            </label>
          ) : (
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
          )}
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
                !(draft.trim() || pendingAttachments.length > 0) ||
                (teamMode ? !selectedTeamId : members.length === 0)
              }
              title={
                teamMode ? t("workflow.teamExecution") : t("chat.startTask")
              }
              aria-label={
                teamMode ? t("workflow.teamExecution") : t("chat.startTask")
              }
              onClick={onSubmit}
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
