export type AppLocale = "en" | "zh-CN";
export type LanguagePreference = "system" | AppLocale;

export const SUPPORTED_LOCALES: AppLocale[] = ["en", "zh-CN"];
export const SUPPORTED_LANGUAGE_PREFERENCES: LanguagePreference[] = [
  "system",
  ...SUPPORTED_LOCALES
];

export function detectLocale(tag: string | undefined): AppLocale {
  if (!tag) return "en";
  if (tag.toLowerCase().startsWith("zh")) {
    return "zh-CN";
  }
  return "en";
}

export function normalizeLanguagePreference(
  value: string | null | undefined
): LanguagePreference {
  if (value === "system" || value === "en" || value === "zh-CN") return value;
  return "system";
}

export function resolveLanguagePreference(
  preference: LanguagePreference,
  systemLanguage: string | undefined
): AppLocale {
  return preference === "system" ? detectLocale(systemLanguage) : preference;
}
