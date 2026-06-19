import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/store/settingsStore";
import { SUPPORTED_LOCALES, type AppLocale } from "@/utils/detectLocale";

const LABEL_KEY: Record<AppLocale, string> = {
  en: "general.languageEn",
  "zh-CN": "general.languageZhCN"
};

export function GeneralTab() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);

  return (
    <section className="settings-section">
      <h3>{t("general.languageLabel")}</h3>
      <select
        value={language}
        onChange={(e) => void setLanguage(e.target.value as AppLocale)}
      >
        {SUPPORTED_LOCALES.map((lng) => (
          <option key={lng} value={lng}>
            {t(LABEL_KEY[lng])}
          </option>
        ))}
      </select>
    </section>
  );
}
