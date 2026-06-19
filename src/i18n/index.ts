import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en.json";
import zhCN from "@/locales/zh-CN.json";
import { detectLocale } from "@/utils/detectLocale";

const initial = detectLocale(
  typeof navigator !== "undefined" ? navigator.language : undefined
);

void i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN }
  },
  lng: initial,
  fallbackLng: "en",
  interpolation: { escapeValue: false }
});

export default i18next;
