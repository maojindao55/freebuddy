import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { displayAgentName } from "@/config/agentDisplay";
import { useConversationStore } from "@/store/conversationStore";
import type { Conversation } from "@/services/cli/types";
import {
  projectLabelFromCwd,
  conversationActivityTime
} from "./conversationProjectGrouping";

const RESULT_LIMIT = 9;

type PaletteAction = {
  id: string;
  label: string;
  meta?: string;
  shortcut?: string;
  run: () => void;
};

export function ConversationCommandPalette({
  open,
  onClose,
  onNewTask,
  onOpenScheduledTasks,
  onOpenSettings,
  onSelectConversation
}: {
  open: boolean;
  onClose: () => void;
  onNewTask: (options?: { cwd?: string }) => void;
  onOpenScheduledTasks: () => void;
  onOpenSettings: () => void;
  onSelectConversation?: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const setActive = useConversationStore((s) => s.setActive);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const currentProjectCwd = useMemo(() => {
    const active = conversations.find((conversation) => conversation.id === activeId);
    const cwd = active?.cwd?.trim();
    return cwd || undefined;
  }, [activeId, conversations]);

  const actions = useMemo<PaletteAction[]>(() => {
    const items: PaletteAction[] = [
      {
        id: "new-task",
        label: t("sidebar.newConversation"),
        shortcut: "⌘N",
        run: () => {
          onNewTask();
          onClose();
        }
      }
    ];
    if (currentProjectCwd) {
      items.push({
        id: "new-task-in-project",
        label: t("conversations.newInCurrentProject"),
        meta: projectLabelFromCwd(currentProjectCwd),
        run: () => {
          onNewTask({ cwd: currentProjectCwd });
          onClose();
        }
      });
    }
    items.push(
      {
        id: "scheduled",
        label: t("sidebar.scheduledTasks"),
        run: () => {
          onOpenScheduledTasks();
          onClose();
        }
      },
      {
        id: "settings",
        label: t("common.settings"),
        shortcut: "⌘,",
        run: () => {
          onOpenSettings();
          onClose();
        }
      }
    );
    return items;
  }, [
    currentProjectCwd,
    onClose,
    onNewTask,
    onOpenScheduledTasks,
    onOpenSettings,
    t
  ]);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = normalized
      ? conversations.filter((conversation) => {
          if (conversation.title.toLowerCase().includes(normalized)) return true;
          if (conversation.cwd?.toLowerCase().includes(normalized)) return true;
          return displayAgentName(conversation.agentName, conversation.adapter)
            .toLowerCase()
            .includes(normalized);
        })
      : conversations;
    return [...filtered]
      .sort((a, b) => conversationActivityTime(b) - conversationActivityTime(a))
      .slice(0, RESULT_LIMIT);
  }, [conversations, query]);

  const selectableCount = results.length + actions.length;

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      return;
    }
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    if (selectableCount === 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((current) => Math.min(current, selectableCount - 1));
  }, [open, selectableCount]);

  if (!open) return null;

  const selectConversation = (conversation: Conversation) => {
    void setActive(conversation.id);
    onSelectConversation?.();
    onClose();
  };

  const activateIndex = (index: number) => {
    if (index < results.length) {
      const conversation = results[index];
      if (conversation) selectConversation(conversation);
      return;
    }
    const action = actions[index - results.length];
    action?.run();
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (selectableCount === 0) return;
      setActiveIndex((current) => (current + 1) % selectableCount);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (selectableCount === 0) return;
      setActiveIndex((current) => (current - 1 + selectableCount) % selectableCount);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activateIndex(activeIndex);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index < results.length) {
        event.preventDefault();
        activateIndex(index);
      }
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="modal-backdrop command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="command-palette-head">
          <strong id={titleId}>{t("commandPalette.title")}</strong>
          <span className="command-palette-tag">{t("commandPalette.commandMenu")}</span>
        </div>
        <div className="command-palette-input-wrap">
          <Search aria-hidden="true" size={15} strokeWidth={1.8} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            enterKeyHint="search"
            placeholder={t("commandPalette.placeholder")}
            aria-label={t("commandPalette.placeholder")}
            aria-controls="command-palette-results"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div id="command-palette-results" className="command-palette-body">
          <section className="command-palette-section" aria-label={t("conversations.title")}>
            <h5>{t("conversations.title")}</h5>
            {results.length === 0 ? (
              <p className="command-palette-empty">
                {query.trim()
                  ? t("conversations.noResults")
                  : t("conversations.empty")}
              </p>
            ) : (
              <ul role="listbox" aria-label={t("conversations.title")}>
                {results.map((conversation, index) => {
                  const project = conversation.cwd
                    ? projectLabelFromCwd(conversation.cwd)
                    : "";
                  const shortcut =
                    index < 9 ? `⌘${index + 1}` : undefined;
                  return (
                    <li key={conversation.id} role="none">
                      <button
                        type="button"
                        role="option"
                        aria-selected={activeIndex === index}
                        className={`command-palette-row${activeIndex === index ? " active" : ""}`}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => selectConversation(conversation)}
                      >
                        <span className="command-palette-row-title">
                          {conversation.title}
                        </span>
                        {project ? (
                          <span className="command-palette-row-meta">{project}</span>
                        ) : (
                          <span className="command-palette-row-meta" />
                        )}
                        {shortcut ? <kbd>{shortcut}</kbd> : <span />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section
            className="command-palette-section command-palette-actions"
            aria-label={t("commandPalette.recommended")}
          >
            <h5>{t("commandPalette.recommended")}</h5>
            <ul>
              {actions.map((action, actionIndex) => {
                const index = results.length + actionIndex;
                return (
                  <li key={action.id}>
                    <button
                      type="button"
                      className={`command-palette-row action${activeIndex === index ? " active" : ""}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={action.run}
                    >
                      <span className="command-palette-row-title">{action.label}</span>
                      <span className="command-palette-row-meta">
                        {action.meta ?? ""}
                      </span>
                      {action.shortcut ? <kbd>{action.shortcut}</kbd> : <span />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
