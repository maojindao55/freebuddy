import { create } from "zustand";
import i18next from "i18next";
import { cliClient } from "@/services/cli/client";
import { detectLocale, type AppLocale } from "@/utils/detectLocale";

interface SettingsState {
  loaded: boolean;
  language: AppLocale;
  load(): Promise<void>;
  setLanguage(lng: AppLocale): Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  loaded: false,
  language: "en",

  async load() {
    if (!cliClient.isAvailable()) {
      const fallback = detectLocale(navigator.language);
      await i18next.changeLanguage(fallback);
      set({ loaded: true, language: fallback });
      return;
    }
    const stored = await cliClient.getSetting("language");
    const lng: AppLocale =
      stored === "zh-CN" || stored === "en"
        ? stored
        : detectLocale(navigator.language);
    await i18next.changeLanguage(lng);
    set({ loaded: true, language: lng });
  },

  async setLanguage(lng) {
    await i18next.changeLanguage(lng);
    set({ language: lng });
    if (cliClient.isAvailable()) {
      await cliClient.setSetting("language", lng);
    }
  }
}));
