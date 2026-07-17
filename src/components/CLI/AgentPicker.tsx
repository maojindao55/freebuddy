import {
  Check,
  ChevronDown,
  LoaderCircle,
  Settings2
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AgentAvailabilityGroups } from "@/utils/agentAvailability";
import { AgentAvatar } from "./AgentAvatar";

export function AgentPicker({
  groups,
  selectedId,
  checkingIds,
  disabled,
  onChange,
  onOpen,
  onManage
}: {
  groups: AgentAvailabilityGroups;
  selectedId: string;
  checkingIds: Set<string>;
  disabled?: boolean;
  onChange: (id: string) => void;
  onOpen: () => void;
  onManage: () => void;
}) {
  const { t } = useTranslation();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const manageRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const available = groups.available;
  const filteredAvailable = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return available;
    return available.filter((entry) =>
      entry.member.name.toLowerCase().includes(normalized)
    );
  }, [available, query]);
  const selected = available.find((entry) => entry.member.id === selectedId);
  const checking = useMemo(
    () =>
      [...groups.available, ...groups.checking, ...groups.unavailable].filter(
        (entry) =>
          entry.state === "checking" || checkingIds.has(entry.member.id)
      ),
    [checkingIds, groups]
  );
  const unavailableCount = groups.unavailable.filter(
    (entry) => !checkingIds.has(entry.member.id)
  ).length;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const selectedIndex = available.findIndex(
        (entry) => entry.member.id === selectedId
      );
      const option = optionRefs.current[Math.max(0, selectedIndex)];
      if (option) option.focus();
      else manageRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
    // Opening always starts from an empty query, so the available ordering is
    // the same ordering rendered into optionRefs for this frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  useEffect(() => {
    optionRefs.current = optionRefs.current.slice(0, filteredAvailable.length);
  }, [filteredAvailable.length]);

  const toggleOpen = () => {
    setOpen((current) => {
      const next = !current;
      if (next) onOpen();
      else setQuery("");
      return next;
    });
  };

  const fallback = selected?.member.name.slice(0, 1).toUpperCase() ?? "A";

  const moveOptionFocus = (direction: 1 | -1) => {
    const options = optionRefs.current.filter(
      (option): option is HTMLButtonElement => Boolean(option)
    );
    if (options.length === 0) {
      manageRef.current?.focus();
      return;
    }
    const currentIndex = options.indexOf(
      document.activeElement as HTMLButtonElement
    );
    const nextIndex =
      currentIndex < 0
        ? direction > 0
          ? 0
          : options.length - 1
        : (currentIndex + direction + options.length) % options.length;
    options[nextIndex]?.focus();
  };

  return (
    <div className="new-task-agent-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        className="agent-picker-trigger"
        type="button"
        aria-label={t("chat.agent")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={toggleOpen}
      >
        {selected ? (
          <AgentAvatar
            adapter={selected.member.cli.adapter}
            agentId={selected.member.id}
            className="agent-picker-avatar"
            fallback={fallback}
          />
        ) : checking.length > 0 ? (
          <LoaderCircle className="agent-picker-trigger-spinner" aria-hidden="true" />
        ) : null}
        <span className="agent-picker-trigger-label">
          {selected
            ? selected.member.name
            : checking.length > 0
              ? t("chat.agentPicker.checking")
              : t("chat.agentPicker.noAvailableShort")}
        </span>
        <ChevronDown className="agent-picker-chevron" aria-hidden="true" />
      </button>

      {open ? (
        <div
          className="agent-picker-popover"
          id={menuId}
          role="dialog"
          aria-label={t("chat.agentPicker.selectionAria")}
        >
          {available.length > 0 ? (
            <div className="agent-picker-section">
              <div className="agent-picker-section-title">
                <span>{t("chat.agentPicker.available")}</span>
                <span>{available.length}</span>
              </div>
              {available.length > 8 ? (
                <input
                  className="agent-picker-search"
                  type="search"
                  value={query}
                  aria-label={t("chat.agentPicker.searchPlaceholder")}
                  placeholder={t("chat.agentPicker.searchPlaceholder")}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
              ) : null}
              <div
                className="agent-picker-options"
                role="listbox"
                aria-label={t("chat.agentPicker.available")}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveOptionFocus(1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    moveOptionFocus(-1);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    optionRefs.current[0]?.focus();
                  } else if (event.key === "End") {
                    event.preventDefault();
                    optionRefs.current[filteredAvailable.length - 1]?.focus();
                  }
                }}
              >
                {filteredAvailable.map((entry, index) => {
                  const active = entry.member.id === selectedId;
                  return (
                    <button
                      ref={(node) => {
                        optionRefs.current[index] = node;
                      }}
                      key={entry.member.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`agent-picker-option${active ? " active" : ""}`}
                      onClick={() => {
                        onChange(entry.member.id);
                        setOpen(false);
                        triggerRef.current?.focus();
                      }}
                    >
                      <AgentAvatar
                        adapter={entry.member.cli.adapter}
                        agentId={entry.member.id}
                        className="agent-picker-option-avatar"
                        fallback={entry.member.name.slice(0, 1).toUpperCase()}
                      />
                      <span className="agent-picker-option-copy">
                        <strong>{entry.member.name}</strong>
                        <small>{t("chat.agentPicker.ready")}</small>
                      </span>
                      {active ? (
                        <Check className="agent-picker-check" aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
                {filteredAvailable.length === 0 ? (
                  <p className="agent-picker-no-matches">
                    {t("chat.agentPicker.noMatches")}
                  </p>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="agent-picker-empty">
              <strong>{t("chat.agentPicker.noAvailable")}</strong>
              <span>
                {checking.length > 0
                  ? t("chat.agentPicker.checkingHint")
                  : t("chat.agentPicker.installHint")}
              </span>
            </div>
          )}

          {checking.length > 0 ? (
            <div className="agent-picker-checking" aria-live="polite">
              <LoaderCircle aria-hidden="true" />
              <span>
                {t("chat.agentPicker.checkingCount", { count: checking.length })}
              </span>
            </div>
          ) : null}

          <button
            ref={manageRef}
            className="agent-picker-manage"
            type="button"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <Settings2 aria-hidden="true" />
            <span>
              {unavailableCount > 0
                ? t("chat.agentPicker.installMore", { count: unavailableCount })
                : t("chat.agentPicker.manage")}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
