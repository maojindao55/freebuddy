export type AppLocale = "en" | "zh-CN";

export const SUPPORTED_LOCALES: AppLocale[] = ["en", "zh-CN"];

export function detectLocale(tag: string | undefined): AppLocale {
  if (!tag) return "en";
  if (tag.toLowerCase().startsWith("zh")) {
    return "zh-CN";
  }
  return "en";
}
