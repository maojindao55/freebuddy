import { create } from "zustand";
import i18next from "i18next";
import { cliClient } from "@/services/cli/client";
import {
  normalizeLanguagePreference,
  resolveLanguagePreference,
  type AppLocale,
  type LanguagePreference
} from "@/utils/detectLocale";
import {
  getSystemTheme,
  normalizeThemePreference,
  resolveThemePreference,
  type ResolvedTheme,
  type ThemePreference
} from "@/utils/detectTheme";

interface SettingsState {
  loaded: boolean;
  language: LanguagePreference;
  resolvedLanguage: AppLocale;
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  load(): Promise<void>;
  setLanguage(lng: LanguagePreference): Promise<void>;
  setTheme(theme: ThemePreference): Promise<void>;
  refreshSystemTheme(): void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  loaded: false,
  language: "system",
  resolvedLanguage: "en",
  theme: "system",
  resolvedTheme: getSystemTheme(),

  async load() {
    const systemLanguage =
      typeof navigator !== "undefined" ? navigator.language : undefined;
    const systemTheme = getSystemTheme();
    if (!cliClient.isAvailable()) {
      const resolved = resolveLanguagePreference("system", systemLanguage);
      await i18next.changeLanguage(resolved);
      set({
        loaded: true,
        language: "system",
        resolvedLanguage: resolved,
        theme: "system",
        resolvedTheme: resolveThemePreference("system", systemTheme)
      });
      return;
    }
    const stored = await cliClient.getSetting("language");
    const preference = normalizeLanguagePreference(stored);
    const resolved = resolveLanguagePreference(preference, systemLanguage);
    const storedTheme = await cliClient.getSetting("theme");
    const themePreference = normalizeThemePreference(storedTheme);
    const resolvedTheme = resolveThemePreference(themePreference, systemTheme);
    await i18next.changeLanguage(resolved);
    set({
      loaded: true,
      language: preference,
      resolvedLanguage: resolved,
      theme: themePreference,
      resolvedTheme
    });
  },

  async setLanguage(lng) {
    const systemLanguage =
      typeof navigator !== "undefined" ? navigator.language : undefined;
    const resolved = resolveLanguagePreference(lng, systemLanguage);
    await i18next.changeLanguage(resolved);
    set({ language: lng, resolvedLanguage: resolved });
    if (cliClient.isAvailable()) {
      await cliClient.setSetting("language", lng);
    }
  },

  async setTheme(theme) {
    const resolvedTheme = resolveThemePreference(theme, getSystemTheme());
    set({ theme, resolvedTheme });
    if (cliClient.isAvailable()) {
      await cliClient.setSetting("theme", theme);
    }
  },

  refreshSystemTheme() {
    const systemTheme = getSystemTheme();
    set((state) => ({
      resolvedTheme: resolveThemePreference(state.theme, systemTheme)
    }));
  }
}));
