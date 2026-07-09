import { useEffect, useId, useMemo, useRef, useState } from "react";
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

  if (filtered.length === 0 || !modelOption) return null;

  const handleChange = (option: ConfigOptionItem, selected: string) => {
    const next: Record<string, string> = { ...(overrides ?? {}) };
    if (selected === option.currentValue || selected === "") {
      delete next[option.id];
    } else {
      next[option.id] = selected;
    }
    onChange(next);
  };

  return (
    <div className="composer-session-config" ref={rootRef}>
      <button
        type="button"
        className="composer-permission composer-session-config-trigger"
        title={t("chat.modelPickerHint")}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="composer-permission-label">{t("chat.modelPicker")}</span>
        <span className="composer-session-config-value">{summaryLabel}</span>
      </button>
      {open ? (
        <div
          id={panelId}
          className="composer-session-config-panel"
          role="dialog"
          aria-label={t("chat.modelPickerHint")}
        >
          {filtered.map((option, index) => (
            <label
              key={`${option.category ?? ""}:${option.id}:${index}`}
              className="composer-session-config-row"
            >
              <span className="composer-session-config-row-label">
                {categoryLabel(option, t)}
              </span>
              <select
                className="composer-session-config-row-select"
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
