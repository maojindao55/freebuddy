import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(
  new URL("../src/utils/detectLocale.ts", import.meta.url),
  "utf8"
);
const themeSrc = fs.readFileSync(
  new URL("../src/utils/detectTheme.ts", import.meta.url),
  "utf8"
);

test("detectLocale exports supported locales and maps zh-prefix to zh-CN", () => {
  assert.match(src, /export type AppLocale = "en" \| "zh-CN"/);
  assert.match(src, /export type LanguagePreference = "system" \| AppLocale/);
  assert.match(src, /export const SUPPORTED_LOCALES/);
  assert.match(src, /export const SUPPORTED_LANGUAGE_PREFERENCES/);
  assert.match(src, /export function detectLocale\(tag: string \| undefined\)/);
  assert.match(src, /export function normalizeLanguagePreference/);
  assert.match(src, /export function resolveLanguagePreference/);
  assert.match(src, /\.toLowerCase\(\)/);
  assert.match(src, /startsWith\("zh"\)/);
  assert.match(src, /return "system"/);
  assert.match(src, /return "zh-CN"/);
  assert.match(src, /return "en"/);
});

test("detectTheme exports theme preferences and resolves system themes", () => {
  assert.match(themeSrc, /export type ResolvedTheme = "light" \| "dark"/);
  assert.match(themeSrc, /export type ThemePreference = "system" \| ResolvedTheme/);
  assert.match(themeSrc, /export const SUPPORTED_THEME_PREFERENCES/);
  assert.match(themeSrc, /export function detectTheme/);
  assert.match(themeSrc, /export function getSystemTheme/);
  assert.match(themeSrc, /prefers-color-scheme: dark/);
  assert.match(themeSrc, /export function normalizeThemePreference/);
  assert.match(themeSrc, /export function resolveThemePreference/);
  assert.match(themeSrc, /return "system"/);
  assert.match(themeSrc, /return "light"/);
  assert.match(themeSrc, /\? "dark" : "light"/);
});
