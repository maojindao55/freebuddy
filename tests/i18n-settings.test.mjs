import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const db = read("../electron/cli/db.ts");
const ipc = read("../electron/cli/ipc.ts");
const preload = read("../electron/preload.ts");
const types = read("../src/types/freebuddy.d.ts");
const client = read("../src/services/cli/client.ts");
const settings = read("../electron/cli/settings.ts");
const settingsStore = read("../src/store/settingsStore.ts");
const generalTab = read("../src/components/Settings/GeneralTab.tsx");
const settingsModal = read("../src/components/Settings/SettingsModal.tsx");
const app = read("../src/App.tsx");
const css = read("../styles.css");
const en = read("../src/locales/en.json");
const zh = read("../src/locales/zh-CN.json");
const enJson = JSON.parse(en);
const zhJson = JSON.parse(zh);

test("app_settings table is created on migration", () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS app_settings/);
  assert.match(db, /key TEXT PRIMARY KEY/);
  assert.match(db, /value TEXT NOT NULL/);
});

test("settings store module exposes get/set + language resolution", () => {
  assert.match(settings, /export function getSetting\(key: string\): string \| null/);
  assert.match(settings, /export function setSetting\(key: string, value: string\)/);
  assert.match(settings, /ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value/);
  assert.match(settings, /export function getLanguagePreference\(\)/);
  assert.match(settings, /export function getLanguage\(\)/);
  assert.match(settings, /normalizeLanguagePreference/);
  assert.match(settings, /detectLocale/);
  assert.match(settings, /app\.getLocale\(\)/);
});

test("settings IPC handlers are registered", () => {
  assert.match(ipc, /"settings:get"/);
  assert.match(ipc, /"settings:set"/);
  assert.match(ipc, /args\.value === "system"/);
  assert.match(ipc, /setApplicationMenuForLanguage\(getLanguage\(\)\)/);
});

test("language setting defaults to following the system", () => {
  assert.match(settingsStore, /language:\s*"system"/);
  assert.match(settingsStore, /resolvedLanguage:\s*"en"/);
  assert.match(settingsStore, /normalizeLanguagePreference\(stored\)/);
  assert.match(settingsStore, /resolveLanguagePreference\(preference, systemLanguage\)/);
  assert.match(generalTab, /SUPPORTED_LANGUAGE_PREFERENCES/);
  assert.match(generalTab, /system:\s*"general\.languageSystem"/);
  assert.match(en, /"languageSystem":\s*"Follow system"/);
  assert.match(zh, /"languageSystem":\s*"跟随系统"/);
});

test("theme setting defaults to following the system", () => {
  assert.match(settingsStore, /theme:\s*"system"/);
  assert.match(settingsStore, /resolvedTheme:\s*getSystemTheme\(\)/);
  assert.match(settingsStore, /normalizeThemePreference\(storedTheme\)/);
  assert.match(settingsStore, /resolveThemePreference\(themePreference, systemTheme\)/);
  assert.match(settingsStore, /cliClient\.getSetting\("theme"\)/);
  assert.match(settingsStore, /cliClient\.setSetting\("theme", theme\)/);
  assert.match(settingsStore, /refreshSystemTheme\(\)/);
  assert.match(generalTab, /SUPPORTED_THEME_PREFERENCES/);
  assert.match(generalTab, /system:\s*"general\.themeSystem"/);
  assert.match(generalTab, /light:\s*"general\.themeLight"/);
  assert.match(generalTab, /dark:\s*"general\.themeDark"/);
  assert.match(app, /import \{ Monitor, Moon, Sun \} from "lucide-react"/);
  assert.match(app, /function nextThemePreference/);
  assert.match(app, /const themePreference = useSettingsStore\(\(s\) => s\.theme\)/);
  assert.match(app, /const theme = useSettingsStore\(\(s\) => s\.resolvedTheme\)/);
  assert.match(app, /prefers-color-scheme: dark/);
  assert.match(app, /data-theme=\{theme\}/);
  assert.match(app, /data-theme-preference=\{themePreference\}/);
  assert.match(app, /nextThemePreference\(themePreference\)/);
  assert.match(app, /themePreference === "system"/);
  assert.match(app, /<Monitor className="footer-icon" strokeWidth=\{1\.7\} \/>/);
  assert.match(app, /<Sun className="footer-icon" strokeWidth=\{1\.7\} \/>/);
  assert.match(app, /<Moon className="footer-icon" strokeWidth=\{1\.7\} \/>/);
  assert.match(css, /\.footer-toggle\[data-theme-preference="system"\]::after/);
  assert.match(css, /background:\s*var\(--fb-brand\)/);
  assert.match(en, /"themeSystem":\s*"Follow system"/);
  assert.match(en, /"themeLight":\s*"Light"/);
  assert.match(en, /"themeDark":\s*"Dark"/);
  assert.match(zh, /"themeLabel":\s*"外观"/);
  assert.match(zh, /"themeLight":\s*"浅色"/);
  assert.match(zh, /"themeDark":\s*"深色"/);
});

test("sidebar version area shows update capsule for available updates", () => {
  assert.match(settingsModal, /export type SettingsTab = "general" \| "cli" \| "workflowTeams" \| "about"/);
  assert.match(settingsModal, /initialTab = "cli"/);
  assert.match(settingsModal, /useState<SettingsTab>\(initialTab\)/);
  assert.match(app, /const \[settingsInitialTab, setSettingsInitialTab\] = useState<SettingsTab>\("cli"\)/);
  assert.match(app, /const updateStatus = useUpdaterStore\(\(s\) => s\.status\)/);
  assert.match(app, /const showUpdateCapsule =/);
  assert.match(app, /updateStatus === "available"/);
  assert.match(app, /updateStatus === "downloading"/);
  assert.match(app, /updateStatus === "downloaded"/);
  assert.match(app, /footer-update-pill/);
  assert.match(app, /onClick=\{\(\) => openSettings\("about"\)\}/);
  assert.match(app, /<SettingsModal\s+initialTab=\{settingsInitialTab\}/);
  assert.doesNotMatch(app, /footer-badge/);
  assert.match(css, /\.footer-version-wrap/);
  assert.match(css, /\.footer-update-pill/);
  assert.match(css, /\.footer-update-pill\.downloaded/);
  assert.equal(enJson.updater.footerUpdate, "Update");
  assert.equal(enJson.updater.footerInstall, "Install");
  assert.equal(enJson.updater.footerOpen, "Open update details");
  assert.equal(zhJson.updater.footerUpdate, "更新");
  assert.equal(zhJson.updater.footerInstall, "安装");
  assert.equal(zhJson.updater.footerOpen, "打开更新详情");
});

test("preload exposes settings get/set", () => {
  assert.match(preload, /getSetting:\s*\(key\)\s*=>\s*ipcRenderer\.invoke\("settings:get"/);
  assert.match(preload, /setSetting:\s*\(key, value\)\s*=>\s*ipcRenderer\.invoke\("settings:set"/);
});

test("global types declare settings API", () => {
  assert.match(types, /interface FreebuddySettings/);
  assert.match(types, /getSetting\(key: string\): Promise<string \| null>/);
  assert.match(types, /setSetting\(key: string, value: string\): Promise<void>/);
  assert.match(types, /settings: FreebuddySettings/);
});

test("cli client exposes settings methods", () => {
  assert.match(client, /getSetting\(key: string\)/);
  assert.match(client, /setSetting\(key: string, value: string\)/);
});
