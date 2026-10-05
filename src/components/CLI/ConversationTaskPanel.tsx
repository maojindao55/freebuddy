import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Dropdown, Input, Modal } from "antd";
import {
  Archive, ArrowRight, CheckCircle2, Circle, CircleAlert, Clock3, Folder,
  Gamepad2, LayoutGrid, List, LoaderCircle, Maximize, MessageSquare,
  Minimize, MoreHorizontal, PauseCircle, Pencil, Plus, RefreshCw, Search,
  Square, Trash2, X
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConversationOverview } from "@freebuddy/protocol";
import sidebarLogoUrl from "../../../assets/sidebar-logo.png";

import type { Conversation } from "@/services/cli/types";
import { useConversationStore, type LiveAssistant } from "@/store/conversationStore";
import { useConversationOverviewStore } from "@/store/conversationOverviewStore";
import { useConversationPanelUiStore, type ConversationPanelFilter } from "@/store/conversationPanelUiStore";
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
  attentionReason, live, onOpenConversation, onOpenFile, onRetry
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

  async function operate(operation: () => Promise<void>) {
    setOperationError(undefined);
    try { await operation(); }
    catch (cause) { setOperationError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return (
    <article className={`ctp-card${unread ? " is-unread" : ""}`} aria-label={title}>
      <div className="ctp-card-heading">
        <button type="button" className="ctp-card-title" title={title} onClick={() => onOpenConversation(conversation.id)}>{title}</button>
        <span className={`ctp-status status-${displayStatus}${quietStatus ? " is-quiet" : ""}`} role="status">{!quietStatus && <StatusIcon status={displayStatus === "loading" ? "starting" : status} />}{t(`conversationPanel.status.${displayStatus}`)}</span>
        {unread && <span className="ctp-unread" role="status" title={unreadLabel} aria-label={unreadLabel}><Circle size={6} fill="currentColor" aria-hidden="true" /></span>}
        <Dropdown
          open={menuOpen}
          onOpenChange={setMenuOpen}
          trigger={["click"]}
          menu={{
            items: [
              { key: "rename", icon: <Pencil size={14} />, label: t("conversations.renameTitle") },
              { key: "archive", icon: <Archive size={14} />, label: t("conversationPanel.archive"), disabled: busy || attention },
              { type: "divider" },
              { key: "delete", icon: <Trash2 size={14} />, label: t("common.delete"), danger: true, disabled: busy || attention }
            ],
            onClick: ({ key }) => {
              setMenuOpen(false);
              if (key === "rename") { setDraft(title); setOperationError(undefined); setRenaming(true); }
              else if (key === "archive") void operate(() => state.archiveConversation(conversation.id, true));
              else if (key === "delete" && window.confirm(t("conversations.deleteConfirm", { title }))) void operate(() => state.deleteConversation(conversation.id));
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
        <button type="button" className="ctp-open-button" onClick={() => onOpenConversation(conversation.id)}>{t("conversationPanel.viewConversation")}<ArrowRight size={16} aria-hidden="true" /></button>
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

export function ConversationTaskPanel({ fullscreen, onToggleFullscreen, onList, onOpenConversation, onNewConversation, onOpenFile }: ConversationTaskPanelProps) {
  const { t } = useTranslation();
  const conversations = useConversationStore((state) => state.conversations);
  const live = useConversationStore((state) => state.live);
  const unread = useConversationStore((state) => state.unreadConversations);
  const currentUser = useConversationStore((state) => state.currentUser);
  const projects = useProjectStore((state) => state.projects);
  const overviews = useConversationOverviewStore((state) => state.overviews);
  const loading = useConversationOverviewStore((state) => state.loading);
  const errors = useConversationOverviewStore((state) => state.errors);
  const refresh = useConversationOverviewStore((state) => state.refresh);
  const permissionQueue = usePermissionStore((state) => state.queue);
  const authQueue = useAuthenticationStore((state) => state.queue);
  const authTerminalQueue = useAuthenticationStore((state) => state.terminalQueue);
  const activeRuns = useWorkflowStore((state) => state.activeRuns);
  const ui = useConversationPanelUiStore();
  const scroller = useRef<HTMLDivElement>(null);
  const order = useRef<string[]>(ui.orderedIds);
  const scrollRef = useRef(ui.scrollOffset);
  const filterKey = `${ui.query}\n${ui.filter}\n${ui.projectKey}`;
  const filterKeyRef = useRef(filterKey);
  const items = useMemo(() => conversations.filter((conversation) => !conversation.archived), [conversations]);
  const projectGroups = useMemo(() => {
    const known = groupConversationsByProjects(items, projects).filter((group) => group.items.length > 0);
    const knownIds = new Set(known.flatMap((group) => group.items.map((conversation) => conversation.id)));
    return [...known, ...groupConversationsByProject(items.filter((conversation) => !knownIds.has(conversation.id)))];
  }, [items, projects]);
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
  order.current = stableConversationOrder(order.current, items);
  const byId = new Map(items.map((conversation) => [conversation.id, conversation]));
  const matching = order.current.map((id) => byId.get(id)!).filter((conversation) => {
    if (ui.projectKey && (projectByConversation.get(conversation.id)?.key ?? "__none__") !== ui.projectKey) return false;
    const query = ui.query.trim().toLocaleLowerCase();
    return !query || `${conversation.title} ${conversation.agentName} ${projectByConversation.get(conversation.id)?.label ?? ""} ${conversation.ownerUsername ?? ""}`.toLocaleLowerCase().includes(query);
  });
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
      const state = useConversationPanelUiStore.getState();
      state.setScrollOffset(scrollRef.current);
      state.setOrderedIds(order.current);
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
    <section className={`conversation-task-panel${fullscreen ? " is-fullscreen" : ""}`} aria-label={t("conversationPanel.title")}>
      <header className="ctp-toolbar">
        <div className="ctp-toolbar-title">{fullscreen ? <><div className="ctp-brand"><img src={sidebarLogoUrl} alt="" /><strong>FreeBuddy</strong>{import.meta.env.DEV && <span className="sidebar-dev-badge">DEV</span>}</div><span className="ctp-brand-divider" /></> : <LayoutGrid size={23} aria-hidden="true" />}<h1>{t("conversationPanel.title")}</h1>{!fullscreen && <span className="ctp-total">{items.length}</span>}</div>
        <div className="ctp-toolbar-actions">
          <div className="ctp-view-switch" aria-label={t("conversationPanel.viewLabel")}>
            <button type="button" onClick={onList}><List size={16} aria-hidden="true" />{t("conversationPanel.list")}</button>
            <button type="button" className="is-selected" aria-pressed="true"><LayoutGrid size={16} aria-hidden="true" />{t("conversationPanel.panel")}</button>
          </div>
          <button type="button" className="ctp-new-button" onClick={onNewConversation}><Plus size={18} aria-hidden="true" /><span>{t("conversationPanel.newConversation")}</span></button>
          <button type="button" className="ctp-fullscreen-button" onClick={onToggleFullscreen} title={t(fullscreen ? "conversationPanel.exitFullscreen" : "conversationPanel.fullscreen")} aria-label={t(fullscreen ? "conversationPanel.exitFullscreen" : "conversationPanel.fullscreen")}>{fullscreen ? <Minimize size={19} aria-hidden="true" /> : <Maximize size={19} aria-hidden="true" />}<span>{t(fullscreen ? "conversationPanel.exitFullscreen" : "conversationPanel.fullscreen")}</span></button>
        </div>
      </header>
      <div className="ctp-controls">
        <label className="ctp-project-select"><Folder size={17} aria-hidden="true" /><select value={ui.projectKey} onChange={(event) => ui.setProjectKey(event.target.value)} aria-label={t("conversationPanel.projectFilter")}><option value="">{t("conversationPanel.allProjects")}</option>{projectGroups.map((group) => <option key={group.key} value={group.key}>{group.label}</option>)}<option value="__none__">{t("conversationPanel.noProject")}</option></select></label>
        <div className="ctp-search"><Search size={18} aria-hidden="true" /><input type="search" value={ui.query} onChange={(event) => ui.setQuery(event.target.value)} placeholder={t("conversations.searchPlaceholder")} aria-label={t("conversations.searchPlaceholder")} />{ui.query && <button type="button" className="ctp-icon-button" onClick={() => ui.setQuery("")} aria-label={t("conversations.clearSearchAria")}><X size={15} /></button>}</div>
        <div className="ctp-filters" aria-label={t("conversations.filterLabel")}>{(["all", "running", "attention", "unread"] as ConversationPanelFilter[]).map((filter) => <button type="button" key={filter} aria-pressed={filter === ui.filter} className={filter === ui.filter ? "is-selected" : ""} onClick={() => ui.setFilter(filter)}>{t(`conversationPanel.filter.${filter}`)}<span>{counts[filter]}</span></button>)}</div>
        <button type="button" className="ctp-icon-button ctp-refresh" onClick={() => void refresh(items.map((conversation) => conversation.id))} disabled={Object.keys(loading).length > 0} aria-label={t("conversationPanel.refresh")} title={t("conversationPanel.refresh")}><RefreshCw size={17} aria-hidden="true" /></button>
      </div>
      <div className="ctp-scroller" ref={scroller} onScroll={(event) => { scrollRef.current = event.currentTarget.scrollTop; }}>
        {unavailableCount > 0 && <div className="ctp-load-warning" role="status"><CircleAlert size={16} aria-hidden="true" /><span>{t("conversationPanel.unavailableCount", { count: unavailableCount })}</span><button type="button" disabled={Object.keys(loading).length > 0} onClick={() => void refresh(matching.filter((conversation) => errors[conversation.id]).map((conversation) => conversation.id))}>{t("conversationPanel.retry")}</button></div>}
        <div className="ctp-grid">
          {visible.map((conversation) => <ConversationTaskCard key={conversation.id} conversation={conversation} overview={overviews[conversation.id]} status={statuses[conversation.id]} loading={Boolean(loading[conversation.id])} error={errors[conversation.id]} unread={Boolean(unread[conversation.id])} unreadResult={unread[conversation.id]?.kind === "success" || unread[conversation.id]?.kind === "failure"} project={projectByConversation.get(conversation.id)?.label} owner={currentUser?.isOwner && conversation.ownerUsername && conversation.ownerUsername !== currentUser.username ? conversation.ownerUsername : undefined} attentionReason={attentionReasons.get(conversation.id)?.[0]} live={live[conversation.id]} onOpenConversation={onOpenConversation} onOpenFile={onOpenFile} onRetry={(id) => void refresh([id])} />)}
        </div>
        {!visible.length && <div className="ctp-empty">{unresolvedLoading ? <LoaderCircle size={30} className="ctp-spin" aria-hidden="true" /> : <MessageSquare size={38} strokeWidth={1.2} aria-hidden="true" />}<h2>{t(unresolvedLoading ? "conversationPanel.loadingActivities" : items.length ? "conversations.noResults" : "conversations.empty")}</h2>{!unresolvedLoading && (items.length ? <button type="button" onClick={() => { ui.setQuery(""); ui.setProjectKey(""); ui.setFilter("all"); }}>{t("conversationPanel.clearFilters")}</button> : <button type="button" onClick={onNewConversation}>{t("conversationPanel.newConversation")}</button>)}</div>}
        {filtered.length > visible.length && <div className="ctp-load-more"><span>{t("conversationPanel.showing", { count: visible.length, total: filtered.length })}</span><button type="button" onClick={ui.showMore}>{t("conversationPanel.loadMore")}</button></div>}
      </div>
    </section>
  );
}
