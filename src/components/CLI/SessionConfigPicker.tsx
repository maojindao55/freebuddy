import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { ConfigOptionItem } from "@/store/sessionMetaUtils";
import {
  displayConfigOptionLabel,
  displayConfigOptionValue,
  filterSessionConfigPickerOptions,
  findMainModelConfigOption
} from "@/utils/sessionConfigOptions";

type Props = {
  options: ConfigOptionItem[];
  overrides?: Record<string, string>;
  disabled?: boolean;
  className?: string;
  fallback?: ReactNode;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  onChange: (next: Record<string, string>) => void;
};

type PanelPosition = {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
};

function categoryLabel(
  option: ConfigOptionItem,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (option.id === "provider" || option.category === "provider") {
    return t("chat.provider", { defaultValue: option.name || "Provider" });
  }
  switch (option.category) {
    case "model":
      if (option.id !== "model" && option.name) return option.name;
      return t("chat.model");
    case "model_config":
      return t("chat.modelConfig");
    case "thought_level":
      return t("chat.thoughtLevel");
    default:
      if (option.id === "model") return t("chat.model");
      return option.name || t("chat.modelPicker");
  }
}

function computePanelPosition(trigger: HTMLElement): PanelPosition {
  const width = 280;
  const gap = 8;
  const rect = trigger.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, rect.right - width),
    window.innerWidth - width - 8
  );

  const spaceAbove = Math.max(120, rect.top - gap - 8);
  const spaceBelow = Math.max(120, window.innerHeight - rect.bottom - gap - 8);
  const openUp = spaceAbove >= Math.min(spaceBelow, 260) || spaceAbove >= 200;

  if (openUp) {
    return {
      bottom: window.innerHeight - rect.top + gap,
      left,
      width,
      maxHeight: Math.min(460, spaceAbove)
    };
  }

  return {
    top: rect.bottom + gap,
    left,
    width,
    maxHeight: Math.min(460, spaceBelow)
  };
}

function ConfigOptionRow({
  option,
  selected,
  t,
  onSelect
}: {
  option: ConfigOptionItem;
  selected: string;
  t: (key: string, options?: Record<string, unknown>) => string;
  onSelect: (valueId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const values = option.values ?? [];
  const showSearch = values.length > 8;

  useEffect(() => {
    setSearch("");
  }, [option.values]);

  const filteredValues = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return values;
    return values.filter(
      (v) =>
        (v.name || "").toLowerCase().includes(query) ||
        v.id.toLowerCase().includes(query)
    );
  }, [values, search]);

  return (
    <div className="session-config-picker-row">
      <div className="session-config-picker-row-header">
        <div className="session-config-picker-row-label">
          {categoryLabel(option, t)}
        </div>
        {showSearch ? (
          <input
            type="text"
            className="session-config-picker-search"
            placeholder={t("chat.modelSearchPlaceholder", {
              defaultValue: "Search…"
            })}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
        ) : null}
      </div>
      <div
        className={`session-config-picker-choices${
          showSearch ? " scrollable" : ""
        }`}
        role="listbox"
        aria-label={categoryLabel(option, t)}
      >
        {filteredValues.map((value) => {
          const active = value.id === selected;
          return (
            <button
              key={value.id}
              type="button"
              role="option"
              aria-selected={active}
              className={`session-config-picker-choice${
                active ? " active" : ""
              }`}
              onClick={() => onSelect(value.id)}
            >
              {value.name || value.id}
            </button>
          );
        })}
        {showSearch && filteredValues.length === 0 ? (
          <div className="session-config-picker-empty">
            {t("common.noMatches", { defaultValue: "No matches" })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SessionConfigPicker({
  options,
  overrides,
  disabled,
  className,
  fallback = null,
  leadingIcon,
  trailingIcon,
  onChange
}: Props) {
  const { t } = useTranslation();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);

  const filtered = useMemo(
    () => filterSessionConfigPickerOptions(options),
    [options]
  );

  const modelOption = useMemo(
    () => findMainModelConfigOption(filtered),
    [filtered]
  );

  const summaryLabel = modelOption
    ? displayConfigOptionLabel(modelOption, overrides) ||
      t("chat.modelPicker")
    : t("chat.modelPicker");

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setPosition(null);
      return;
    }

    const update = () => {
      if (!triggerRef.current) return;
      setPosition(computePanelPosition(triggerRef.current));
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  if (filtered.length === 0 || !modelOption) return <>{fallback}</>;

  const handleChange = (option: ConfigOptionItem, selected: string) => {
    const next: Record<string, string> = { ...(overrides ?? {}) };
    if (option.id === "provider" || option.category === "provider") {
      delete next.model;
    }
    if (selected === "") {
      delete next[option.id];
    } else {
      next[option.id] = selected;
    }
    onChange(next);
  };

  const rootClassName = ["session-config-picker", className]
    .filter(Boolean)
    .join(" ");

  const panelStyle: CSSProperties | undefined = position
    ? {
        top: position.top,
        bottom: position.bottom,
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight
      }
    : undefined;

  return (
    <div className={rootClassName} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="composer-permission session-config-picker-trigger"
        title={t("chat.modelPickerHint")}
        aria-label={`${t("chat.modelPicker")}: ${summaryLabel}`}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        {leadingIcon ? (
          <span className="session-config-picker-icon" aria-hidden="true">
            {leadingIcon}
          </span>
        ) : null}
        <span className="session-config-picker-value">{summaryLabel}</span>
        {trailingIcon ? (
          <span className="session-config-picker-icon" aria-hidden="true">
            {trailingIcon}
          </span>
        ) : null}
      </button>
      {open && position
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              className="session-config-picker-panel session-config-picker-panel-portal"
              role="dialog"
              aria-label={t("chat.modelPickerHint")}
              style={panelStyle}
            >
              {filtered.map((option, index) => {
                const selected =
                  displayConfigOptionValue(option, overrides) ?? "";
                return (
                  <ConfigOptionRow
                    key={`${option.category ?? ""}:${option.id}:${index}`}
                    option={option}
                    selected={selected}
                    t={t}
                    onSelect={(valueId) => handleChange(option, valueId)}
                  />
                );
              })}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
