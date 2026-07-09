import { useTranslation } from "react-i18next";

import type { ConfigOptionItem } from "@/store/sessionMetaUtils";
import {
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
  const filtered = filterSessionConfigPickerOptions(options);
  if (filtered.length === 0) return null;

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
    <div className="composer-session-config" title={t("chat.modelPickerHint")}>
      {filtered.map((option, index) => (
        <label
          key={`${option.category ?? ""}:${option.id}:${index}`}
          className="composer-permission"
        >
          <span className="composer-permission-label">
            {categoryLabel(option, t)}
          </span>
          <select
            className="composer-permission-select"
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
  );
}
