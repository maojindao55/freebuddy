export type ResolvedTheme = "light" | "dark";
export type ThemePreference = "system" | ResolvedTheme;

export const SUPPORTED_THEME_PREFERENCES: ThemePreference[] = [
  "system",
  "light",
  "dark"
];

export function detectTheme(prefersDark: boolean | undefined): ResolvedTheme {
  return prefersDark ? "dark" : "light";
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return detectTheme(window.matchMedia("(prefers-color-scheme: dark)").matches);
}

export function normalizeThemePreference(
  value: string | null | undefined
): ThemePreference {
  if (value === "system" || value === "light" || value === "dark") return value;
  return "system";
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemTheme: ResolvedTheme
): ResolvedTheme {
  return preference === "system" ? systemTheme : preference;
}
