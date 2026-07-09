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
  filterSessionConfigPickerOptions
} from "@/utils/sessionConfigOptions";

type Props = {
  options: ConfigOptionItem[];
  overrides?: Record<string, string>;
  disabled?: boolean;
  className?: string;
  fallback?: ReactNode;
  onChange: (next: Record<string, string>) => void;
};

type PanelPosition = {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
};

function categoryLabel(
  option: ConfigOptionItem,
  t: (key: string) => string
): string {
  switch (option.category) {
    case "model":
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
  const width = 260;
  const gap = 10;
  const composer = trigger.closest(".chat-composer") as HTMLElement | null;
  const anchor = composer?.getBoundingClientRect() ?? trigger.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, anchor.right - width),
    window.innerWidth - width - 8
  );

  // Prefer floating completely above the composer so the textarea stays clear.
  if (anchor.top > 180) {
    return {
      bottom: window.innerHeight - anchor.top + gap,
      left,
      width
    };
  }

  return {
    top: Math.min(anchor.bottom + gap, window.innerHeight - 200),
    left,
    width
  };
}

export function SessionConfigPicker({
  options,
  overrides,
  disabled,
  className,
  fallback = null,
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
    () =>
      filtered.find((option) => option.category === "model") ??
      filtered.find((option) => option.id === "model") ??
      filtered[0],
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
    if (selected === option.currentValue || selected === "") {
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
        width: position.width
      }
    : undefined;

  return (
    <div className={rootClassName} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="composer-permission session-config-picker-trigger"
        title={t("chat.modelPickerHint")}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="composer-permission-label">{t("chat.modelPicker")}</span>
        <span className="session-config-picker-value">{summaryLabel}</span>
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
                  <div
                    key={`${option.category ?? ""}:${option.id}:${index}`}
                    className="session-config-picker-row"
                  >
                    <div className="session-config-picker-row-label">
                      {categoryLabel(option, t)}
                    </div>
                    <div
                      className="session-config-picker-choices"
                      role="listbox"
                      aria-label={categoryLabel(option, t)}
                    >
                      {(option.values ?? []).map((value) => {
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
                            onClick={() => handleChange(option, value.id)}
                          >
                            {value.name || value.id}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
