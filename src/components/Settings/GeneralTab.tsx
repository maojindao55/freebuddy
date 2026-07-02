import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/store/settingsStore";
import {
  SUPPORTED_LANGUAGE_PREFERENCES,
  type LanguagePreference
} from "@/utils/detectLocale";
import {
  SUPPORTED_THEME_PREFERENCES,
  type ThemePreference
} from "@/utils/detectTheme";

const LANGUAGE_LABEL_KEY: Record<LanguagePreference, string> = {
  system: "general.languageSystem",
  en: "general.languageEn",
  "zh-CN": "general.languageZhCN"
};

const THEME_LABEL_KEY: Record<ThemePreference, string> = {
  system: "general.themeSystem",
  light: "general.themeLight",
  dark: "general.themeDark"
};

export function GeneralTab() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <>
      <section className="settings-section">
        <h3>{t("general.languageLabel")}</h3>
        <select
          value={language}
          onChange={(e) => void setLanguage(e.target.value as LanguagePreference)}
        >
          {SUPPORTED_LANGUAGE_PREFERENCES.map((lng) => (
            <option key={lng} value={lng}>
              {t(LANGUAGE_LABEL_KEY[lng])}
            </option>
          ))}
        </select>
      </section>

      <section className="settings-section">
        <h3>{t("general.themeLabel")}</h3>
        <select
          value={theme}
          onChange={(e) => void setTheme(e.target.value as ThemePreference)}
        >
          {SUPPORTED_THEME_PREFERENCES.map((value) => (
            <option key={value} value={value}>
              {t(THEME_LABEL_KEY[value])}
            </option>
          ))}
        </select>
      </section>
    </>
  );
}
