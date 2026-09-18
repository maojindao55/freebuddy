import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { FREEBIE_BUNDLED_PROVIDERS } from "@/config/freebie";
import { ProviderBrandIcon } from "./ProviderBrandIcon";

export interface ProviderPresetPickerProps {
  /** `null` means the user chose the fully custom (blank) form. */
  onPick: (presetId: string | null) => void;
}

/**
 * Grid of bundled provider presets shown on the empty state and above the
 * "new provider" form so first-time users can one-click fill name/baseUrl/
 * protocol instead of typing everything by hand.
 */
export function ProviderPresetPicker({ onPick }: ProviderPresetPickerProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language?.startsWith("zh") ? "zh-CN" : "en";

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

  return (
    <div className="preset-picker">
      <div className="preset-picker-title">{t("providers.pickPreset")}</div>
      <div className="preset-picker-grid">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            className="preset-card"
            onClick={() => onPick(p.id)}
            title={p.freeTierSummary?.[locale] ?? p.baseUrl}
          >
            <ProviderBrandIcon
              nameOrId={p.id}
              lobeIconId={p.icon}
              size={26}
              className="preset-card-icon"
            />
            <span className="preset-card-body">
              <span className="preset-card-name">{p.name}</span>
              {p.freeTierSummary?.[locale] ? (
                <span className="preset-card-summary">{p.freeTierSummary[locale]}</span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
      <button type="button" className="preset-custom-btn" onClick={() => onPick(null)}>
        <Pencil size={12} />
        <span>{t("providers.customProvider")}</span>
      </button>
    </div>
  );
}
