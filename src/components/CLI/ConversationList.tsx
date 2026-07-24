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
import { useWorkflowStore } from "@/store/workflowStore";
import type { Conversation } from "@/services/cli/types";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import {
  Folder,
  FolderOpen,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Trash2,
  X
} from "lucide-react";
import { AgentAvatar } from "./AgentAvatar";
import {
  PROJECT_PREVIEW_LIMIT,
  groupConversationsByProject,
  recentConversations,
  type ConversationProjectGroup
} from "./conversationProjectGrouping";

const ConversationRow = memo(function ConversationRow({
  conversation,
  isActive,
  isRunning,
  isWorkflowRunning,
  isUnread,
  compact,
  onSelect,
  onDelete
}: {
  conversation: Conversation;
  isActive: boolean;
  isRunning: boolean;
  isWorkflowRunning: boolean;
  isUnread: boolean;
  compact?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const isBusy = isRunning || isWorkflowRunning;

  return (
    <li
      className={`conv-item${compact ? " compact" : ""}${isActive ? " active" : ""}${!isBusy && isUnread ? " unread" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={isActive ? "true" : undefined}
      title={conversation.title}
      onClick={() => onSelect(conversation.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(conversation.id);
        }
      }}
    >
      <AgentAvatar
        adapter={conversation.adapter}
        className="conv-item-avatar"
        fallback={<MessageSquare aria-hidden="true" />}
      />
      <div className="conv-item-main">
        <div className="conv-item-title-row">
          <strong>{conversation.title}</strong>
        </div>
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
            <button
              className="conv-delete-button icon-btn danger"
              title={t("common.delete")}
              aria-label={t("common.delete")}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(conversation.id, conversation.title);
              }}
            >
              <X aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </li>
  );
});

function ProjectOverflowMenu({
  pinned,
  open,
  canReveal,
  onOpenChange,
  onTogglePin,
  onReveal,
  onDeleteAll
}: {
  pinned: boolean;
  open: boolean;
  canReveal: boolean;
  onOpenChange: (open: boolean) => void;
  onTogglePin: () => void;
  onReveal: () => void;
  onDeleteAll: () => void;
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
              onDeleteAll();
            }}
          >
            <Trash2 aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>{t("conversations.deleteProjectConversations")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function ConversationList({
  onNewTaskInProject
}: {
  onNewTaskInProject?: (cwd: string) => void;
}) {
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const unreadConversations = useConversationStore((s) => s.unreadConversations);
  const setActive = useConversationStore((s) => s.setActive);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const runningSignature = useConversationStore((s) => {
    const ids: string[] = [];
    for (const c of s.conversations) {
      const st = s.live[c.id]?.status;
      if (st === "running" || st === "starting") ids.push(c.id);
    }
    return ids.join("\n");
  });
  const workflowActiveRuns = useWorkflowStore((s) => s.activeRuns);
  const loadWorkflowActiveRuns = useWorkflowStore((s) => s.loadActiveRuns);
  const pinnedKeys = usePinnedProjectsStore((s) => s.pinnedKeys);
  const togglePin = usePinnedProjectsStore((s) => s.toggle);
  const unpin = usePinnedProjectsStore((s) => s.unpin);
  const { t } = useTranslation();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [expandedFully, setExpandedFully] = useState<Set<string>>(() => new Set());
  const [menuProjectKey, setMenuProjectKey] = useState<string | null>(null);

  const runningSet = new Set(runningSignature ? runningSignature.split("\n") : []);
  const workflowRunningSet = new Set(
    workflowActiveRuns
      .map((run) => run.conversationId)
      .filter((id): id is string => Boolean(id))
  );

  const handleSelect = useCallback(
    (id: string) => {
      void setActive(id);
    },
    [setActive]
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

  const projects = useMemo(() => {
    const groups = groupConversationsByProject(conversations);
    return [...groups].sort((a, b) => {
      const aPin = pinnedKeys.indexOf(a.key);
      const bPin = pinnedKeys.indexOf(b.key);
      const aPinned = aPin >= 0;
      const bPinned = bPin >= 0;
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (aPinned && bPinned && aPin !== bPin) return aPin - bPin;
      return b.latestAt - a.latestAt || a.label.localeCompare(b.label);
    });
  }, [conversations, pinnedKeys]);
  const recent = useMemo(() => recentConversations(conversations), [conversations]);

  const activeProjectKey = useMemo(() => {
    const active = conversations.find((c) => c.id === activeId);
    const cwd = active?.cwd?.trim();
    if (!cwd) return undefined;
    return cwd.replace(/[\\/]+$/, "").toLowerCase();
  }, [activeId, conversations]);

  useEffect(() => {
    if (!activeProjectKey) return;
    setExpandedProjects((current) => {
      if (current.has(activeProjectKey)) return current;
      const next = new Set(current);
      next.add(activeProjectKey);
      return next;
    });
  }, [activeProjectKey]);

  useEffect(() => {
    if (projects.length === 0) return;
    setExpandedProjects((current) => {
      if (current.size > 0) return current;
      const next = new Set<string>();
      next.add(projects[0].key);
      return next;
    });
  }, [projects]);

  const toggleProject = (key: string) => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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

  const handleDeleteProject = async (project: ConversationProjectGroup) => {
    const confirmed = window.confirm(
      i18next.t("conversations.deleteProjectConfirm", {
        name: project.label,
        count: project.items.length
      })
    );
    if (!confirmed) return;
    for (const conversation of project.items) {
      await deleteConversation(conversation.id);
    }
    unpin(project.key);
    setMenuProjectKey(null);
  };

  const renderRow = (c: Conversation, compact?: boolean) => (
    <ConversationRow
      key={c.id}
      conversation={c}
      isActive={activeId === c.id}
      isRunning={runningSet.has(c.id)}
      isWorkflowRunning={workflowRunningSet.has(c.id)}
      isUnread={Boolean(unreadConversations[c.id])}
      compact={compact}
      onSelect={handleSelect}
      onDelete={handleDelete}
    />
  );

  return (
    <div className="conv-list">
      <ul>
        {conversations.length === 0 ? (
          <li className="conv-empty muted">{t("conversations.empty")}</li>
        ) : (
          <>
            {projects.length > 0 && (
              <li className="conv-group-header" aria-hidden="true">
                <span>{t("conversations.projects")}</span>
              </li>
            )}
            {projects.map((project) => {
              const expanded = expandedProjects.has(project.key);
              const showAll = expandedFully.has(project.key);
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
              const hasRunning = project.items.some(
                (c) => runningSet.has(c.id) || workflowRunningSet.has(c.id)
              );
              const hasUnread = project.items.some((c) => Boolean(unreadConversations[c.id]));
              const showRunningIndicator = !expanded && hasRunning;
              const showUnreadIndicator = !expanded && !hasRunning && hasUnread;

              return (
                <Fragment key={project.key}>
                  <li
                    className={`conv-project-row${selected ? " selected" : ""}${menuOpen ? " menu-open" : ""}${pinned ? " pinned" : ""}${showRunningIndicator ? " running" : ""}${showUnreadIndicator ? " unread" : ""}`}
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
                              if (!project.cwd || !onNewTaskInProject) return;
                              setExpandedProjects((current) => {
                                const next = new Set(current);
                                next.add(project.key);
                                return next;
                              });
                              onNewTaskInProject(project.cwd);
                            }}
                          >
                            <Plus aria-hidden="true" size={14} strokeWidth={2} />
                          </button>
                          <ProjectOverflowMenu
                            pinned={pinned}
                            open={menuOpen}
                            canReveal={Boolean(
                              project.cwd && window.freebuddy?.shell?.showItemInFolder
                            )}
                            onOpenChange={(open) =>
                              setMenuProjectKey(open ? project.key : null)
                            }
                            onTogglePin={() => togglePin(project.key)}
                            onReveal={() => {
                              if (!project.cwd) return;
                              void window.freebuddy?.shell?.showItemInFolder(project.cwd);
                            }}
                            onDeleteAll={() => {
                              void handleDeleteProject(project);
                            }}
                          />
                        </div>
                      </div>
                    </div>
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

            {recent.length > 0 && (
              <>
                <li className="conv-group-header recent" aria-hidden="true">
                  <span>{t("conversations.recent")}</span>
                </li>
                {recent.map((c) => renderRow(c))}
              </>
            )}
          </>
        )}
      </ul>
    </div>
  );
}
