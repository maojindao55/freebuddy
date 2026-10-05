import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useConversationStore } from "@/store/conversationStore";
import { usePinnedProjectsStore } from "@/store/pinnedProjectsStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useConversationOverviewStore } from "@/store/conversationOverviewStore";
import { usePermissionStore } from "@/store/permissionStore";
import { useAuthenticationStore } from "@/store/authenticationStore";
import { RUNNING_PANEL_STATUSES, selectConversationPanelStatus } from "./conversationPanelData";
import type { Conversation, Project } from "@/services/cli/types";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import {
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderOpen,
  Gamepad2,
  LoaderCircle,
  LayoutGrid,
  List,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  X
} from "lucide-react";
import { AgentAvatar } from "./AgentAvatar";
import { EditableConversationTitle, useConversationVisibleTitle } from "./conversationTitle";
import { ProjectFormModal } from "./ProjectFormModal";
import { useDetailLayoutStore } from "@/store/detailLayoutStore";
import {
  PROJECT_LIST_LIMIT,
  PROJECT_PREVIEW_LIMIT,
  RECENT_LIMIT,
  groupConversationsByProject,
  groupConversationsByProjects,
  recentConversations,
  unreadConversationView,
  type ConversationProjectGroup
} from "./conversationProjectGrouping";

const ConversationRow = memo(function ConversationRow({
  conversation,
  isActive,
  isRunning,
  isWorkflowRunning,
  isUnread,
  deletionBlocked,
  compact,
  onSelect,
  onDelete
}: {
  conversation: Conversation;
  isActive: boolean;
  isRunning: boolean;
  isWorkflowRunning: boolean;
  isUnread: boolean;
  deletionBlocked: boolean;
  compact?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const currentUser = useConversationStore((s) => s.currentUser);
  const visibleTitle = useConversationVisibleTitle(conversation);
  const showOwner = currentUser?.isOwner === true;
  const ownerName = conversation.ownerUsername?.trim() || "";
  const isOwnConversation = ownerName === (currentUser?.username ?? "");
  const isBusy = isRunning || isWorkflowRunning;

  return (
    <li
      className={`conv-item${compact ? " compact" : ""}${isActive ? " active" : ""}${!isBusy && isUnread ? " unread" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={isActive ? "true" : undefined}
      title={visibleTitle}
      onClick={() => onSelect(conversation.id)}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, textarea, button")) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(conversation.id);
        }
      }}
    >
      {conversation.kind === "game" ? (
        <span
          className="conv-item-avatar flex items-center justify-center text-amber-500 font-bold"
          title={t("game.sessionTitle")}
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
        >
          <Gamepad2 size={16} />
        </span>
      ) : (
        <AgentAvatar
          adapter={conversation.adapter}
          className="conv-item-avatar"
          fallback={<MessageSquare aria-hidden="true" />}
        />
      )}
      <div className="conv-item-main">
        <div className="conv-item-title-row">
          <EditableConversationTitle conversation={conversation} variant="list" />
        </div>
        {showOwner && ownerName && !isOwnConversation && (
          <div className="conv-owner-sub" title={`@${ownerName}`}>@{ownerName}</div>
        )}
      </div>
      <div className={`conv-item-side${isBusy ? " running" : isUnread ? " unread" : ""}`}>
        {isBusy ? (
          <span
            className="conv-item-running"
            role="status"
            aria-label={isWorkflowRunning ? t("workflow.runningIndicator") : t("chat.agentRunning")}
            title={isWorkflowRunning ? t("workflow.runningIndicator") : t("chat.agentRunning")}
          >
            <LoaderCircle aria-hidden="true" size={14} strokeWidth={1.75} />
          </span>
        ) : (
          <>
            {isUnread && (
              <span
                className="conv-unread-dot"
                role="status"
                aria-label={t("conversations.unread")}
                title={t("conversations.unread")}
              />
            )}
            {!deletionBlocked && <button
              className="conv-delete-button icon-btn danger"
              title={t("common.delete")}
              aria-label={t("common.delete")}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(conversation.id, visibleTitle);
              }}
            >
              <X aria-hidden="true" />
            </button>}
          </>
        )}
      </div>
    </li>
  );
});

function formatProjectPath(raw: string): string {
  const normalized = raw.replace(/[\\/]+$/, "") || raw;
  const home =
    typeof window !== "undefined"
      ? (window as { freebuddyHome?: string }).freebuddyHome
      : undefined;
  // Prefer collapsing known macOS/Linux home prefixes when IPC home is unavailable.
  const guessedHome =
    home ||
    (normalized.match(/^(\/Users\/[^/]+)/)?.[1] ??
      normalized.match(/^(\/home\/[^/]+)/)?.[1]);
  if (guessedHome && normalized.startsWith(guessedHome)) {
    const rest = normalized.slice(guessedHome.length);
    return rest ? `~${rest}` : "~";
  }
  return normalized;
}

function ProjectHoverCard({
  label,
  folders,
  primaryPath,
  conversationCount,
  pinned,
  canReveal,
  onTogglePin,
  onEdit,
  onReveal
}: {
  label: string;
  folders: string[];
  primaryPath?: string;
  conversationCount: number;
  pinned: boolean;
  canReveal: boolean;
  onTogglePin: () => void;
  onEdit: () => void;
  onReveal: (folder: string) => void;
}) {
  const { t } = useTranslation();
  const mounted = folders.length
    ? folders
    : primaryPath
      ? [primaryPath]
      : [];

  return (
    <div className="conv-project-hover-card" role="dialog" aria-label={label}>
      <div className="conv-project-hover-header">
        <div className="conv-project-hover-title">
          <Folder aria-hidden="true" size={16} strokeWidth={1.7} />
          <span>{label}</span>
        </div>
        <button
          type="button"
          className="conv-project-hover-pin"
          aria-label={
            pinned ? t("conversations.unpinProject") : t("conversations.pinProject")
          }
          title={
            pinned ? t("conversations.unpinProject") : t("conversations.pinProject")
          }
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin();
          }}
        >
          {pinned ? (
            <PinOff aria-hidden="true" size={14} strokeWidth={1.8} />
          ) : (
            <Pin aria-hidden="true" size={14} strokeWidth={1.8} />
          )}
        </button>
      </div>

      <div className="conv-project-hover-meta">
        <MessageSquare aria-hidden="true" size={14} strokeWidth={1.8} />
        <span>
          {t("conversations.projectConversationCount", { count: conversationCount })}
        </span>
      </div>

      {mounted.length > 0 && (
        <div className="conv-project-hover-folders">
          {mounted.map((folder) => {
            const isPrimary =
              primaryPath != null &&
              folder.replace(/[\\/]+$/, "").toLowerCase() ===
                primaryPath.replace(/[\\/]+$/, "").toLowerCase();
            return (
              <button
                key={folder}
                type="button"
                className="conv-project-hover-folder"
                title={folder}
                disabled={!canReveal}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!canReveal) return;
                  onReveal(folder);
                }}
              >
                <Folder aria-hidden="true" size={14} strokeWidth={1.7} />
                <span className="conv-project-hover-folder-path">
                  {formatProjectPath(folder)}
                </span>
                {isPrimary && (
                  <span className="conv-project-hover-primary">
                    {t("conversations.primary")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="conv-project-hover-footer">
        <button
          type="button"
          className="conv-project-hover-edit"
          onClick={(event) => {
            event.stopPropagation();
            onEdit();
          }}
        >
          <Pencil aria-hidden="true" size={14} strokeWidth={1.8} />
          <span>{t("conversations.editProject")}</span>
        </button>
      </div>
    </div>
  );
}

function ProjectOverflowMenu({
  pinned,
  open,
  canReveal,
  onOpenChange,
  onEdit,
  onTogglePin,
  onReveal,
  onDeleteProject
}: {
  pinned: boolean;
  open: boolean;
  canReveal: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onTogglePin: () => void;
  onReveal: () => void;
  onDeleteProject: () => void;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div className={`conv-project-more${open ? " open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="conv-project-action-btn"
        aria-label={t("conversations.projectMenu")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("conversations.projectMenu")}
        onClick={(event) => {
          event.stopPropagation();
          onOpenChange(!open);
        }}
      >
        <MoreHorizontal aria-hidden="true" size={14} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="conv-project-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="conv-project-menu-item"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChange(false);
              onEdit();
            }}
          >
            <Pencil aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>{t("conversations.editProject")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="conv-project-menu-item"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChange(false);
              onTogglePin();
            }}
          >
            {pinned ? (
              <PinOff aria-hidden="true" size={14} strokeWidth={1.8} />
            ) : (
              <Pin aria-hidden="true" size={14} strokeWidth={1.8} />
            )}
            <span>
              {pinned
                ? t("conversations.unpinProject")
                : t("conversations.pinProject")}
            </span>
          </button>
          {canReveal && (
            <button
              type="button"
              role="menuitem"
              className="conv-project-menu-item"
              onClick={(event) => {
                event.stopPropagation();
                onOpenChange(false);
                onReveal();
              }}
            >
              <FolderOpen aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>{t("conversations.revealProject")}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="conv-project-menu-item danger"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChange(false);
              onDeleteProject();
            }}
          >
            <Trash2 aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>{t("conversations.deleteProject")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function ConversationList({
  onNewTaskInProject,
  panelActive = false,
  onOpenPanel,
  onOpenList,
  onOpenConversation
}: {
  onNewTaskInProject?: (args: { cwd: string; projectId: string }) => void;
  panelActive?: boolean;
  onOpenPanel?: () => void;
  onOpenList?: () => void;
  onOpenConversation?: (id: string) => void;
}) {
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const unreadConversations = useConversationStore((s) => s.unreadConversations);
  const setActive = useConversationStore((s) => s.setActive);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const refreshConversations = useConversationStore((s) => s.refreshList);
  const live = useConversationStore((s) => s.live);
  const overviews = useConversationOverviewStore((s) => s.overviews);
  const permissions = usePermissionStore((s) => s.queue);
  const authentications = useAuthenticationStore((s) => s.queue);
  const authTerminals = useAuthenticationStore((s) => s.terminalQueue);
  const workflowActiveRuns = useWorkflowStore((s) => s.activeRuns);
  const loadWorkflowActiveRuns = useWorkflowStore((s) => s.loadActiveRuns);
  const apiProjects = useProjectStore((s) => s.projects);
  const projectsLoaded = useProjectStore((s) => s.loaded);
  const projectsError = useProjectStore((s) => s.error);
  const refreshProjects = useProjectStore((s) => s.refresh);
  const removeProject = useProjectStore((s) => s.remove);
  const pinnedKeys = usePinnedProjectsStore((s) => s.pinnedKeys);
  const togglePin = usePinnedProjectsStore((s) => s.toggle);
  const unpin = usePinnedProjectsStore((s) => s.unpin);
  const { t } = useTranslation();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [collapsedUnreadProjects, setCollapsedUnreadProjects] = useState<Set<string>>(() => new Set());
  const allFilterRef = useRef<HTMLButtonElement>(null);
  const unreadFilterRef = useRef<HTMLButtonElement>(null);
  const [expandedFully, setExpandedFully] = useState<Set<string>>(() => new Set());
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [menuProjectKey, setMenuProjectKey] = useState<string | null>(null);
  const [hoverProjectKey, setHoverProjectKey] = useState<string | null>(null);
  const [hoverCardStyle, setHoverCardStyle] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const userCollapsedProjectsRef = useRef<Set<string>>(new Set());
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimerRef.current != null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  const openProjectHover = useCallback(
    (key: string, anchor?: HTMLElement | null) => {
      clearHoverCloseTimer();
      if (anchor) {
        const rect = anchor.getBoundingClientRect();
        setHoverCardStyle({
          top: Math.max(8, rect.top),
          left: rect.right + 10
        });
      }
      setHoverProjectKey(key);
    },
    [clearHoverCloseTimer]
  );

  const scheduleCloseProjectHover = useCallback(() => {
    clearHoverCloseTimer();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      setHoverProjectKey(null);
      setHoverCardStyle(null);
      hoverCloseTimerRef.current = null;
    }, 140);
  }, [clearHoverCloseTimer]);

  useEffect(() => {
    return () => clearHoverCloseTimer();
  }, [clearHoverCloseTimer]);

  const attentionIds = new Set([...permissions, ...authentications, ...authTerminals].map((request) => request.conversationId));
  const runningSet = new Set(conversations.filter((conversation) => RUNNING_PANEL_STATUSES.has(
    selectConversationPanelStatus(overviews[conversation.id], {
      live: live[conversation.id],
      attentionCount: attentionIds.has(conversation.id) ? 1 : 0,
      workflowStatus: workflowActiveRuns.find((run) => run.conversationId === conversation.id)?.status
    })
  )).map((conversation) => conversation.id));
  const workflowRunningSet = new Set(workflowActiveRuns
    .filter((run) => run.conversationId && runningSet.has(run.conversationId))
    .map((run) => run.conversationId));
  const deletionBlockedSet = new Set(conversations.filter((conversation) => {
    const status = selectConversationPanelStatus(overviews[conversation.id], {
      live: live[conversation.id],
      attentionCount: attentionIds.has(conversation.id) ? 1 : 0,
      workflowStatus: workflowActiveRuns.find((run) => run.conversationId === conversation.id)?.status
    });
    return RUNNING_PANEL_STATUSES.has(status) || status === "needs-input" || status === "waiting" || status === "paused";
  }).map((conversation) => conversation.id));

  const handleSelect = useCallback(
    (id: string) => {
      // A read row leaves the filtered list. Keep keyboard focus on a stable control.
      if (unreadOnly && document.activeElement?.matches(".conv-item")) {
        unreadFilterRef.current?.focus();
      }
      if (onOpenConversation) onOpenConversation(id);
      else void setActive(id);
      const conv = conversations.find((c) => c.id === id);
      if (conv?.kind === "game") {
        useDetailLayoutStore.getState().setActiveTab("preview");
        useDetailLayoutStore.getState().setDetailCollapsed(false);
      }
    },
    [setActive, conversations, unreadOnly, onOpenConversation]
  );
  const handleDelete = useCallback(
    (id: string, title: string) => {
      if (window.confirm(i18next.t("conversations.deleteConfirm", { title }))) {
        void deleteConversation(id);
      }
    },
    [deleteConversation]
  );

  useEffect(() => {
    void loadWorkflowActiveRuns();
  }, [loadWorkflowActiveRuns]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const projects = useMemo(() => {
    // Until the first refresh finishes, do not treat projects=[] as authoritative —
    // fall back to cwd grouping so projectId chats with a cwd stay visible.
    const groups = projectsLoaded
      ? groupConversationsByProjects(conversations, apiProjects)
      : groupConversationsByProject(conversations);
    return [...groups].sort((a, b) => {
      const aPin = pinnedKeys.indexOf(a.key);
      const bPin = pinnedKeys.indexOf(b.key);
      const aPinned = aPin >= 0;
      const bPinned = bPin >= 0;
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (aPinned && bPinned && aPin !== bPin) return aPin - bPin;
      const aHasItems = a.items.length > 0 ? 1 : 0;
      const bHasItems = b.items.length > 0 ? 1 : 0;
      if (aHasItems !== bHasItems) return bHasItems - aHasItems;
      return b.latestAt - a.latestAt || a.label.localeCompare(b.label);
    });
  }, [conversations, apiProjects, pinnedKeys, projectsLoaded]);
  const unreadView = useMemo(
    () => unreadConversationView(conversations, projects, unreadConversations),
    [conversations, projects, unreadConversations]
  );
  const recent = useMemo(() => {
    if (unreadOnly) return unreadView.recent;
    // null = not hydrated yet → keep projectId chats in Recent temporarily.
    // After load, only exclude chats whose project appears in the sidebar.
    const knownProjectIds = projectsLoaded
      ? new Set(apiProjects.map((project) => project.id))
      : null;
    return recentConversations(conversations, RECENT_LIMIT, knownProjectIds);
  }, [conversations, apiProjects, projectsLoaded, unreadOnly, unreadView]);

  const activeProjectKey = useMemo(() => {
    const active = conversations.find((c) => c.id === activeId);
    if (active?.projectId?.trim()) return active.projectId.trim();
    if (active) {
      const matched = projects.find((p) => p.items.some((item) => item.id === active.id));
      if (matched) return matched.key;
    }
    return undefined;
  }, [activeId, conversations, projects]);

  const currentUser = useConversationStore((s) => s.currentUser);

  const visibleProjects = useMemo(() => {
    if (unreadOnly) return unreadView.projects;
    const relevantProjects =
      currentUser && !currentUser.isOwner
        ? projects.filter(
            (p) =>
              p.items.length > 0 ||
              pinnedKeys.includes(p.key) ||
              p.key === activeProjectKey
          )
        : projects;
    if (showAllProjects || relevantProjects.length <= PROJECT_LIST_LIMIT) {
      return relevantProjects;
    }
    const visibleKeys = new Set<string>();
    const result: ConversationProjectGroup[] = [];
    // Always keep pinned projects visible.
    for (const project of relevantProjects) {
      if (!pinnedKeys.includes(project.key)) continue;
      result.push(project);
      visibleKeys.add(project.key);
    }
    for (const project of relevantProjects) {
      if (result.length >= PROJECT_LIST_LIMIT) break;
      if (visibleKeys.has(project.key)) continue;
      result.push(project);
      visibleKeys.add(project.key);
    }
    // Keep the active project visible even if it would be truncated.
    if (activeProjectKey && !visibleKeys.has(activeProjectKey)) {
      const active = relevantProjects.find((project) => project.key === activeProjectKey);
      if (active) result.push(active);
    }
    return result;
  }, [projects, showAllProjects, pinnedKeys, activeProjectKey, currentUser, unreadOnly, unreadView]);

  const hiddenProjectCount = Math.max(0, projects.length - visibleProjects.length);

  useEffect(() => {
    if (projects.length === 0) return;
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (activeProjectKey && !userCollapsedProjectsRef.current.has(activeProjectKey)) {
        next.add(activeProjectKey);
      }
      return next;
    });
  }, [projects, activeProjectKey]);

  const toggleProject = (key: string) => {
    if (unreadOnly) {
      setCollapsedUnreadProjects((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      return;
    }
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
        userCollapsedProjectsRef.current.add(key);
      } else {
        next.add(key);
        userCollapsedProjectsRef.current.delete(key);
      }
      return next;
    });
  };

  const showAllInProject = (key: string) => {
    setExpandedFully((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
  };

  const openCreateModal = () => {
    setFormMode("create");
    setEditingProject(null);
    setFormOpen(true);
    setMenuProjectKey(null);
  };

  const openEditModal = (project: ConversationProjectGroup) => {
    const entity = apiProjects.find((entry) => entry.id === project.projectId);
    if (!entity) return;
    setFormMode("edit");
    setEditingProject(entity);
    setFormOpen(true);
    setMenuProjectKey(null);
  };

  const handleDeleteProject = async (project: ConversationProjectGroup) => {
    if (!project.projectId) return;
    const confirmed = window.confirm(
      i18next.t("conversations.deleteProjectConfirmOnly", {
        name: project.label
      })
    );
    if (!confirmed) return;
    await removeProject(project.projectId);
    unpin(project.key);
    await refreshConversations();
    setMenuProjectKey(null);
  };

  const handleProjectSaved = async (project: Project) => {
    setExpandedProjects(new Set([project.id]));
    await refreshConversations();
  };

  const handleProjectDeleted = async (projectId: string) => {
    unpin(projectId);
    await refreshConversations();
  };

  const renderRow = (c: Conversation, compact?: boolean) => (
    <ConversationRow
      key={c.id}
      conversation={c}
      isActive={activeId === c.id}
      isRunning={runningSet.has(c.id)}
      isWorkflowRunning={workflowRunningSet.has(c.id)}
      isUnread={Boolean(unreadConversations[c.id])}
      deletionBlocked={deletionBlockedSet.has(c.id)}
      compact={compact}
      onSelect={handleSelect}
      onDelete={handleDelete}
    />
  );

  const showEmpty =
    !unreadOnly && conversations.length === 0 && apiProjects.length === 0 && recent.length === 0;

  const changeFilter = (onlyUnread: boolean) => {
    (onlyUnread ? unreadFilterRef : allFilterRef).current?.focus();
    if (onlyUnread === unreadOnly) return;
    setUnreadOnly(onlyUnread);
    setCollapsedUnreadProjects(new Set());
    setMenuProjectKey(null);
    setHoverProjectKey(null);
    setHoverCardStyle(null);
    clearHoverCloseTimer();
  };

  return (
    <div className="conv-list">
      <div className="conv-filter" role="group" aria-label={t("conversations.filterLabel")}>
        {onOpenPanel && <div className="conv-view-switch" role="group" aria-label={t("conversationPanel.viewLabel")}>
          <button type="button" className={`conv-view-button${!panelActive ? " active" : ""}`}
            title={t("conversationPanel.list")} aria-label={t("conversationPanel.list")} aria-pressed={!panelActive} onClick={onOpenList}>
            <List size={15} aria-hidden="true" />
          </button>
          <button type="button" className={`conv-view-button${panelActive ? " active" : ""}`}
            title={t("conversationPanel.panel")} aria-label={t("conversationPanel.panel")} aria-pressed={panelActive} onClick={onOpenPanel}>
            <LayoutGrid size={15} aria-hidden="true" />
          </button>
        </div>}
        <button
          ref={allFilterRef}
          type="button"
          className="conv-filter-button"
          aria-pressed={!unreadOnly}
          onClick={() => changeFilter(false)}
        >
          {t("conversations.filterAll")}
        </button>
        <button
          ref={unreadFilterRef}
          type="button"
          className="conv-filter-button"
          aria-pressed={unreadOnly}
          aria-label={t("conversations.filterUnreadCount", { count: unreadView.count })}
          onClick={() => changeFilter(true)}
        >
          {t("conversations.filterUnread")}
          <span className="conv-filter-count" aria-hidden="true">{unreadView.count}</span>
        </button>
      </div>
      <ul>
        {(!unreadOnly || visibleProjects.length > 0) && (
          <li className="conv-group-header projects">
            <span>{t("conversations.projects")}</span>
            <button
              type="button"
              className="conv-projects-add"
              title={t("conversations.addProject")}
              aria-label={t("conversations.addProject")}
              onClick={openCreateModal}
            >
              <Plus aria-hidden="true" size={14} strokeWidth={2} />
            </button>
          </li>
        )}
        {projectsError ? (
          <li className="conv-projects-error" role="status">
            {t("conversations.projectsLoadFailed")}
          </li>
        ) : null}

        {visibleProjects.map((project) => {
          const expanded = unreadOnly
            ? !collapsedUnreadProjects.has(project.key)
            : expandedProjects.has(project.key);
          const showAll = unreadOnly || expandedFully.has(project.key);
          const visibleItems = expanded
            ? showAll
              ? project.items
              : project.items.slice(0, PROJECT_PREVIEW_LIMIT)
            : [];
          const hiddenCount = expanded
            ? Math.max(0, project.items.length - visibleItems.length)
            : 0;
          const selected = activeProjectKey === project.key;
          const pinned = pinnedKeys.includes(project.key);
          const menuOpen = menuProjectKey === project.key;
          const hoverOpen = hoverProjectKey === project.key && !menuOpen;
          const hasRunning = project.items.some(
            (c) => runningSet.has(c.id) || workflowRunningSet.has(c.id)
          );
          const hasUnread = project.items.some((c) => Boolean(unreadConversations[c.id]));
          const showRunningIndicator = !expanded && hasRunning;
          const showUnreadIndicator = !expanded && !hasRunning && hasUnread;
          const primaryPath = project.primaryPath ?? project.cwd;
          const canReveal = Boolean(
            primaryPath && window.freebuddy?.shell?.showItemInFolder
          );

          return (
            <Fragment key={project.key}>
              <li
                className={`conv-project-row${selected ? " selected" : ""}${menuOpen ? " menu-open" : ""}${hoverOpen ? " hover-card-open" : ""}${pinned ? " pinned" : ""}${showRunningIndicator ? " running" : ""}${showUnreadIndicator ? " unread" : ""}`}
                onMouseEnter={(event) =>
                  openProjectHover(project.key, event.currentTarget)
                }
                onMouseLeave={scheduleCloseProjectHover}
              >
                <div className="conv-project-row-inner">
                  <button
                    type="button"
                    className="conv-project-toggle"
                    aria-expanded={expanded}
                    onClick={() => toggleProject(project.key)}
                  >
                    {expanded ? (
                      <FolderOpen
                        className="conv-project-folder"
                        aria-hidden="true"
                        size={18}
                        strokeWidth={1.6}
                      />
                    ) : (
                      <Folder
                        className="conv-project-folder"
                        aria-hidden="true"
                        size={18}
                        strokeWidth={1.6}
                      />
                    )}
                    <span className="conv-project-name">{project.label}</span>
                  </button>
                  <div className="conv-project-trailing">
                    {showRunningIndicator ? (
                      <span
                        className="conv-project-running-slot"
                        role="status"
                        aria-label={t("conversations.projectRunning")}
                        title={t("conversations.projectRunning")}
                      >
                        <LoaderCircle
                          className="conv-project-running"
                          aria-hidden="true"
                          size={14}
                          strokeWidth={1.75}
                        />
                      </span>
                    ) : showUnreadIndicator ? (
                      <span
                        className="conv-project-unread-slot"
                        role="status"
                        aria-label={t("conversations.unread")}
                        title={t("conversations.unread")}
                      >
                        <span className="conv-unread-dot" aria-hidden="true" />
                      </span>
                    ) : (
                      pinned && (
                        <span className="conv-project-pin-slot" aria-hidden="true">
                          <Pin
                            className="conv-project-pin"
                            size={12}
                            strokeWidth={2}
                          />
                        </span>
                      )
                    )}
                    <div className="conv-project-actions">
                      <button
                        type="button"
                        className="conv-project-action-btn new"
                        title={t("conversations.newInProject")}
                        aria-label={t("conversations.newInProject")}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!primaryPath || !project.projectId || !onNewTaskInProject) {
                            return;
                          }
                          setExpandedProjects(new Set([project.key]));
                          onNewTaskInProject({
                            cwd: primaryPath,
                            projectId: project.projectId
                          });
                        }}
                      >
                        <Plus aria-hidden="true" size={14} strokeWidth={2} />
                      </button>
                      <ProjectOverflowMenu
                        pinned={pinned}
                        open={menuOpen}
                        canReveal={canReveal}
                        onOpenChange={(open) => {
                          setMenuProjectKey(open ? project.key : null);
                          if (open) setHoverProjectKey(null);
                        }}
                        onEdit={() => openEditModal(project)}
                        onTogglePin={() => togglePin(project.key)}
                        onReveal={() => {
                          if (!primaryPath) return;
                          void window.freebuddy?.shell?.showItemInFolder(primaryPath);
                        }}
                        onDeleteProject={() => {
                          void handleDeleteProject(project);
                        }}
                      />
                    </div>
                  </div>
                </div>
                {hoverOpen && hoverCardStyle && (
                  <div
                    className="conv-project-hover-anchor"
                    style={hoverCardStyle}
                    onMouseEnter={() => openProjectHover(project.key)}
                    onMouseLeave={scheduleCloseProjectHover}
                  >
                    <ProjectHoverCard
                      label={project.label}
                      folders={project.folders ?? []}
                      primaryPath={primaryPath}
                      conversationCount={
                        projects.find((entry) => entry.key === project.key)?.items.length ?? project.items.length
                      }
                      pinned={pinned}
                      canReveal={canReveal}
                      onTogglePin={() => togglePin(project.key)}
                      onEdit={() => {
                        setHoverProjectKey(null);
                        setHoverCardStyle(null);
                        openEditModal(project);
                      }}
                      onReveal={(folder) => {
                        void window.freebuddy?.shell?.showItemInFolder(folder);
                      }}
                    />
                  </div>
                )}
              </li>
              {expanded && (
                <li className="conv-project-tasks" aria-label={project.label}>
                  <ul>
                    {visibleItems.length === 0 ? (
                      <li className="conv-project-empty">{t("conversations.noTasks")}</li>
                    ) : (
                      visibleItems.map((c) => renderRow(c, true))
                    )}
                    {hiddenCount > 0 && (
                      <li>
                        <button
                          type="button"
                          className="conv-project-expand"
                          onClick={() => showAllInProject(project.key)}
                        >
                          {t("conversations.showMore", { count: hiddenCount })}
                        </button>
                      </li>
                    )}
                  </ul>
                </li>
              )}
            </Fragment>
          );
        })}

        {!unreadOnly && projects.length > PROJECT_LIST_LIMIT && (
          <li className="conv-projects-footer">
            <button
              type="button"
              className={`conv-projects-toggle${showAllProjects ? " expanded" : ""}`}
              aria-expanded={showAllProjects}
              onClick={() => setShowAllProjects((open) => !open)}
            >
              {showAllProjects ? (
                <ChevronUp aria-hidden="true" size={14} strokeWidth={2} />
              ) : (
                <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />
              )}
              <span>
                {showAllProjects
                  ? t("conversations.showFewerProjects")
                  : t("conversations.showMoreProjects", {
                      count: hiddenProjectCount
                    })}
              </span>
            </button>
          </li>
        )}

        {recent.length > 0 && (
          <>
            <li className="conv-group-header recent" aria-hidden="true">
              <span>{t("conversations.recent")}</span>
            </li>
            {recent.map((c) => renderRow(c))}
          </>
        )}

        {showEmpty && (
          <li className="conv-empty muted">{t("conversations.empty")}</li>
        )}
        {unreadOnly && unreadView.count === 0 && (
          <li className="conv-unread-empty">
            <div className="conv-unread-empty-message" role="status">
              <CheckCheck aria-hidden="true" size={22} strokeWidth={1.6} />
              <strong>{t("conversations.noUnread")}</strong>
              <span>{t("conversations.noUnreadHint")}</span>
            </div>
            <button type="button" onClick={() => changeFilter(false)}>
              {t("conversations.viewAll")}
            </button>
          </li>
        )}
      </ul>

      <ProjectFormModal
        open={formOpen}
        mode={formMode}
        initial={editingProject}
        onClose={() => setFormOpen(false)}
        onSaved={(project) => {
          void handleProjectSaved(project);
        }}
        onDeleted={(projectId) => {
          void handleProjectDeleted(projectId);
        }}
      />
    </div>
  );
}
