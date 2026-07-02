import { app } from "electron";
import { getDb } from "./db.js";

type AppLocale = "en" | "zh-CN";
type LanguagePreference = "system" | AppLocale;

function detectLocale(tag: string | undefined): AppLocale {
  if (!tag) return "en";
  return tag.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function normalizeLanguagePreference(value: string | null): LanguagePreference {
  if (value === "system" || value === "en" || value === "zh-CN") return value;
  return "system";
}

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}

export function getLanguagePreference(): LanguagePreference {
  return normalizeLanguagePreference(getSetting("language"));
}

export function getLanguage(): AppLocale {
  const stored = getLanguagePreference();
  if (stored === "en" || stored === "zh-CN") return stored;
  return detectLocale(app.getLocale());
}
