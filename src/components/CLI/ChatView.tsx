import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent
} from "react";
import { nanoid } from "nanoid";
import { ExternalLink, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useConversationStore } from "@/store/conversationStore";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkflowTeamStore } from "@/store/workflowTeamStore";
import { useNewTaskUiStore } from "@/store/newTaskUiStore";
import { useAgentBridgeStore } from "@/store/agentBridgeStore";
import { cliClient } from "@/services/cli/client";
import type {
  AttachmentPrepareRejection,
  ChatAttachment,
  Conversation,
  ConversationContextReference,
  ConversationMessage,
  SessionConfigOption
} from "@/services/cli/types";
import type {
  WorkflowTeam,
  WorkflowTeamPreview
} from "@/services/workflowTeams/types";
import type {
  NativePluginAgent,
  NativePluginRecord
} from "@/services/plugins/types";
import { workflowTeamName } from "@/services/workflowTeams/types";
import {
  workflowFollowupAgentId,
  type WorkflowPlan
} from "@/services/workflows/types";
import { pendingManualGatePhaseId } from "@/services/workflows/planning";
import { workflowClient } from "@/services/workflows/client";
import { displayAgentName } from "@/config/agentDisplay";
import {
  attachmentPreviewUrl,
  composeMessageWithAttachments,
  formatBytes,
  MAX_ATTACHMENTS_PER_MESSAGE
} from "@/utils/chatAttachments";
import { assignShareReferencesToMessages } from "@/utils/conversationShareLinks";
import {
  mergeSelectedAttachments as mergePendingAttachments,
  shouldDiscardCreatedManagedCandidate
} from "@/utils/mergeSelectedAttachments";
import { MessageBubble } from "./MessageBubble";
import { AgentAvatar } from "./AgentAvatar";
import { CodeWhipOverlay } from "./CodeWhipOverlay";
import { useReplayStore } from "@/store/replayStore";
import { parseSlashDraft, SlashCommandMenu } from "./SlashCommandMenu";
import {
  mergeSessionMetaItems,
  type AvailableCommandItem,
  type ConfigOptionItem
} from "@/store/sessionMetaUtils";
import {
  buildConversationTitle,
  upsertConversationMessage
} from "@/store/conversationUtils";
import { SessionConfigPicker } from "./SessionConfigPicker";
import { ComposerAddMenu } from "./ComposerAddMenu";
import { AgentPicker } from "./AgentPicker";
import { useSkillStore } from "@/store/skillStore";
import { useAttachmentImport } from "@/hooks/useAttachmentImport";
import { useWorkspaceFileMentions } from "@/hooks/useWorkspaceFileMentions";
import { resolveDeferredAttachmentImport } from "@/utils/attachmentImport";
import {
  isManagedAttachmentPathProtected,
  protectManagedAttachments,
  unprotectManagedAttachments
} from "@/utils/managedAttachmentProtection";
import { WorkspaceFileMentionMenu } from "./WorkspaceFileMentionMenu";
import {
  agentEntriesNeedingRefresh,
  buildAgentAvailabilityGroups,
  type AgentAvailabilityEntry,
  type AgentAvailabilityGroups
} from "@/utils/agentAvailability";

const EMPTY_MESSAGES: never[] = [];

function pluginAgentForAdapter(adapter?: string): NativePluginAgent | undefined {
  const normalized = adapter?.trim().toLowerCase();
  if (normalized?.startsWith("codex")) return "codex";
  if (normalized?.startsWith("claude")) return "claude";
  return undefined;
}

function pluginMention(plugin: NativePluginRecord): string {
  const label = `@${plugin.name}`;
  const uri = plugin.mentionUri
    ?? (plugin.marketplace ? `plugin://${plugin.name}@${plugin.marketplace}` : undefined);
  return uri ? `[${label}](${uri})` : label;
}

function insertPluginMention(
  value: string,
  plugin: NativePluginRecord,
  textarea: HTMLTextAreaElement | null,
  onChange: (value: string) => void
) {
  const start = textarea?.selectionStart ?? value.length;
  const end = textarea?.selectionEnd ?? start;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leadingSpace = before && !/\s$/.test(before) ? " " : "";
  const trailingSpace = after && /^\s/.test(after) ? "" : " ";
  const insertion = `${leadingSpace}${pluginMention(plugin)}${trailingSpace}`;
  onChange(`${before}${insertion}${after}`);
  const caret = before.length + insertion.length;
  requestAnimationFrame(() => {
    textarea?.focus();
    textarea?.setSelectionRange(caret, caret);
  });
}

function detachAttachmentsForSend(
  snapshot: ChatAttachment[],
  current: ChatAttachment[]
): ChatAttachment[] {
  if (snapshot.length === 0) return current;
  const snapshotPaths = new Set(snapshot.map((attachment) => attachment.path));
  return current.filter((attachment) => !snapshotPaths.has(attachment.path));
}

function restoreAttachmentsForSend(
  snapshot: ChatAttachment[],
  current: ChatAttachment[]
): ChatAttachment[] {
  const byPath = new Map(current.map((attachment) => [attachment.path, attachment]));
  for (const attachment of snapshot) {
    byPath.set(attachment.path, attachment);
  }
  return Array.from(byPath.values());
}

function attachmentSummary(attachment: ChatAttachment): string {
  return [
    attachment.mimeType || attachment.extension || attachment.kind,
    typeof attachment.size === "number" ? formatBytes(attachment.size) : ""
  ]
    .filter(Boolean)
    .join(" - ");
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
  onRemove,
  removeDisabled = false
}: {
  attachments: ChatAttachment[];
  onRemove: (id: string) => void;
  removeDisabled?: boolean;
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
            disabled={removeDisabled}
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

function WorkflowApprovalCard({
  phaseTitle,
  onApprove,
  onRequestChanges,
  onStop
}: {
  phaseTitle: string;
  onApprove: () => void;
  onRequestChanges: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="msg msg-assistant workflow-approval-msg">
      <div className="workflow-approval-spacer" aria-hidden="true" />
      <div className="msg-content-wrapper">
        <div className="msg-bubble workflow-approval-card">
          <div className="workflow-approval-card-main">
            <span className="workflow-approval-eyebrow">
              {t("workflow.approvalCardEyebrow", { phase: phaseTitle })}
            </span>
            <p>{t("workflow.approvalCardBody")}</p>
          </div>
          <div className="workflow-approval-card-actions">
            <button type="button" onClick={onRequestChanges}>
              {t("workflow.requestChanges")}
            </button>
            <button type="button" className="primary" onClick={onApprove}>
              {t("workflow.approveGate")}
            </button>
            <button type="button" className="danger" onClick={onStop}>
              {t("workflow.stop")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContextReferenceCard({
  label,
  title,
  meta,
  description,
  sourceAdapter,
  sourceAgentId,
  sourceAgentName,
  sourceAvailable,
  onOpenSource
}: {
  label: string;
  title: string;
  meta?: string;
  description: string;
  sourceAdapter?: string;
  sourceAgentId?: string;
  sourceAgentName?: string;
  sourceAvailable: boolean;
  onOpenSource(): void;
}) {
  const { t } = useTranslation();
  const initial =
    (sourceAgentName?.trim().charAt(0) || sourceAdapter?.trim().charAt(0) || "?").toUpperCase();
  const openLabel = sourceAvailable
    ? t("handoff.openSource")
    : t("handoff.sourceDeleted");
  return (
    <article
      className={`context-reference-card${sourceAvailable ? "" : " is-unavailable"}`}
      aria-label={label}
    >
      <AgentAvatar
        adapter={sourceAdapter}
        agentId={sourceAgentId}
        className="context-reference-card-avatar"
        fallback={<span aria-hidden="true">{initial}</span>}
      />
      <div className="context-reference-card-body">
        <div className="context-reference-card-head">
          <span className="context-reference-card-label">{label}</span>
          <button
            type="button"
            className="context-reference-card-open"
            disabled={!sourceAvailable}
            title={openLabel}
            aria-label={openLabel}
            onClick={onOpenSource}
          >
            <ExternalLink size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        <strong className="context-reference-card-title">{title}</strong>
        {meta ? (
          <span className="context-reference-card-meta">{meta}</span>
        ) : null}
        <span className="context-reference-card-description">{description}</span>
      </div>
    </article>
  );
}

function HandoffConversationCard({
  conversation,
  contextAvailable,
  sourceAvailable,
  onOpenSource
}: {
  conversation: Conversation;
  contextAvailable: boolean;
  sourceAvailable: boolean;
  onOpenSource(): void;
}) {
  const { t } = useTranslation();
  const metaParts = [
    `${conversation.sourceAgentName ?? "?"} → ${conversation.agentName}`
  ];
  return (
    <ContextReferenceCard
      label={t("handoff.referenceLabel")}
      title={conversation.title}
      meta={metaParts.join(" · ")}
      description={t(
        contextAvailable
          ? "handoff.referenceDescription"
          : "handoff.referenceDescriptionUnavailable"
      )}
      sourceAdapter={conversation.sourceAdapter}
      sourceAgentId={conversation.sourceAgentId}
      sourceAgentName={conversation.sourceAgentName}
      sourceAvailable={sourceAvailable}
      onOpenSource={onOpenSource}
    />
  );
}

function SharedConversationReferences({
  references,
  conversations
}: {
  references: ConversationContextReference[];
  conversations: Conversation[];
}) {
  const { t } = useTranslation();
  if (references.length === 0) return null;
  return (
    <div
      className="context-reference-tray"
      aria-label={t("contextShare.referencesLabel")}
    >
      {references.map((reference) => {
        const sourceAvailable = conversations.some(
          (conversation) => conversation.id === reference.source.conversationId
        );
        return (
          <ContextReferenceCard
            key={reference.id}
            label={t("contextShare.referenceTypeShare")}
            title={reference.source.title}
            meta={t("contextShare.chipMeta", {
              agent: reference.source.agentName,
              count: reference.source.messageCount
            })}
            description={t(
              reference.transcriptAvailable
                ? reference.transcriptTruncated
                  ? "contextShare.historyTruncated"
                  : "contextShare.historyAvailable"
                : "contextShare.historyUnavailable"
            )}
            sourceAdapter={reference.source.adapter}
            sourceAgentId={reference.source.agentId}
            sourceAgentName={reference.source.agentName}
            sourceAvailable={sourceAvailable}
            onOpenSource={() => {
              if (!sourceAvailable) return;
              void useConversationStore
                .getState()
                .setActive(reference.source.conversationId);
            }}
          />
        );
      })}
    </div>
  );
}

export function ChatView({
  onOpenAgentSettings
}: {
  onOpenAgentSettings?: () => void;
}) {
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
  const notify = useAgentBridgeStore((s) => s.notify);
  const setApprovalMode = useConversationStore(
    (s) => s.setConversationApprovalMode
  );
  const setConfigOptionOverrides = useConversationStore(
    (s) => s.setConversationConfigOptionOverrides
  );
  const setConversationSkills = useConversationStore((s) => s.setConversationSkills);
  const skills = useSkillStore((s) => s.skills);
  const skillsLoaded = useSkillStore((s) => s.loaded);
  const loadSkills = useSkillStore((s) => s.load);

  const taskMode = useNewTaskUiStore((s) => s.taskMode);
  const setTaskMode = useNewTaskUiStore((s) => s.setTaskMode);
  const requestedTeamId = useNewTaskUiStore((s) => s.requestedTeamId);
  const setRequestedTeamId = useNewTaskUiStore((s) => s.setRequestedTeamId);
  const requestedCwd = useNewTaskUiStore((s) => s.requestedCwd);
  const cwdRequestToken = useNewTaskUiStore((s) => s.cwdRequestToken);
  const teamMode = taskMode === "team";
  const workflowMode = false;
  const createAndStartTeam = useWorkflowStore((s) => s.createAndStartTeam);
  const loadWorkflowForConversation = useWorkflowStore((s) => s.loadForConversation);
  const workflowSteps = useWorkflowStore((s) => s.steps);
  const approveGate = useWorkflowStore((s) => s.approveGate);
  const requestGateChanges = useWorkflowStore((s) => s.requestGateChanges);
  const stopWorkflow = useWorkflowStore((s) => s.stop);
  const activeConversationId = useConversationStore((s) => s.activeId);

  const teams = useWorkflowTeamStore((s) => s.teams);
  const teamsLoaded = useWorkflowTeamStore((s) => s.loaded);
  const loadTeams = useWorkflowTeamStore((s) => s.load);
  const pendingTeamPreview = useWorkflowTeamStore((s) => s.pendingTeamPreview);
  const pendingTeamErrors = useWorkflowTeamStore((s) => s.pendingErrors);
  const previewTeam = useWorkflowTeamStore((s) => s.previewTeam);
  const clearTeamPreview = useWorkflowTeamStore((s) => s.clearPreview);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");

  const refreshRuntimes = useCliExecutorStore((s) => s.refreshRuntimes);
  const executorsLoaded = useCliExecutorStore((s) => s.loaded);
  const executorOverrides = useCliExecutorStore((s) => s.overrides);
  const executorRuntimes = useCliExecutorStore((s) => s.runtimes);

  const [draft, setDraft] = useState("");
  const [newTaskDraft, setNewTaskDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [newTaskPendingAttachments, setNewTaskPendingAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [sendLock, setSendLock] = useState(false);
  const [newTaskSendLock, setNewTaskSendLock] = useState(false);
  const sendInFlightRef = useRef(false);
  const newTaskSendInFlightRef = useRef(false);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [checkingAgentIds, setCheckingAgentIds] = useState<Set<string>>(
    () => new Set()
  );
  const checkingAgentIdsRef = useRef<Set<string>>(new Set());
  const memberSelectionTouchedRef = useRef(false);
  const [newTaskSkillIds, setNewTaskSkillIds] = useState<string[]>([]);
  const [newTaskCwd, setNewTaskCwd] = useState("");
  const [newTaskConfigOptions, setNewTaskConfigOptions] = useState<
    SessionConfigOption[]
  >([]);
  const [newTaskConfigOptionOverrides, setNewTaskConfigOptionOverrides] =
    useState<Record<string, string>>({});
  const [newTaskConfigLoading, setNewTaskConfigLoading] = useState(false);
  const newTaskConfigProbeGenerationRef = useRef(0);
  const [permissionMode, setPermissionMode] = useState<"auto" | "ask">("auto");
  const [preflightMsg, setPreflightMsg] = useState<string | null>(null);
  const [contextReferences, setContextReferences] = useState<
    ConversationContextReference[]
  >([]);
  const [submitPreview, setSubmitPreview] = useState<{
    conversationId: string;
    prompt: string;
    attachments: ChatAttachment[];
    createdAt: string;
    userMessageId: string;
    assistantMessageId: string;
  } | null>(null);
  const [pendingWorkflowAction, setPendingWorkflowAction] = useState<{
    runId: string;
    phaseId: string;
    type: "request_changes";
  } | null>(null);
  const [approvedWorkflowGate, setApprovedWorkflowGate] = useState<{
    runId: string;
    phaseId: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingAttachmentsRef = useRef(pendingAttachments);
  const draftRef = useRef(draft);
  const conversationDraftsRef = useRef(new Map<string, string>());
  const conversationAttachmentsRef = useRef(new Map<string, ChatAttachment[]>());
  const previousConversationIdRef = useRef(activeId);
  const newTaskPendingAttachmentsRef = useRef(newTaskPendingAttachments);
  const attachmentImportGenerationRef = useRef(0);
  const isNearBottomRef = useRef(true);
  const [slashIndex, setSlashIndex] = useState(0);
  const conv = conversations.find((c) => c.id === activeId);
  useEffect(() => {
    let active = true;
    if (!activeId) {
      setContextReferences([]);
      return () => {
        active = false;
      };
    }
    void cliClient
      .listConversationContextReferences(activeId)
      .then((references) => {
        if (active) setContextReferences(references);
      })
      .catch(() => {
        if (active) setContextReferences([]);
      });
    return () => {
      active = false;
    };
  }, [activeId]);
  const activeRun = useWorkflowStore((s) => s.activeRun);
  const workflowFollowupAgent =
    activeRun && activeRun.conversationId === conv?.id
      ? workflowFollowupAgentId(activeRun)
      : undefined;
  const member = conv
    ? members.find((m) => m.id === (workflowFollowupAgent ?? conv.agentId))
    : undefined;
  const membersById = useMemo(
    () => new Map(members.map((entry) => [entry.id, entry])),
    [members]
  );
  const membersByName = useMemo(
    () => new Map(members.map((entry) => [entry.name, entry])),
    [members]
  );
  const agentAvailability = useMemo(
    () => buildAgentAvailabilityGroups(members, executorRuntimes),
    [executorRuntimes, members]
  );
  const availableAgentIds = useMemo(
    () => new Set(agentAvailability.available.map((entry) => entry.member.id)),
    [agentAvailability.available]
  );
  const agentDisplayName = displayAgentName(member?.name ?? conv?.agentName, member?.cli.adapter ?? conv?.adapter);
  const running =
    live?.status === "running" || live?.status === "starting";
  const sending =
    running ||
    (submitPreview !== null && submitPreview.conversationId === conv?.id);
  const replayConvId = useReplayStore((s) => s.conversationId);
  const replayIndex = useReplayStore((s) => s.index);
  const stopReplay = useReplayStore((s) => s.stop);
  const replaying = replayConvId === conv?.id && replayConvId !== null;
  const starterPrompts = [
    t("chat.starter.one"),
    t("chat.starter.two"),
    t("chat.starter.three")
  ];

  const sessionMeta = useMemo(() => {
    if (!conv) {
      return {
        commands: [] as AvailableCommandItem[],
        configOptions: [] as ConfigOptionItem[]
      };
    }
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
    );
  }, [conv, live?.items, messages]);
  const availableCommands = sessionMeta.commands;
  const sessionConfigOptions = sessionMeta.configOptions;

  const slashDraft = useMemo(() => parseSlashDraft(draft), [draft]);
  const chatFileMentions = useWorkspaceFileMentions({
    value: draft,
    cwd: conv?.cwd,
    onChange: setDraft,
    textareaRef: chatTextareaRef
  });

  const workflowPlan = useMemo<WorkflowPlan | null>(() => {
    if (!activeRun || activeRun.conversationId !== conv?.id) return null;
    try {
      return JSON.parse(activeRun.planJson) as WorkflowPlan;
    } catch {
      return null;
    }
  }, [activeRun, conv?.id]);

  const gatingPhaseId = useMemo(() => {
    if (!workflowPlan) return undefined;
    return pendingManualGatePhaseId(
      workflowPlan.phases,
      workflowSteps.map((s) => ({ stepId: s.stepId, status: s.status }))
    );
  }, [workflowPlan, workflowSteps]);

  const gatingPhase = workflowPlan?.phases.find(
    (phase) => phase.id === gatingPhaseId
  );
  const workflowGateApprovedLocally =
    approvedWorkflowGate !== null &&
    approvedWorkflowGate.runId === activeRun?.id &&
    approvedWorkflowGate.phaseId === gatingPhaseId;
  const workflowGateIsActionable =
    activeRun?.status === "running" ||
    activeRun?.status === "paused" ||
    activeRun?.status === "blocked" ||
    activeRun?.status === "pending_approval";

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

  useEffect(() => {
    if (!approvedWorkflowGate) return;
    if (
      activeRun?.id !== approvedWorkflowGate.runId ||
      gatingPhaseId !== approvedWorkflowGate.phaseId
    ) {
      setApprovedWorkflowGate(null);
    }
  }, [activeRun?.id, approvedWorkflowGate, gatingPhaseId]);

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

  const storeFrames = useReplayStore((s) => s.frames);
  const replayFrame =
    replaying && replayIndex >= 0 && replayIndex < storeFrames.length
      ? storeFrames[replayIndex]
      : undefined;
  const displayMessages = useMemo<ConversationMessage[]>(() => {
    if (!replaying) return [...messages, ...previewMessages];
    if (!replayFrame) return [];
    return messages.slice(0, replayFrame.messageIndex + 1);
  }, [replaying, replayFrame, messages, previewMessages]);
  const shareReferencesByMessageId = useMemo(
    () => assignShareReferencesToMessages(displayMessages, contextReferences),
    [displayMessages, contextReferences]
  );
  const replayPartial = useMemo<{
    messageId: string;
    blockLimit?: number;
    typingChars?: number;
  } | null>(() => {
    if (!replaying || !replayFrame) return null;
    const message = messages[replayFrame.messageIndex];
    return message
      ? {
          messageId: message.id,
          blockLimit: replayFrame.blockLimit,
          typingChars: replayFrame.typingChars
        }
      : null;
  }, [replaying, replayFrame, messages]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const offset = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = offset < 120;
  };

  const checkAgentEntries = useCallback(
    async (entries: AgentAvailabilityEntry[]) => {
      if (!cliClient.isAvailable()) return;
      const targets = entries.filter(
        (entry) => !checkingAgentIdsRef.current.has(entry.member.id)
      );
      if (targets.length === 0) return;

      const nextChecking = new Set(checkingAgentIdsRef.current);
      targets.forEach((entry) => nextChecking.add(entry.member.id));
      checkingAgentIdsRef.current = nextChecking;
      setCheckingAgentIds(new Set(nextChecking));

      let cursor = 0;
      const worker = async () => {
        while (cursor < targets.length) {
          const entry = targets[cursor];
          cursor += 1;
          const member = entry.member;
          const resolved = useCliExecutorStore
            .getState()
            .resolve(member.cli.adapter);
          try {
            await cliClient.check(
              member.cli.adapter,
              member.cli.binary || resolved?.binary,
              { ...(resolved?.env ?? {}), ...(member.cli.env ?? {}) },
              entry.runtimeKey
            );
          } catch {
            // Background availability checks are reflected by runtime state.
          }
        }
      };

      try {
        await Promise.all(
          Array.from({ length: Math.min(2, targets.length) }, () => worker())
        );
        await refreshRuntimes();
      } finally {
        const remaining = new Set(checkingAgentIdsRef.current);
        targets.forEach((entry) => remaining.delete(entry.member.id));
        checkingAgentIdsRef.current = remaining;
        setCheckingAgentIds(new Set(remaining));
      }
    },
    [refreshRuntimes]
  );

  useEffect(() => {
    if (activeId || taskMode !== "normal" || !executorsLoaded) return;
    void checkAgentEntries(agentEntriesNeedingRefresh(agentAvailability));
  }, [
    activeId,
    agentAvailability,
    checkAgentEntries,
    executorsLoaded,
    taskMode
  ]);

  useEffect(() => {
    if (activeId || taskMode !== "normal" || memberSelectionTouchedRef.current) {
      return;
    }
    const preferred = agentAvailability.available[0]?.member.id ?? "";
    if (preferred !== selectedMemberId) setSelectedMemberId(preferred);
  }, [
    activeId,
    agentAvailability.available,
    selectedMemberId,
    taskMode
  ]);

  useEffect(() => {
    if (activeId) memberSelectionTouchedRef.current = false;
  }, [activeId]);

  useEffect(() => {
    if (!skillsLoaded) void loadSkills();
  }, [loadSkills, skillsLoaded]);

  useEffect(() => {
    if (activeId || taskMode !== "normal") return;
    const selectedMember = members.find((entry) => entry.id === selectedMemberId);
    setNewTaskSkillIds(selectedMember?.cli.skillIds ?? []);
  }, [activeId, members, selectedMemberId, taskMode]);

  useEffect(() => {
    const generation = ++newTaskConfigProbeGenerationRef.current;
    setNewTaskConfigOptions([]);
    setNewTaskConfigOptionOverrides({});
    setNewTaskConfigLoading(false);
    if (activeId || taskMode !== "normal" || !executorsLoaded) return;

    const selectedMember = members.find(
      (entry) => entry.id === selectedMemberId
    );
    if (
      !selectedMember ||
      !availableAgentIds.has(selectedMember.id) ||
      !cliClient.isAvailable()
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      const resolved = useCliExecutorStore
        .getState()
        .resolve(selectedMember.cli.adapter);
      const probeInput = {
        agentId: selectedMember.id,
        adapter: selectedMember.cli.adapter,
        binary: selectedMember.cli.binary || resolved?.binary,
        extraArgs: [
          ...(resolved?.extraArgs ?? []),
          ...(selectedMember.cli.extraArgs ?? [])
        ],
        env: { ...(resolved?.env ?? {}), ...(selectedMember.cli.env ?? {}) },
        cwd: newTaskCwd.trim() || undefined
      };
      setNewTaskConfigLoading(true);
      void (async () => {
        let hasCachedOptions = false;
        try {
          const cached = await cliClient.getCachedSessionConfigOptions(probeInput);
          if (newTaskConfigProbeGenerationRef.current !== generation) return;
          if (cached.length > 0) {
            hasCachedOptions = true;
            setNewTaskConfigOptions(cached);
            setNewTaskConfigLoading(false);
          }

          const fresh = await cliClient.inspectSessionConfigOptions(probeInput);
          if (newTaskConfigProbeGenerationRef.current !== generation) return;
          if (fresh.length > 0) setNewTaskConfigOptions(fresh);
        } catch {
          if (
            newTaskConfigProbeGenerationRef.current === generation &&
            !hasCachedOptions
          ) {
            setNewTaskConfigOptions([]);
          }
        } finally {
          if (newTaskConfigProbeGenerationRef.current !== generation) return;
          setNewTaskConfigLoading(false);
        }
      })();
    }, 150);

    return () => window.clearTimeout(timer);
  }, [
    activeId,
    taskMode,
    executorsLoaded,
    executorOverrides,
    availableAgentIds,
    members,
    selectedMemberId
  ]);

  useEffect(() => {
    isNearBottomRef.current = true;
  }, [activeId]);

  useEffect(() => {
    if (activeId) void loadWorkflowForConversation(activeId);
  }, [activeId, loadWorkflowForConversation]);

  useEffect(() => {
    stopReplay();
  }, [activeId, stopReplay]);

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
    if (
      requestedTeamId &&
      requestedTeamId !== selectedTeamId &&
      teams.some((team) => team.id === requestedTeamId && team.enabled)
    ) {
      setSelectedTeamId(requestedTeamId);
    }
  }, [requestedTeamId, selectedTeamId, teams]);

  useEffect(() => {
    if (activeId) return;
    if (cwdRequestToken === 0) return;
    setNewTaskCwd(requestedCwd ?? "");
  }, [activeId, cwdRequestToken, requestedCwd]);

  useEffect(() => {
    const resolved = conv?.approvalMode ?? member?.cli.approvalMode;
    if (resolved) {
      setPermissionMode(resolved);
    }
  }, [activeId, conv?.approvalMode, member?.cli.approvalMode]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && (replaying || isNearBottomRef.current)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, live, submitPreview, gatingPhaseId, replaying, replayIndex]);

  useEffect(() => {
    if (!pendingWorkflowAction) return;
    if (
      activeRun?.id !== pendingWorkflowAction.runId ||
      gatingPhaseId !== pendingWorkflowAction.phaseId
    ) {
      setPendingWorkflowAction(null);
    }
  }, [activeRun?.id, gatingPhaseId, pendingWorkflowAction]);

  useEffect(() => {
    const previousId = previousConversationIdRef.current;
    if (previousId === activeId) return;

    if (previousId) {
      conversationDraftsRef.current.set(previousId, draftRef.current);
      conversationAttachmentsRef.current.set(
        previousId,
        pendingAttachmentsRef.current
      );
    }

    setDraft(activeId ? conversationDraftsRef.current.get(activeId) ?? "" : "");
    setPendingAttachments(
      activeId
        ? conversationAttachmentsRef.current.get(activeId) ?? []
        : []
    );
    previousConversationIdRef.current = activeId;
  }, [activeId]);

  const formatMergeWarnings = (
    warnings: ReturnType<typeof mergePendingAttachments>["warnings"]
  ) =>
    warnings.map((warning) => {
      if (warning.code === "attachmentLimit") {
        return t("errors.attachmentLimit", { count: MAX_ATTACHMENTS_PER_MESSAGE });
      }
      const name = warning.name ?? "";
      return warning.code === "attachmentTooLarge"
        ? t("errors.attachmentTooLarge", { name })
        : t("errors.attachmentType", { name });
    });

  const applyAttachmentCandidates = (
    target: "chat" | "new",
    selected: Awaited<ReturnType<typeof cliClient.selectAttachments>>,
    extraWarnings: string[] = []
  ) => {
    const setter =
      target === "chat" ? setPendingAttachments : setNewTaskPendingAttachments;

    setter((current) => {
      const { attachments, warnings } = mergePendingAttachments(current, selected);
      const acceptedPaths = new Set(attachments.map((attachment) => attachment.path));
      for (const candidate of selected) {
        if (
          shouldDiscardCreatedManagedCandidate(candidate) &&
          !acceptedPaths.has(candidate.path)
        ) {
          void cliClient.discardManagedAttachmentIfUnreferenced(candidate.path);
        }
      }
      setPreflightMsg([...extraWarnings, ...formatMergeWarnings(warnings)][0] ?? null);
      return attachments;
    });
  };

  const attachmentRejectionWarnings = (rejections: AttachmentPrepareRejection[]) =>
    rejections.map((rejection) =>
      rejection.reason === "file_too_large"
        ? t("errors.attachmentTooLarge", { name: rejection.name })
        : t("errors.attachmentType", { name: rejection.name })
    );

  const discardRejectedManagedCandidates = (
    selected: Awaited<ReturnType<typeof cliClient.selectAttachments>>
  ) => {
    for (const candidate of selected) {
      if (shouldDiscardCreatedManagedCandidate(candidate)) {
        void cliClient.discardManagedAttachmentIfUnreferenced(candidate.path);
      }
    }
  };

  const discardAttachmentIfManaged = (attachment: ChatAttachment | undefined) => {
    if (attachment?.managed && attachment.created) {
      void cliClient.discardManagedAttachmentIfUnreferenced(attachment.path);
    }
  };

  const cleanupPendingManagedIfUnreferenced = () => {
    if (!cliClient.isAvailable()) return;
    const paths = Array.from(new Set([
      ...pendingAttachmentsRef.current,
      ...newTaskPendingAttachmentsRef.current,
      ...Array.from(conversationAttachmentsRef.current.values()).flat()
    ]
      .filter(
        (attachment) =>
          attachment.managed &&
          attachment.created &&
          !isManagedAttachmentPathProtected(attachment.path)
      )
      .map((attachment) => attachment.path)));
    if (paths.length > 0) {
      cliClient.discardManagedAttachments(paths);
    }
  };

  const canImportAttachments = (target: "chat" | "new") => {
    if (attachmentBusy) return false;
    if (target === "chat") {
      if (sending || replaying || sendLock || sendInFlightRef.current) return false;
    } else if (newTaskSendLock || newTaskSendInFlightRef.current) {
      return false;
    }
    const current =
      target === "chat" ? pendingAttachments : newTaskPendingAttachments;
    return current.length < MAX_ATTACHMENTS_PER_MESSAGE;
  };

  const isImportBlockedBySendLock = (target: "chat" | "new") =>
    target === "chat"
      ? sendLock || sendInFlightRef.current
      : newTaskSendLock || newTaskSendInFlightRef.current;

  const handleImportAttachments = async (target: "chat" | "new", files: File[]) => {
    if (files.length === 0 || !canImportAttachments(target)) return;
    if (!cliClient.isAvailable()) {
      setPreflightMsg(t("errors.attachmentDesktopOnly"));
      return;
    }

    const currentAttachments =
      target === "chat"
        ? pendingAttachmentsRef.current
        : newTaskPendingAttachmentsRef.current;
    const remaining = MAX_ATTACHMENTS_PER_MESSAGE - currentAttachments.length;
    if (remaining <= 0) return;

    const existingPaths = currentAttachments.map((attachment) => attachment.path);

    const importGeneration = ++attachmentImportGenerationRef.current;

    setAttachmentBusy(true);
    try {
      const { candidates, rejections, overflow } = await cliClient.prepareAttachmentFiles(
        files,
        remaining,
        existingPaths
      );
      const rejectionWarnings = [
        ...(overflow
          ? [t("errors.attachmentLimit", { count: MAX_ATTACHMENTS_PER_MESSAGE })]
          : []),
        ...attachmentRejectionWarnings(rejections)
      ];
      if (
        importGeneration !== attachmentImportGenerationRef.current ||
        isImportBlockedBySendLock(target)
      ) {
        discardRejectedManagedCandidates(candidates);
        return;
      }
      if (candidates.length === 0) {
        setPreflightMsg(rejectionWarnings[0] ?? t("errors.attachmentImportEmpty"));
        return;
      }
      applyAttachmentCandidates(target, candidates, rejectionWarnings);
    } catch (error) {
      setPreflightMsg(
        t("errors.attachmentSelectFailed", {
          err: error instanceof Error ? error.message : String(error)
        })
      );
    } finally {
      if (importGeneration === attachmentImportGenerationRef.current) {
        setAttachmentBusy(false);
      }
    }
  };

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    newTaskPendingAttachmentsRef.current = newTaskPendingAttachments;
  }, [newTaskPendingAttachments]);

  useEffect(() => {
    const onBeforeUnload = () => cleanupPendingManagedIfUnreferenced();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      attachmentImportGenerationRef.current += 1;
      cleanupPendingManagedIfUnreferenced();
    };
  }, []);

  const handleSelectAttachments = async (target: "chat" | "new") => {
    if (!canImportAttachments(target)) return;
    if (!cliClient.isAvailable()) {
      setPreflightMsg(t("errors.attachmentDesktopOnly"));
      return;
    }

    const importGeneration = attachmentImportGenerationRef.current;

    try {
      const selected = await cliClient.selectAttachments();
      const deferredImport = resolveDeferredAttachmentImport({
        capturedGeneration: importGeneration,
        currentGeneration: attachmentImportGenerationRef.current,
        sendLockBlocked: isImportBlockedBySendLock(target),
        canImport: canImportAttachments(target),
        selected
      });
      if (!deferredImport.shouldApply) {
        discardRejectedManagedCandidates([...deferredImport.selected]);
        return;
      }
      applyAttachmentCandidates(target, [...deferredImport.selected]);
    } catch (error) {
      setPreflightMsg(
        t("errors.attachmentSelectFailed", {
          err: error instanceof Error ? error.message : String(error)
        })
      );
    }
  };

  const chatAttachmentImport = useAttachmentImport({
    disabled: !canImportAttachments("chat"),
    onImport: (files) => void handleImportAttachments("chat", files)
  });

  const newTaskAttachmentImport = useAttachmentImport({
    disabled: !canImportAttachments("new"),
    onImport: (files) => void handleImportAttachments("new", files)
  });

  const handleRemovePendingAttachment = (id: string) => {
    if (attachmentBusy || sendLock || sendInFlightRef.current) return;
    setPendingAttachments((prev) => {
      discardAttachmentIfManaged(prev.find((attachment) => attachment.id === id));
      return prev.filter((attachment) => attachment.id !== id);
    });
  };

  const handleRemoveNewTaskPendingAttachment = (id: string) => {
    if (attachmentBusy || newTaskSendLock || newTaskSendInFlightRef.current) return;
    setNewTaskPendingAttachments((prev) => {
      discardAttachmentIfManaged(prev.find((attachment) => attachment.id === id));
      return prev.filter((attachment) => attachment.id !== id);
    });
  };

  const preflightMember = async (targetMember: typeof members[number]) => {
    if (!cliClient.isAvailable()) {
      setPreflightMsg(t("errors.cliBridgeUnavailable"));
      return false;
    }
    try {
      const runtimeAdapter = targetMember.id.startsWith("cli-")
        ? targetMember.id.slice(4)
        : targetMember.cli.adapter;
      const r = await cliClient.check(
        targetMember.cli.adapter,
        targetMember.cli.binary,
        targetMember.cli.env,
        runtimeAdapter
      );
      await refreshRuntimes();
      if (!r.installed) {
        setPreflightMsg(
          t("errors.agentNotInstalled", { agent: targetMember.name ?? t("chat.agent") })
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
    if (attachmentBusy || newTaskSendInFlightRef.current || newTaskSendLock) return;
    const prompt = newTaskDraft.trim();
    const attachmentsToSend = newTaskPendingAttachments;

    if (teamMode) {
      if ((!prompt && attachmentsToSend.length === 0) || !selectedTeamId) return;
      const team = teams.find((tt) => tt.id === selectedTeamId);
      if (!team || !teamConversationMember(team, members)) return;
    } else {
      const selectedMember = members.find((m) => m.id === selectedMemberId);
      if (
        (!prompt && attachmentsToSend.length === 0) ||
        !selectedMember ||
        !availableAgentIds.has(selectedMember.id)
      ) {
        return;
      }
    }

    newTaskSendInFlightRef.current = true;
    setNewTaskSendLock(true);
    attachmentImportGenerationRef.current += 1;
    protectManagedAttachments(attachmentsToSend);
    setPreflightMsg(null);

    try {
      if (teamMode) {
        const team = teams.find((tt) => tt.id === selectedTeamId)!;
        const teamMember = teamConversationMember(team, members)!;
        if (!(await preflightMember(teamMember))) return;
        const cwd = newTaskCwd.trim() || undefined;
        const newConv = await createConversation({
          member: teamMember,
          cwd,
          title: buildConversationTitle({
            prompt,
            attachmentName: attachmentsToSend[0]?.name,
            fallback: team.name
          }),
          approvalMode: permissionMode,
          skillIds: newTaskSkillIds
        });
        const attached = await cliClient.attachConversationShares({
          targetConversationId: newConv.id,
          text: prompt
        });
        setContextReferences(attached.references);
        setNewTaskDraft("");
        setNewTaskPendingAttachments((prev) =>
          detachAttachmentsForSend(attachmentsToSend, prev)
        );
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
        const started = await createAndStartTeam({
          teamId: team.id,
          conversationId: newConv.id,
          goal: composeMessageWithAttachments(prompt, attachmentsToSend),
          cwd
        });
        if (!started) {
          const errors = useWorkflowStore.getState().pendingErrors;
          throw new Error(errors.length ? errors.join("; ") : "workflow did not start");
        }
        await loadWorkflowForConversation(newConv.id);
        return;
      }

      const selectedMember = members.find((m) => m.id === selectedMemberId);
      if (!selectedMember || !availableAgentIds.has(selectedMember.id)) return;
      if (!(await preflightMember(selectedMember))) return;

      const newConv = await createConversation({
        member: selectedMember,
        cwd: newTaskCwd.trim() || undefined,
        title: buildConversationTitle({
          prompt,
          attachmentName: attachmentsToSend[0]?.name,
          fallback: t("chat.defaultAttachmentTitle")
        }),
        approvalMode: permissionMode,
        configOptionOverrides: newTaskConfigOptionOverrides,
        skillIds: newTaskSkillIds
      });
      const attached = await cliClient.attachConversationShares({
        targetConversationId: newConv.id,
        text: prompt
      });
      setContextReferences(attached.references);
      setNewTaskDraft("");
      setNewTaskPendingAttachments((prev) =>
        detachAttachmentsForSend(attachmentsToSend, prev)
      );
      await sendMessage({
        conversationId: newConv.id,
        prompt,
        attachments: attachmentsToSend,
        approvalModeOverride: permissionMode
      });
    } catch (e) {
      setNewTaskDraft(prompt);
      setNewTaskPendingAttachments((prev) =>
        restoreAttachmentsForSend(attachmentsToSend, prev)
      );
      setPreflightMsg(
        t("errors.taskFailed", {
          err: e instanceof Error ? e.message : String(e)
        })
      );
    } finally {
      unprotectManagedAttachments(attachmentsToSend);
      newTaskSendInFlightRef.current = false;
      setNewTaskSendLock(false);
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
    if (attachmentBusy || sendInFlightRef.current || sendLock) return;
    const prompt = draft.trim();
    const attachmentsToSend = pendingAttachments;

    if (pendingWorkflowAction) {
      if (!conv || !prompt || sending) return;
    } else if (!conv || (!prompt && attachmentsToSend.length === 0) || sending) {
      return;
    }

    sendInFlightRef.current = true;
    setSendLock(true);
    attachmentImportGenerationRef.current += 1;
    protectManagedAttachments(attachmentsToSend);

    try {
      if (pendingWorkflowAction) {
        setPreflightMsg(null);
        isNearBottomRef.current = true;
        const userMessageId = nanoid();
        const now = new Date().toISOString();
        setDraft("");
        setPendingAttachments((prev) => detachAttachmentsForSend(attachmentsToSend, prev));
        try {
          const savedUser = await cliClient.appendMessage({
            id: userMessageId,
            conversationId: conv!.id,
            role: "user",
            status: "sent",
            content: prompt,
            attachments: attachmentsToSend
          });
          useConversationStore.setState((s) => ({
            messages: {
              ...s.messages,
              [conv!.id]: upsertConversationMessage(
                s.messages[conv!.id] ?? [],
                {
                  id: userMessageId,
                  conversationId: conv!.id,
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
          const ok = await requestGateChanges(
            pendingWorkflowAction.runId,
            pendingWorkflowAction.phaseId,
            composeMessageWithAttachments(prompt, attachmentsToSend)
          );
          if (ok) {
            setPendingWorkflowAction(null);
          } else {
            setPreflightMsg(t("workflow.requestChangesFailed"));
          }
        } catch (e) {
          setDraft(prompt);
          setPendingAttachments((prev) =>
            restoreAttachmentsForSend(attachmentsToSend, prev)
          );
          setPreflightMsg(
            t("errors.sendFailed", { err: e instanceof Error ? e.message : String(e) })
          );
        }
        return;
      }

      const targetMember = await resolveWorkflowFollowupMember();
      if (!conv || !targetMember || (!prompt && attachmentsToSend.length === 0) || sending) {
        return;
      }

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
      setPendingAttachments((prev) => detachAttachmentsForSend(attachmentsToSend, prev));

      if (!(await preflightMember(targetMember))) {
        setSubmitPreview(null);
        setDraft(prompt);
        setPendingAttachments((prev) =>
          restoreAttachmentsForSend(attachmentsToSend, prev)
        );
        return;
      }

      const attached = await cliClient.attachConversationShares({
        targetConversationId: conv.id,
        text: prompt
      });
      setContextReferences(attached.references);
      if (attached.attachedCount > 0) {
        notify(t("contextShare.linkAttached"));
      }

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
      setPendingAttachments((prev) =>
        restoreAttachmentsForSend(attachmentsToSend, prev)
      );
      setPreflightMsg(t("errors.sendFailed", { err: e instanceof Error ? e.message : String(e) }));
    } finally {
      unprotectManagedAttachments(attachmentsToSend);
      sendInFlightRef.current = false;
      setSendLock(false);
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
        title: buildConversationTitle({
          prompt: pendingTeamPreview.goal,
          fallback: pendingTeamPreview.teamName
        }),
        approvalMode: permissionMode
      });
      setNewTaskDraft("");
      setNewTaskPendingAttachments([]);
      const started = await createAndStartTeam({
        teamId: pendingTeamPreview.teamId,
        conversationId: newConv.id,
        goal: pendingTeamPreview.goal,
        cwd: pendingTeamPreview.cwd ?? cwd
      });
      if (!started) {
        const errors = useWorkflowStore.getState().pendingErrors;
        throw new Error(errors.length ? errors.join("; ") : "workflow did not start");
      }
      clearTeamPreview();
      await loadWorkflowForConversation(newConv.id);
    } catch (e) {
      setPreflightMsg(t("errors.taskFailed", { err: e instanceof Error ? e.message : String(e) }));
    }
  };

  if (!conv) {
    return (
      <NewTaskHome
        draft={newTaskDraft}
        agentAvailability={agentAvailability}
        checkingAgentIds={checkingAgentIds}
        selectedMemberId={selectedMemberId}
        cwd={newTaskCwd}
        permissionMode={permissionMode}
        pendingAttachments={newTaskPendingAttachments}
        taskMode={taskMode}
        teams={teams}
        selectedTeamId={selectedTeamId}
        configOptions={newTaskConfigOptions}
        configOptionOverrides={newTaskConfigOptionOverrides}
        configOptionsLoading={newTaskConfigLoading}
        skills={skills}
        selectedSkillIds={newTaskSkillIds}
        pluginAgent={pluginAgentForAdapter(
          members.find((entry) => entry.id === selectedMemberId)?.cli.adapter
        )}
        preflightMsg={preflightMsg}
        onDraft={setNewTaskDraft}
        onMember={(id) => {
          memberSelectionTouchedRef.current = true;
          setSelectedMemberId(id);
        }}
        onRefreshAgents={() =>
          void checkAgentEntries(agentEntriesNeedingRefresh(agentAvailability))
        }
        onManageAgents={() => onOpenAgentSettings?.()}
        onConfigOptionOverrides={setNewTaskConfigOptionOverrides}
        onSkills={setNewTaskSkillIds}
        onCwd={setNewTaskCwd}
        onPermissionMode={setPermissionMode}
        onSelectAttachments={() => void handleSelectAttachments("new")}
        onRemoveAttachment={handleRemoveNewTaskPendingAttachment}
        attachmentBusy={attachmentBusy}
        attachmentDropActive={newTaskAttachmentImport.dragActive}
        onAttachmentDragEnter={newTaskAttachmentImport.handleDragEnter}
        onAttachmentDragLeave={newTaskAttachmentImport.handleDragLeave}
        onAttachmentDragOver={newTaskAttachmentImport.handleDragOver}
        onAttachmentDrop={newTaskAttachmentImport.handleDrop}
        onAttachmentPaste={newTaskAttachmentImport.handlePaste}
        onTaskMode={(m) => {
          setTaskMode(m);
          clearTeamPreview();
        }}
        onTeam={(teamId) => {
          setSelectedTeamId(teamId);
          setRequestedTeamId(teamId);
        }}
        sendLocked={newTaskSendLock}
        onSubmit={() => void onCreateAndSend()}
      />
    );
  }



  return (
    <div className="chat-view">
      <CodeWhipOverlay />
      <div className={`chat-scroll${replaying ? " replay-active" : ""}`} ref={scrollRef} onScroll={handleScroll}>
        {messages.length === 0 && !conv?.sourceConversationId && (
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
        {conv?.sourceConversationId && (
          <HandoffConversationCard
            conversation={conv}
            contextAvailable={Boolean(conv.sourceBriefId)}
            sourceAvailable={Boolean(
              conv.sourceConversationId &&
              conversations.some((entry) => entry.id === conv.sourceConversationId)
            )}
            onOpenSource={() => {
              if (
                conv.sourceConversationId &&
                conversations.some((entry) => entry.id === conv.sourceConversationId)
              ) {
                void useConversationStore.getState().setActive(conv.sourceConversationId);
              } else {
                notify(t("handoff.sourceUnavailable"));
              }
            }}
          />
        )}
        {displayMessages.map((m) => {
          const partial =
            replayPartial && replayPartial.messageId === m.id
              ? replayPartial
              : undefined;
          const messageMember =
            (m.agentId ? membersById.get(m.agentId) : undefined) ??
            (m.agentName ? membersByName.get(m.agentName) : undefined);
          const shareReferences = shareReferencesByMessageId.get(m.id);
          return (
            <MessageBubble
              key={m.id}
              message={m}
              adapter={m.adapter ?? messageMember?.cli.adapter ?? conv?.adapter}
              agentName={m.agentName ?? messageMember?.name ?? conv?.agentName}
              agentIconKey={messageMember?.avatar}
              blockLimit={partial?.blockLimit}
              typingChars={partial?.typingChars}
              afterContent={
                shareReferences && shareReferences.length > 0 ? (
                  <SharedConversationReferences
                    references={shareReferences}
                    conversations={conversations}
                  />
                ) : undefined
              }
            />
          );
        })}
        {activeRun?.conversationId === conv.id &&
          workflowGateIsActionable &&
          gatingPhaseId &&
          gatingPhase &&
          !workflowGateApprovedLocally && (
          <WorkflowApprovalCard
            phaseTitle={gatingPhase.title}
            onApprove={() => {
              const runId = activeRun.id;
              const phaseId = gatingPhaseId;
              setApprovedWorkflowGate({ runId, phaseId });
              void approveGate(runId, phaseId)
                .then((ok) => {
                  if (!ok) setApprovedWorkflowGate(null);
                })
                .catch(() => setApprovedWorkflowGate(null));
            }}
            onRequestChanges={() => {
              setPendingWorkflowAction({
                runId: activeRun.id,
                phaseId: gatingPhaseId,
                type: "request_changes"
              });
              window.setTimeout(() => chatTextareaRef.current?.focus(), 0);
            }}
            onStop={() => void stopWorkflow(activeRun.id)}
          />
        )}
      </div>

      {preflightMsg && <div className="preflight-warn">{preflightMsg}</div>}

      <div
        className={`chat-composer${replaying ? " replay-disabled" : ""}${chatAttachmentImport.dragActive ? " attachment-drop-active" : ""}`}
        onDragEnter={chatAttachmentImport.handleDragEnter}
        onDragLeave={chatAttachmentImport.handleDragLeave}
        onDragOver={chatAttachmentImport.handleDragOver}
        onDrop={chatAttachmentImport.handleDrop}
      >
        {chatAttachmentImport.dragActive ? (
          <div className="attachment-drop-overlay" aria-hidden="true">
            {t("chat.dropAttachmentsHint")}
          </div>
        ) : null}
        <div className="composer-context-row">
          <span>{agentDisplayName}</span>
          <span>{conv.cwd ? conv.cwd : t("chat.noWorkspace")}</span>
        </div>
        <AttachmentTray
          attachments={pendingAttachments}
          onRemove={handleRemovePendingAttachment}
          removeDisabled={attachmentBusy || sendLock}
        />
        <div className="composer-input-wrap">
          {chatFileMentions.active ? (
            <WorkspaceFileMentionMenu
              matches={chatFileMentions.matches}
              selectedIndex={chatFileMentions.selectedIndex}
              loading={chatFileMentions.loading}
              onSelect={chatFileMentions.selectMatch}
            />
          ) : slashDraft && availableCommands.length > 0 ? (
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
            disabled={sending || replaying || attachmentBusy || sendLock}
            placeholder={
              pendingWorkflowAction
                ? t("workflow.requestChangesPlaceholder")
                : sending
                ? t("chat.agentRunning")
                : availableCommands.length > 0
                  ? t("chat.inputPlaceholderWithSlash")
                  : t("chat.inputPlaceholder")
            }
            onChange={chatFileMentions.handleChange}
            onClick={chatFileMentions.handleCaretChange}
            onKeyUp={chatFileMentions.handleCaretChange}
            onPaste={chatAttachmentImport.handlePaste}
            onKeyDown={(e) => {
              if (chatFileMentions.handleKeyDown(e)) return;
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
                if (!attachmentBusy && !sendLock) void onSend();
              }
            }}
          />
        </div>
        <div className="chat-composer-actions">
          <div className="composer-tools">
            <ComposerAddMenu
              skills={skills}
              selectedIds={conv?.skillSnapshot.map((skill) => skill.id) ?? []}
              pluginAgent={pluginAgentForAdapter(member?.cli.adapter ?? conv?.adapter)}
              attachmentDisabled={
                sending ||
                replaying ||
                attachmentBusy ||
                pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE
              }
              skillsDisabled={sending || replaying}
              pluginsDisabled={sending || replaying}
              onSelectAttachments={() => void handleSelectAttachments("chat")}
              onSelectPlugin={(plugin) =>
                insertPluginMention(draft, plugin, chatTextareaRef.current, setDraft)
              }
              onSkillsChange={(ids) => {
                if (conv?.id) void setConversationSkills(conv.id, ids);
              }}
            />
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
            <SessionConfigPicker
              className="composer-session-config"
              options={sessionConfigOptions}
              overrides={conv?.configOptionOverrides}
              disabled={sending || replaying}
              fallback={
                <span className="composer-hint">{t("chat.enterHint")}</span>
              }
              onChange={(next) => {
                if (conv?.id) void setConfigOptionOverrides(conv.id, next);
              }}
            />
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
                disabled={
                  sendLock ||
                  attachmentBusy ||
                  !(draft.trim() || pendingAttachments.length > 0)
                }
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
  agentAvailability,
  checkingAgentIds,
  selectedMemberId,
  cwd,
  permissionMode,
  pendingAttachments,
  taskMode,
  teams,
  selectedTeamId,
  configOptions,
  configOptionOverrides,
  configOptionsLoading,
  skills,
  selectedSkillIds,
  pluginAgent,
  preflightMsg,
  onDraft,
  onMember,
  onRefreshAgents,
  onManageAgents,
  onConfigOptionOverrides,
  onSkills,
  onCwd,
  onPermissionMode,
  onSelectAttachments,
  onRemoveAttachment,
  attachmentBusy,
  sendLocked,
  attachmentDropActive,
  onAttachmentDragEnter,
  onAttachmentDragLeave,
  onAttachmentDragOver,
  onAttachmentDrop,
  onAttachmentPaste,
  onTaskMode,
  onTeam,
  onSubmit
}: {
  draft: string;
  agentAvailability: AgentAvailabilityGroups;
  checkingAgentIds: Set<string>;
  selectedMemberId: string;
  cwd: string;
  permissionMode: "auto" | "ask";
  pendingAttachments: ChatAttachment[];
  taskMode: "normal" | "team";
  teams: WorkflowTeam[];
  selectedTeamId: string;
  configOptions: SessionConfigOption[];
  configOptionOverrides: Record<string, string>;
  configOptionsLoading: boolean;
  skills: ReturnType<typeof useSkillStore.getState>["skills"];
  selectedSkillIds: string[];
  pluginAgent?: NativePluginAgent;
  preflightMsg: string | null;
  onDraft: (value: string) => void;
  onMember: (value: string) => void;
  onRefreshAgents: () => void;
  onManageAgents: () => void;
  onConfigOptionOverrides: (value: Record<string, string>) => void;
  onSkills: (ids: string[]) => void;
  onCwd: (value: string) => void;
  onPermissionMode: (value: "auto" | "ask") => void;
  onSelectAttachments: () => void;
  onRemoveAttachment: (id: string) => void;
  attachmentBusy: boolean;
  sendLocked: boolean;
  attachmentDropActive: boolean;
  onAttachmentDragEnter: (event: DragEvent) => void;
  onAttachmentDragLeave: (event: DragEvent) => void;
  onAttachmentDragOver: (event: DragEvent) => void;
  onAttachmentDrop: (event: DragEvent) => void;
  onAttachmentPaste: (event: ClipboardEvent) => void;
  onTaskMode: (value: "normal" | "team") => void;
  onTeam: (id: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const teamMode = taskMode === "team";
  const fileMentions = useWorkspaceFileMentions({
    value: draft,
    cwd,
    onChange: onDraft,
    textareaRef
  });
  const workspaceParts = cwd.trim().split(/[\\/]/).filter(Boolean);
  const workspaceName = workspaceParts[workspaceParts.length - 1] || cwd.trim();
  const selectWorkspace = async () => {
    try {
      const path = await cliClient.selectDirectory();
      if (path) onCwd(path);
    } catch (e) {
      console.error("Error picking directory:", e);
    }
  };

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

        <section
          className={`new-task-composer${attachmentDropActive ? " attachment-drop-active" : ""}`}
          aria-label={t("chat.newTaskAria")}
          onDragEnter={onAttachmentDragEnter}
          onDragLeave={onAttachmentDragLeave}
          onDragOver={onAttachmentDragOver}
          onDrop={onAttachmentDrop}
        >
        {attachmentDropActive ? (
          <div className="attachment-drop-overlay" aria-hidden="true">
            {t("chat.dropAttachmentsHint")}
          </div>
        ) : null}
        <AttachmentTray
          attachments={pendingAttachments}
          onRemove={onRemoveAttachment}
          removeDisabled={attachmentBusy || sendLocked}
        />
        {fileMentions.active ? (
          <WorkspaceFileMentionMenu
            matches={fileMentions.matches}
            selectedIndex={fileMentions.selectedIndex}
            loading={fileMentions.loading}
            onSelect={fileMentions.selectMatch}
          />
        ) : null}
        <textarea
          ref={textareaRef}
          autoFocus
          rows={4}
          value={draft}
          disabled={attachmentBusy || sendLocked}
          placeholder={t("chat.inputPlaceholder")}
          onChange={fileMentions.handleChange}
          onClick={fileMentions.handleCaretChange}
          onKeyUp={fileMentions.handleCaretChange}
          onPaste={onAttachmentPaste}
          onKeyDown={(event) => {
            if (fileMentions.handleKeyDown(event)) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!attachmentBusy && !sendLocked) onSubmit();
            }
          }}
        />

        <div className="new-task-toolbar">
          <ComposerAddMenu
            skills={skills}
            selectedIds={selectedSkillIds}
            pluginAgent={pluginAgent}
            attachmentDisabled={
              attachmentBusy || pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE
            }
            skillsDisabled={sendLocked}
            pluginsDisabled={sendLocked}
            onSelectAttachments={onSelectAttachments}
            onSelectPlugin={(plugin) =>
              insertPluginMention(draft, plugin, textareaRef.current, onDraft)
            }
            onSkillsChange={onSkills}
          />
          {teamMode ? (
            <label className="new-task-team-picker" title={t("workflow.selectTeam")}>
              {teams.filter((tt) => tt.enabled).length === 0 ? (
                <select aria-label={t("workflow.selectTeam")} disabled value="">
                  <option value="">{t("workflow.noTeams")}</option>
                </select>
              ) : (
                <select
                  aria-label={t("workflow.selectTeam")}
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
            <AgentPicker
              groups={agentAvailability}
              selectedId={selectedMemberId}
              checkingIds={checkingAgentIds}
              disabled={sendLocked}
              onChange={onMember}
              onOpen={onRefreshAgents}
              onManage={onManageAgents}
            />
          )}
          <label
            className="composer-permission"
            title={t("chat.permissionHint")}
          >
            <span className="composer-permission-label">{t("chat.permission")}</span>
            <select
              className="composer-permission-select"
              value={permissionMode}
              onChange={(event) =>
                onPermissionMode(event.target.value as "auto" | "ask")
              }
            >
              <option value="auto">{t("chat.approvalAuto")}</option>
              <option value="ask">{t("chat.approvalAsk")}</option>
            </select>
          </label>
          {cwd ? (
            <div className="new-task-workspace-chip" title={cwd}>
              <button
                className="new-task-workspace-remove"
                type="button"
                title={t("chat.removeWorkspace")}
                aria-label={t("chat.removeWorkspace")}
                onClick={() => onCwd("")}
              >
                <X aria-hidden="true" />
              </button>
              <button
                className="new-task-workspace-name"
                type="button"
                title={t("chat.changeWorkspace")}
                onClick={selectWorkspace}
              >
                {workspaceName}
              </button>
            </div>
          ) : (
            <button
              className="composer-tool-chip"
              type="button"
              title={t("chat.selectCwd")}
              onClick={selectWorkspace}
            >
              <FolderIcon />
              <span>{t("chat.workspace")}</span>
            </button>
          )}

          <div className="new-task-toolbar-tail">
            {!teamMode ? (
              <SessionConfigPicker
                className="composer-session-config new-task-session-config"
                options={configOptions}
                overrides={configOptionOverrides}
                disabled={sendLocked || configOptionsLoading}
                fallback={
                  configOptionsLoading ? (
                    <span className="composer-hint">{t("chat.modelLoading")}</span>
                  ) : null
                }
                onChange={onConfigOptionOverrides}
              />
            ) : null}
            <button
              className="new-task-send send-icon-button"
              type="button"
              disabled={
                sendLocked ||
                attachmentBusy ||
                !(draft.trim() || pendingAttachments.length > 0) ||
                (teamMode
                  ? !selectedTeamId
                  : !agentAvailability.available.some(
                      (entry) => entry.member.id === selectedMemberId
                    ))
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
