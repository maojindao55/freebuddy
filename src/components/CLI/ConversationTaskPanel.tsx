import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Dropdown, Input, Modal } from "antd";
import {
  Archive, ArrowRight, CheckCircle2, Circle, CircleAlert, Clock3, Folder,
  FolderInput, Gamepad2, LayoutGrid, List, ListTodo, LoaderCircle, Maximize, MessageSquare,
  Minimize, MoreHorizontal, PauseCircle, Pencil, Pin, PinOff, Plus, RefreshCw,
  Search, Square, Trash2, X
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConversationOverview } from "@freebuddy/protocol";
import sidebarLogoUrl from "../../../assets/sidebar-logo.png";

import type { Conversation } from "@/services/cli/types";
import { useConversationStore, type LiveAssistant } from "@/store/conversationStore";
import { useConversationOverviewStore } from "@/store/conversationOverviewStore";
import {
  useConversationPanelUiStore,
  type ConversationBoardFilterUiState,
  type ConversationPanelFilter
} from "@/store/conversationPanelUiStore";
import { useProjectStore } from "@/store/projectStore";
import { usePermissionStore } from "@/store/permissionStore";
import { useAuthenticationStore } from "@/store/authenticationStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { sanitizeUserConversationTitle, USER_CONVERSATION_TITLE_MAX } from "@/store/conversationUtils";
import { AgentAvatar } from "./AgentAvatar";
import { useConversationVisibleTitle } from "./conversationTitle";
import { conversationDisplayCwd, groupConversationsByProject, groupConversationsByProjects } from "./conversationProjectGrouping";
import {
  ATTENTION_PANEL_STATUSES, RUNNING_PANEL_STATUSES, currentConversationPanelSnapshot, formatPanelActivity,
  formatPanelSummary, selectPanelActivities,
  livePanelActivity, panelRelativeTime, selectConversationPanelStatus,
  stableConversationOrder, type PanelStatus
} from "./conversationPanelData";
import "./ConversationTaskPanel.css";

export interface ConversationTaskPanelProps {
  fullscreen: boolean;
  onToggleFullscreen(): void;
  onList(): void;
  onOpenConversation(id: string): void;
  onNewConversation(): void;
  onOpenFile?(conversationId: string, messageId: string, path: string): void;
}

export type ConversationBoardMode = "all" | "todos";

export interface ConversationBoardProps {
  mode: ConversationBoardMode;
  ui: ConversationBoardFilterUiState;
  fullscreen: boolean;
  onToggleFullscreen(): void;
  onList?: () => void;
  onOpenAllConversations?: () => void;
  onOpenConversation(id: string): void;
  onNewConversation(): void;
  onOpenFile?(conversationId: string, messageId: string, path: string): void;
}

function StatusIcon({ status }: { status: PanelStatus }) {
  if (RUNNING_PANEL_STATUSES.has(status)) return <LoaderCircle className="ctp-spin" size={15} aria-hidden="true" />;
  if (status === "needs-input" || status === "failed") return <CircleAlert size={15} aria-hidden="true" />;
  if (status === "completed") return <CheckCircle2 size={15} aria-hidden="true" />;
  if (status === "waiting") return <Clock3 size={15} aria-hidden="true" />;
  if (status === "paused") return <PauseCircle size={15} aria-hidden="true" />;
  if (status === "stopped") return <Square size={13} aria-hidden="true" />;
  return <Circle size={14} aria-hidden="true" />;
}

const ConversationTaskCard = memo(function ConversationTaskCard({
  conversation, overview, status, loading, error, unread, unreadResult, project, owner,
  attentionReason, live, projectOptions, showTodoIndicator, showTodoQuickDone,
  onOpenConversation, onOpenFile, onRetry
}: {
  conversation: Conversation;
  overview?: ConversationOverview;
  status: PanelStatus;
  loading: boolean;
  error?: string;
  unread: boolean;
  unreadResult: boolean;
  project?: string;
  owner?: string;
  attentionReason?: string;
  live?: LiveAssistant;
  projectOptions: Array<{ id: string; name: string }>;
  showTodoIndicator: boolean;
  showTodoQuickDone: boolean;
  onOpenConversation(id: string): void;
  onOpenFile?: ConversationTaskPanelProps["onOpenFile"];
  onRetry(id: string): void;
}) {
  const { t, i18n } = useTranslation();
  const title = useConversationVisibleTitle(conversation);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [operationError, setOperationError] = useState<string>();
  const activeLive = live?.status === "starting" || live?.status === "running" ? live : undefined;
  const currentSnapshot = currentConversationPanelSnapshot(overview, activeLive);
  const liveContent = useMemo(() => activeLive ? livePanelActivity(activeLive.items, activeLive.messageId) : undefined, [activeLive]);
  const activities = liveContent?.activities.length ? liveContent.activities : currentSnapshot?.activities ?? [];
  const summary = liveContent?.summary || currentSnapshot?.summary;
  const model = liveContent?.model || currentSnapshot?.model;
  const updatedAt = overview?.updatedAt || conversation.lastMessageAt || conversation.updatedAt;
  const attention = status === "needs-input";
  const busy = RUNNING_PANEL_STATUSES.has(status) || status === "waiting" || status === "paused";
  const displayStatus = loading && !overview && status === "unknown" ? "loading" : status;
  const quietStatus = status === "completed" || status === "idle" || status === "stopped";
  const visibleActivities = selectPanelActivities(activities, 3);
  const displaySummary = formatPanelSummary(summary ?? "", t);
  const summaryFirst = quietStatus && Boolean(displaySummary);
  const failureReason = status === "failed" ? overview?.error : undefined;
  const unreadLabel = t(unreadResult ? "conversationPanel.newResult" : "conversationPanel.filter.unread");
  const state = useConversationStore.getState();

  async function operate(operation: () => Promise<unknown>) {
    setOperationError(undefined);
    try { await operation(); }
    catch (cause) { setOperationError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return (
    <article className={`ctp-card${unread ? " is-unread" : ""}`} aria-label={title}>
      <div className="ctp-card-heading">
        <button type="button" className="ctp-card-title" title={title} onClick={() => onOpenConversation(conversation.id)}>{title}</button>
        {conversation.pinned && <Pin className="ctp-pinned-indicator" size={13} aria-label={t("conversations.pinned")} aria-hidden="true" />}
        {showTodoIndicator && conversation.todo && (
          <span className="ctp-todo-indicator" title={t("conversations.todoBadge")} aria-label={t("conversations.todoBadge")}>
            <ListTodo size={13} aria-hidden="true" />
          </span>
        )}
        <span className={`ctp-status status-${displayStatus}${quietStatus ? " is-quiet" : ""}`} role="status">{!quietStatus && <StatusIcon status={displayStatus === "loading" ? "starting" : status} />}{t(`conversationPanel.status.${displayStatus}`)}</span>
        {unread && <span className="ctp-unread" role="status" title={unreadLabel} aria-label={unreadLabel}><Circle size={6} fill="currentColor" aria-hidden="true" /></span>}
        <Dropdown
          open={menuOpen}
          onOpenChange={setMenuOpen}
          trigger={["click"]}
          menu={{
            items: [
              { key: "rename", icon: <Pencil size={14} />, label: t("conversations.renameTitle") },
              {
                key: "todo",
                icon: conversation.todo ? <CheckCircle2 size={14} /> : <ListTodo size={14} />,
                label: conversation.todo ? t("conversations.unmarkTodo") : t("conversations.markTodo")
              },
              {
                key: "pin",
                icon: conversation.pinned ? <PinOff size={14} /> : <Pin size={14} />,
                label: conversation.pinned ? t("conversations.unpinConversation") : t("conversations.pinConversation")
              },
              { key: "archive", icon: <Archive size={14} />, label: t("conversationPanel.archive"), disabled: busy || attention },
              {
                key: "move",
                icon: <FolderInput size={14} />,
                label: t("conversations.moveToProject"),
                children: [
                  ...projectOptions.map((option) => ({
                    key: `move:${option.id}`,
                    label: option.name,
                    disabled: option.id === conversation.projectId
                  })),
                  {
                    key: "move:null",
                    label: t("conversations.removeFromProject"),
                    disabled: !conversation.projectId
                  }
                ]
              },
              { type: "divider" },
              { key: "delete", icon: <Trash2 size={14} />, label: t("common.delete"), danger: true, disabled: busy || attention }
            ],
            onClick: ({ key }) => {
              setMenuOpen(false);
              if (key === "rename") { setDraft(title); setOperationError(undefined); setRenaming(true); }
              else if (key === "todo") void operate(() => state.setConversationTodo(conversation.id, !conversation.todo));
              else if (key === "archive") void operate(() => state.archiveConversation(conversation.id, true));
              else if (key === "pin") void operate(() => state.setConversationPinned(conversation.id, !conversation.pinned));
              else if (key === "delete" && window.confirm(t("conversations.deleteConfirm", { title }))) void operate(() => state.deleteConversation(conversation.id));
              else if (typeof key === "string" && key.startsWith("move:")) {
                const target = key.slice("move:".length);
                void operate(() => state.moveConversationToProject(conversation.id, target === "null" ? null : target));
              }
            }
          }}
        >
          <button type="button" className="ctp-icon-button" aria-label={t("conversationPanel.moreActions", { title })} title={t("conversationPanel.moreActions", { title })} onKeyDown={(event) => { if (event.key === "Escape" && menuOpen) { event.preventDefault(); event.stopPropagation(); setMenuOpen(false); } }}><MoreHorizontal size={20} aria-hidden="true" /></button>
        </Dropdown>
      </div>
      <div className="ctp-identity">
        {conversation.kind === "game" ? <span className="ctp-avatar"><Gamepad2 size={20} /></span> : <AgentAvatar adapter={conversation.adapter} agentId={conversation.agentId} className="ctp-avatar" fallback={<MessageSquare size={20} />} />}
        <span className="ctp-agent" title={conversation.agentName}>{conversation.agentName}</span>
        {model && <span className="ctp-model" title={model}>{model}</span>}
        {project && <span className="ctp-project" title={conversationDisplayCwd(conversation) || project}><Folder size={15} aria-hidden="true" /><span>{project}</span></span>}
        {owner && <span className="ctp-owner" title={`@${owner}`}>@{owner}</span>}
      </div>
      <div className="ctp-card-content">
        {failureReason ? (
          <p className="ctp-error" title={failureReason}>{failureReason}</p>
        ) : summaryFirst ? (
          <p className="ctp-summary">{displaySummary}</p>
        ) : visibleActivities.length > 0 ? (
          <ul className="ctp-activities">
            {visibleActivities.map((activity) => {
              const activityIcon = activity.status === "running" || activity.status === "pending" ? <LoaderCircle className={activity.status === "running" ? "ctp-spin" : undefined} size={16} /> : activity.status === "failed" ? <CircleAlert size={16} /> : <Circle size={5} fill="currentColor" />;
              const activityLabel = formatPanelActivity(activity, t, conversation.cwd);
              return <li key={`${activity.messageId}:${activity.id}`} className={`activity-${activity.status}`}><span aria-hidden="true">{activityIcon}</span><button type="button" title={activity.filePath || activityLabel} onClick={() => activity.filePath && onOpenFile ? onOpenFile(conversation.id, activity.messageId, activity.filePath) : onOpenConversation(conversation.id)}>{activityLabel}</button></li>;
            })}
          </ul>
        ) : (loading && !overview) || (activeLive && !currentSnapshot) ? (
          <div className="ctp-placeholder"><LoaderCircle className="ctp-spin" size={15} aria-hidden="true" /><span>{t("conversationPanel.loadingActivities")}</span></div>
        ) : displaySummary ? (
          <p className="ctp-summary">{displaySummary}</p>
        ) : (
          <p className="ctp-placeholder">{t(status === "unknown" ? "conversationPanel.noSnapshot" : "conversationPanel.noActivities")}</p>
        )}
        {attention && <div className="ctp-attention"><CircleAlert size={17} aria-hidden="true" /><span>{attentionReason || t("conversationPanel.needsConfirmation")}</span><button type="button" onClick={() => onOpenConversation(conversation.id)}>{t("conversationPanel.viewRequest")}</button></div>}
        {error && <div className="ctp-fetch-error" title={error}><CircleAlert size={15} aria-hidden="true" /><span>{t(overview ? "conversationPanel.refreshFailed" : "conversationPanel.loadFailed")}</span><button type="button" disabled={loading} onClick={() => onRetry(conversation.id)}>{t("conversationPanel.retry")}</button></div>}
        {operationError && !renaming && <p className="ctp-error" role="alert">{operationError}</p>}
      </div>
      <footer className="ctp-card-footer">
        <time dateTime={updatedAt} title={new Date(updatedAt).toLocaleString(i18n.language)}>{t("conversationPanel.updated", { time: panelRelativeTime(updatedAt, i18n.language) })}</time>
        <div className="ctp-card-footer-actions">
          {showTodoQuickDone && (
            <button
              type="button"
              className="ctp-todo-done-button"
              title={t("conversations.unmarkTodo")}
              onClick={() => void operate(() => state.setConversationTodo(conversation.id, false))}
            >
              <CheckCircle2 size={14} aria-hidden="true" />
              <span>{t("todoPanel.markDone")}</span>
            </button>
          )}
          <button type="button" className="ctp-open-button" onClick={() => onOpenConversation(conversation.id)}>{t("conversationPanel.viewConversation")}<ArrowRight size={16} aria-hidden="true" /></button>
        </div>
      </footer>
      <Modal open={renaming} title={t("conversations.renameTitle")} onCancel={() => setRenaming(false)} confirmLoading={saving} okText={t("common.save")} cancelText={t("common.cancel")} okButtonProps={{ disabled: !sanitizeUserConversationTitle(draft) }} onOk={async () => {
        setSaving(true);
        try { await state.renameConversation(conversation.id, draft); setRenaming(false); }
        catch (cause) { setOperationError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setSaving(false); }
      }} destroyOnHidden>
        <Input autoFocus value={draft} maxLength={USER_CONVERSATION_TITLE_MAX} aria-label={t("conversations.renameTitle")} onChange={(event) => setDraft(event.target.value)} />
        {operationError && <p className="ctp-error" role="alert">{operationError}</p>}
      </Modal>
    </article>
  );
});

export function ConversationBoard({
  mode, ui, fullscreen, onToggleFullscreen, onList, onOpenAllConversations,
  onOpenConversation, onNewConversation, onOpenFile
}: ConversationBoardProps) {
  const { t } = useTranslation();
  const conversations = useConversationStore((state) => state.conversations);
  const live = useConversationStore((state) => state.live);
  const unread = useConversationStore((state) => state.unreadConversations);
  const currentUser = useConversationStore((state) => state.currentUser);
  const projects = useProjectStore((state) => state.projects);
  const projectsLoaded = useProjectStore((state) => state.loaded);
  const overviews = useConversationOverviewStore((state) => state.overviews);
  const loading = useConversationOverviewStore((state) => state.loading);
  const errors = useConversationOverviewStore((state) => state.errors);
  const refresh = useConversationOverviewStore((state) => state.refresh);
  const permissionQueue = usePermissionStore((state) => state.queue);
  const authQueue = useAuthenticationStore((state) => state.queue);
  const authTerminalQueue = useAuthenticationStore((state) => state.terminalQueue);
  const activeRuns = useWorkflowStore((state) => state.activeRuns);
  const scroller = useRef<HTMLDivElement>(null);
  const order = useRef<string[]>(ui.orderedIds);
  const scrollRef = useRef(ui.scrollOffset);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const isTodos = mode === "todos";
  const panelTitle = t(isTodos ? "todoPanel.title" : "conversationPanel.title");
  const searchPlaceholder = t(isTodos ? "todoPanel.searchPlaceholder" : "conversations.searchPlaceholder");

  const items = useMemo(
    () =>
      conversations.filter((conversation) =>
        isTodos
          ? !conversation.archived && Boolean(conversation.todo)
          : !conversation.archived
      ),
    [conversations, isTodos]
  );
  const projectGroups = useMemo(() => {
    const known = groupConversationsByProjects(items, projects).filter((group) => group.items.length > 0);
    const knownIds = new Set(known.flatMap((group) => group.items.map((conversation) => conversation.id)));
    return [...known, ...groupConversationsByProject(items.filter((conversation) => !knownIds.has(conversation.id)))];
  }, [items, projects]);
  const hasSelectedProject =
    !ui.projectKey ||
    ui.projectKey === "__none__" ||
    projectGroups.some((group) => group.key === ui.projectKey);
  const effectiveProjectKey = hasSelectedProject ? ui.projectKey : "";
  const filterKey = `${ui.query}\n${ui.filter}\n${effectiveProjectKey}`;
  const filterKeyRef = useRef(filterKey);
  useEffect(() => {
    if (projectsLoaded && !hasSelectedProject) {
      uiRef.current.setProjectKey("");
    }
  }, [projectsLoaded, hasSelectedProject]);
  const projectByConversation = useMemo(() => new Map(projectGroups.flatMap((group) => group.items.map((conversation) => [conversation.id, group] as const))), [projectGroups]);
  const attentionReasons = useMemo(() => {
    const reasons = new Map<string, string[]>();
    const add = (id: string, reason: string) => reasons.set(id, [...reasons.get(id) ?? [], reason]);
    permissionQueue.forEach((request) => add(request.conversationId, request.toolCall?.title || t("conversationPanel.permissionRequired")));
    authQueue.forEach((request) => add(request.conversationId, t("conversationPanel.authenticationRequired")));
    authTerminalQueue.forEach((request) => add(request.conversationId, t("conversationPanel.authenticationRequired")));
    return reasons;
  }, [permissionQueue, authQueue, authTerminalQueue, t]);
  const statuses = useMemo(() => Object.fromEntries(items.map((conversation) => [conversation.id, selectConversationPanelStatus(overviews[conversation.id], {
    attentionCount: attentionReasons.get(conversation.id)?.length,
    live: live[conversation.id],
    workflowStatus: activeRuns.find((run) => run.conversationId === conversation.id)?.status
  })])), [items, overviews, attentionReasons, live, activeRuns]);
  order.current = stableConversationOrder(
    order.current,
    items,
    isTodos
      ? (conversation) => conversation.todoAt ?? conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt
      : undefined
  );
  const byId = new Map(items.map((conversation) => [conversation.id, conversation]));
  const matching = order.current.map((id) => byId.get(id)!).filter((conversation) => {
    if (effectiveProjectKey && (projectByConversation.get(conversation.id)?.key ?? "__none__") !== effectiveProjectKey) return false;
    const query = ui.query.trim().toLocaleLowerCase();
    return !query || `${conversation.title} ${conversation.agentName} ${projectByConversation.get(conversation.id)?.label ?? ""} ${conversation.ownerUsername ?? ""}`.toLocaleLowerCase().includes(query);
  });
  const projectMenuOptions = useMemo(
    () => projects.map((project) => ({ id: project.id, name: project.name })),
    [projects]
  );
  const counts = {
    all: matching.length,
    running: matching.filter((conversation) => RUNNING_PANEL_STATUSES.has(statuses[conversation.id])).length,
    attention: matching.filter((conversation) => ATTENTION_PANEL_STATUSES.has(statuses[conversation.id])).length,
    unread: matching.filter((conversation) => Boolean(unread[conversation.id])).length
  };
  const filtered = matching.filter((conversation) => ui.filter === "all" || (ui.filter === "unread" ? Boolean(unread[conversation.id]) : ui.filter === "running" ? RUNNING_PANEL_STATUSES.has(statuses[conversation.id]) : ATTENTION_PANEL_STATUSES.has(statuses[conversation.id])));
  const visible = filtered.slice(0, ui.visibleCount);
  const unavailableCount = matching.filter((conversation) => Boolean(errors[conversation.id])).length;
  const unresolvedLoading = matching.some((conversation) => loading[conversation.id] && !overviews[conversation.id]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scrollRef.current;
    return () => {
      uiRef.current.setScrollOffset(scrollRef.current);
      uiRef.current.setOrderedIds(order.current);
    };
  }, []);
  useEffect(() => {
    if (filterKeyRef.current === filterKey) return;
    filterKeyRef.current = filterKey;
    scrollRef.current = 0;
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [filterKey]);
  useEffect(() => {
    scrollRef.current = ui.scrollOffset;
    if (scroller.current && scroller.current.scrollTop !== ui.scrollOffset) scroller.current.scrollTop = ui.scrollOffset;
  }, [ui.scrollOffset]);

  return (
    <section className={`conversation-task-panel${fullscreen ? " is-fullscreen" : ""}`} aria-label={panelTitle}>
      <header className="ctp-toolbar">
        <div className="ctp-toolbar-title">
          {fullscreen ? (
            <>
              <div className="ctp-brand"><img src={sidebarLogoUrl} alt="" /><strong>FreeBuddy</strong>{import.meta.env.DEV && <span className="sidebar-dev-badge">DEV</span>}</div>
              <span className="ctp-brand-divider" />
            </>
          ) : isTodos ? (
            <ListTodo size={23} aria-hidden="true" />
          ) : (
            <LayoutGrid size={23} aria-hidden="true" />
          )}
          <h1>{panelTitle}</h1>
          {!fullscreen && <span className="ctp-total">{items.length}</span>}
        </div>
        <div className="ctp-toolbar-actions">
          {!isTodos && onList && (
            <div className="ctp-view-switch" aria-label={t("conversationPanel.viewLabel")}>
              <button type="button" onClick={onList}><List size={16} aria-hidden="true" />{t("conversationPanel.list")}</button>
              <button type="button" className="is-selected" aria-pressed="true"><LayoutGrid size={16} aria-hidden="true" />{t("conversationPanel.panel")}</button>
            </div>
          )}
          {isTodos && onOpenAllConversations && (
            <button type="button" className="ctp-secondary-button" onClick={onOpenAllConversations}>
              <LayoutGrid size={16} aria-hidden="true" />
              <span>{t("todoPanel.allConversations")}</span>
            </button>
          )}
          {!isTodos && (
            <button type="button" className="ctp-new-button" onClick={onNewConversation}><Plus size={18} aria-hidden="true" /><span>{t("conversationPanel.newConversation")}</span></button>
          )}
          <button type="button" className="ctp-fullscreen-button" onClick={onToggleFullscreen} title={t(fullscreen ? "conversationPanel.exitFullscreen" : "conversationPanel.fullscreen")} aria-label={t(fullscreen ? "conversationPanel.exitFullscreen" : "conversationPanel.fullscreen")}>{fullscreen ? <Minimize size={19} aria-hidden="true" /> : <Maximize size={19} aria-hidden="true" />}<span>{t(fullscreen ? "conversationPanel.exitFullscreen" : "conversationPanel.fullscreen")}</span></button>
        </div>
      </header>
      <div className="ctp-controls">
        <label className="ctp-project-select"><Folder size={17} aria-hidden="true" /><select value={effectiveProjectKey} onChange={(event) => ui.setProjectKey(event.target.value)} aria-label={t("conversationPanel.projectFilter")}><option value="">{t("conversationPanel.allProjects")}</option>{projectGroups.map((group) => <option key={group.key} value={group.key}>{group.label}</option>)}<option value="__none__">{t("conversationPanel.noProject")}</option></select></label>
        <div className="ctp-search"><Search size={18} aria-hidden="true" /><input type="search" value={ui.query} onChange={(event) => ui.setQuery(event.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />{ui.query && <button type="button" className="ctp-icon-button" onClick={() => ui.setQuery("")} aria-label={t("conversations.clearSearchAria")}><X size={15} /></button>}</div>
        <div className="ctp-filters" aria-label={t("conversations.filterLabel")}>{(["all", "running", "attention", "unread"] as ConversationPanelFilter[]).map((filter) => <button type="button" key={filter} aria-pressed={filter === ui.filter} className={filter === ui.filter ? "is-selected" : ""} onClick={() => ui.setFilter(filter)}>{t(`conversationPanel.filter.${filter}`)}<span>{counts[filter]}</span></button>)}</div>
        <button type="button" className="ctp-icon-button ctp-refresh" onClick={() => void refresh(items.map((conversation) => conversation.id))} disabled={Object.keys(loading).length > 0} aria-label={t("conversationPanel.refresh")} title={t("conversationPanel.refresh")}><RefreshCw size={17} aria-hidden="true" /></button>
      </div>
      <div className="ctp-scroller" ref={scroller} onScroll={(event) => { scrollRef.current = event.currentTarget.scrollTop; }}>
        {unavailableCount > 0 && <div className="ctp-load-warning" role="status"><CircleAlert size={16} aria-hidden="true" /><span>{t("conversationPanel.unavailableCount", { count: unavailableCount })}</span><button type="button" disabled={Object.keys(loading).length > 0} onClick={() => void refresh(matching.filter((conversation) => errors[conversation.id]).map((conversation) => conversation.id))}>{t("conversationPanel.retry")}</button></div>}
        <div className="ctp-grid">
          {visible.map((conversation) => (
            <ConversationTaskCard
              key={conversation.id}
              conversation={conversation}
              overview={overviews[conversation.id]}
              status={statuses[conversation.id]}
              loading={Boolean(loading[conversation.id])}
              error={errors[conversation.id]}
              unread={Boolean(unread[conversation.id])}
              unreadResult={unread[conversation.id]?.kind === "success" || unread[conversation.id]?.kind === "failure"}
              project={projectByConversation.get(conversation.id)?.label}
              owner={currentUser?.isOwner && conversation.ownerUsername && conversation.ownerUsername !== currentUser.username ? conversation.ownerUsername : undefined}
              attentionReason={attentionReasons.get(conversation.id)?.[0]}
              live={live[conversation.id]}
              projectOptions={projectMenuOptions}
              showTodoIndicator={!isTodos}
              showTodoQuickDone={isTodos}
              onOpenConversation={onOpenConversation}
              onOpenFile={onOpenFile}
              onRetry={(id) => void refresh([id])}
            />
          ))}
        </div>
        {!visible.length && (
          <div className="ctp-empty">
            {unresolvedLoading ? (
              <LoaderCircle size={30} className="ctp-spin" aria-hidden="true" />
            ) : isTodos && !items.length ? (
              <ListTodo size={38} strokeWidth={1.2} aria-hidden="true" />
            ) : (
              <MessageSquare size={38} strokeWidth={1.2} aria-hidden="true" />
            )}
            <h2>
              {t(
                unresolvedLoading
                  ? "conversationPanel.loadingActivities"
                  : items.length
                    ? "conversations.noResults"
                    : isTodos
                      ? "todoPanel.emptyTitle"
                      : "conversations.empty"
              )}
            </h2>
            {!unresolvedLoading && isTodos && !items.length && (
              <p className="ctp-empty-hint">{t("todoPanel.emptyHint")}</p>
            )}
            {!unresolvedLoading && (
              items.length ? (
                <button type="button" onClick={() => { ui.setQuery(""); ui.setProjectKey(""); ui.setFilter("all"); }}>
                  {t("conversationPanel.clearFilters")}
                </button>
              ) : isTodos && onOpenAllConversations ? (
                <button type="button" onClick={onOpenAllConversations}>
                  {t("todoPanel.browseConversations")}
                </button>
              ) : (
                <button type="button" onClick={onNewConversation}>
                  {t("conversationPanel.newConversation")}
                </button>
              )
            )}
          </div>
        )}
        {filtered.length > visible.length && <div className="ctp-load-more"><span>{t("conversationPanel.showing", { count: visible.length, total: filtered.length })}</span><button type="button" onClick={ui.showMore}>{t("conversationPanel.loadMore")}</button></div>}
      </div>
    </section>
  );
}

export function ConversationTaskPanel({ fullscreen, onToggleFullscreen, onList, onOpenConversation, onNewConversation, onOpenFile }: ConversationTaskPanelProps) {
  const ui = useConversationPanelUiStore();
  return (
    <ConversationBoard
      mode="all"
      ui={ui}
      fullscreen={fullscreen}
      onToggleFullscreen={onToggleFullscreen}
      onList={onList}
      onOpenConversation={onOpenConversation}
      onNewConversation={onNewConversation}
      onOpenFile={onOpenFile}
    />
  );
}
