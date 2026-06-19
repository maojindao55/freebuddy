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

test("app_settings table is created on migration", () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS app_settings/);
  assert.match(db, /key TEXT PRIMARY KEY/);
  assert.match(db, /value TEXT NOT NULL/);
});

test("settings store module exposes get/set + language resolution", () => {
  assert.match(settings, /export function getSetting\(key: string\): string \| null/);
  assert.match(settings, /export function setSetting\(key: string, value: string\)/);
  assert.match(settings, /ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value/);
  assert.match(settings, /export function getLanguage\(\)/);
  assert.match(settings, /detectLocale/);
  assert.match(settings, /app\.getLocale\(\)/);
});

test("settings IPC handlers are registered", () => {
  assert.match(ipc, /"settings:get"/);
  assert.match(ipc, /"settings:set"/);
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
