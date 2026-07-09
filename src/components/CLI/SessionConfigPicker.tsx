import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
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
  panelPlacement?: "up" | "down";
  onChange: (next: Record<string, string>) => void;
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

export function SessionConfigPicker({
  options,
  overrides,
  disabled,
  className,
  fallback = null,
  panelPlacement = "up",
  onChange
}: Props) {
  const { t } = useTranslation();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

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

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
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

  return (
    <div className={rootClassName} ref={rootRef}>
      <button
        type="button"
        className="composer-permission session-config-picker-trigger"
        title={t("chat.modelPickerHint")}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="composer-permission-label">{t("chat.modelPicker")}</span>
        <span className="session-config-picker-value">{summaryLabel}</span>
      </button>
      {open ? (
        <div
          id={panelId}
          className={`session-config-picker-panel session-config-picker-panel-${panelPlacement}`}
          role="dialog"
          aria-label={t("chat.modelPickerHint")}
        >
          {filtered.map((option, index) => (
            <label
              key={`${option.category ?? ""}:${option.id}:${index}`}
              className="session-config-picker-row"
            >
              <span className="session-config-picker-row-label">
                {categoryLabel(option, t)}
              </span>
              <select
                className="session-config-picker-row-select"
                value={displayConfigOptionValue(option, overrides) ?? ""}
                disabled={disabled}
                aria-label={categoryLabel(option, t)}
                onChange={(event) => handleChange(option, event.target.value)}
              >
                {(option.values ?? []).map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.name || value.id}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
