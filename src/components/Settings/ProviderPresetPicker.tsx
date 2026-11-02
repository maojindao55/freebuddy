import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Search, X } from "lucide-react";
import { FREEBIE_BUNDLED_PROVIDERS } from "@/config/freebie";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import "./ProviderPresetPicker.css";

export interface ProviderPresetPickerProps {
  /** `null` means the user chose the fully custom (blank) form. */
  onPick: (presetId: string | null) => void;
}

/**
 * Searchable catalog of bundled presets. Connection setup stays in the editor.
 */
export function ProviderPresetPicker({ onPick }: ProviderPresetPickerProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language?.startsWith("zh") ? "zh-CN" : "en";
  const [query, setQuery] = useState("");

  const presets = useMemo(() => {
    const list = [...FREEBIE_BUNDLED_PROVIDERS];
    // CN-region presets first for zh locale, global first otherwise.
    const prefer = locale === "zh-CN" ? "cn" : "global";
    list.sort((a, b) => {
      const aw = a.region === prefer ? 0 : 1;
      const bw = b.region === prefer ? 0 : 1;
      return aw - bw;
    });
    return list;
  }, [locale]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return presets.filter((preset) =>
      `${preset.name} ${preset.id} ${preset.baseUrl}`.toLowerCase().includes(needle),
    );
  }, [presets, query]);

  return (
    <div className="preset-picker preset-picker-clean">
      <div className="preset-picker-toolbar">
        <div className="preset-picker-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("providers.searchPresets")}
            placeholder={t("providers.searchPresets")}
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label={t("providers.clearPresetSearch")}>
              <X size={13} />
            </button>
          )}
        </div>
        <span className="preset-picker-count" role="status">
          {t("providers.presetCount", { count: filtered.length })}
        </span>
      </div>
      <div className="preset-picker-grid" aria-label={t("providers.pickPreset")}>
        {filtered.map((p) => (
          <button
            key={p.id}
            type="button"
            className="preset-card"
            onClick={() => onPick(p.id)}
            aria-label={t("providers.configurePreset", { name: p.name })}
          >
            <ProviderBrandIcon
              nameOrId={p.id}
              alt={p.name}
              lobeIconId={p.icon}
              size={38}
              className="preset-card-icon"
            />
            <span className="preset-card-body">
              <span className="preset-card-name" title={p.name}>{p.name}</span>
              <span className="preset-card-summary" title={p.baseUrl}>{new URL(p.baseUrl).hostname}</span>
            </span>
            <ChevronRight size={14} className="preset-card-chevron" aria-hidden="true" />
          </button>
        ))}
      </div>
      {filtered.length === 0 && (
        <div className="preset-picker-empty">
          <Search size={24} aria-hidden="true" />
          <p>{t("providers.noPresetMatch")}</p>
          <button type="button" className="preset-custom-btn" onClick={() => onPick(null)}>
            {t("providers.customProvider")}
          </button>
        </div>
      )}
    </div>
  );
}
