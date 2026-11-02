import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const ipc = read("../electron/cli/ipc.ts");
const preload = read("../electron/preload.ts");
const types = read("../src/types/freebuddy.d.ts");
const policy = read("../electron/shared/remoteChannelPolicy.ts");
const main = read("../electron/main.ts");
const debugLog = read("../electron/debugLog.ts");
const exporter = read("../electron/debugLogExport.ts");
const runtimeShared = read("../electron/cli/runtimeShared.ts");
const db = read("../electron/cli/db.ts");
const aboutTab = read("../src/components/Settings/AboutTab.tsx");
const streamItem = read("../src/components/CLI/StreamItem.tsx");
const app = read("../src/App.tsx");
const updater = read("../electron/updater.ts");
const conversationStore = read("../src/store/conversationStore.ts");
const mainEntry = read("../src/main.tsx");

test("debug log IPC channels are registered and exposed via preload", () => {
  assert.match(ipc, /registerHandler\("debugLog:write"/);
  assert.match(ipc, /registerHandler\("debugLogs:preview"/);
  assert.match(ipc, /registerHandler\("debugLogs:export"/);
  assert.match(preload, /ipcRenderer\.invoke\("debugLog:write"/);
  assert.match(preload, /ipcRenderer\.invoke\("debugLogs:preview"/);
  assert.match(preload, /ipcRenderer\.invoke\("debugLogs:export"/);
  assert.match(preload, /^\s+debugLogs,$/m);
  assert.match(types, /FreebuddyDebugLogs/);
});

test("debug log channels are explicitly denied for remote callers (privacy)", () => {
  const denyMatch = policy.match(/const DENY = \[([\s\S]*?)\]/);
  assert.ok(denyMatch, "DENY array exists in remoteChannelPolicy");
  const denyList = denyMatch[1];
  assert.ok(denyList.includes('"debugLog:write"'));
  assert.ok(denyList.includes('"debugLogs:preview"'));
  assert.ok(denyList.includes('"debugLogs:export"'));
});

test("main process logger initializes with crash hooks", () => {
  assert.match(main, /initDebugLog\(\)/);
  assert.match(main, /render-process-gone/);
  assert.match(debugLog, /uncaughtException/);
  assert.match(debugLog, /unhandledRejection/);
});

test("export bundle filters by mode and includes sessions", () => {
  assert.match(exporter, /filterSessionLogLine/);
  assert.match(exporter, /filterOwnLogLine/);
  assert.match(exporter, /sessions\/\$\{f\.name\}/);
  assert.match(exporter, /environment\.json/);
  assert.match(exporter, /dsh-acp-runtime\.json/);
  assert.match(exporter, /buildDshAcpRuntimeDiagnostics/);
  assert.match(exporter, /dialog\.showSaveDialog/);
});

test("app logs are limited to the local export day without changing session scope", () => {
  assert.match(exporter, /localDayRange\(new Date\(exportedAt\)\)/);
  assert.match(exporter, /filterJsonlLinesByTimestamp\(text\.split\("\\n"\), dayRange\)/);
  assert.match(exporter, /if \(lines\.length > 0\) out\.push/);
  assert.match(exporter, /readSessionLogFiles\(mode, masks, conversationId\)/);
});

test("conversation-scoped export filters task logs and merges their resumable session", () => {
  assert.match(exporter, /function sessionsForConversation/);
  assert.match(
    exporter,
    /SELECT DISTINCT m\.task_id, t\.tool_session_id/
  );
  assert.match(exporter, /LEFT JOIN cli_tasks t ON t\.id = m\.task_id/);
  assert.match(exporter, /selection\.taskIds\.has\(n\.replace\(\/\\\.jsonl\$\/, ""\)\)/);
  assert.match(exporter, /groupSessionLogEntries/);
  assert.match(exporter, /collapseAcpHistoryReplayLines/);
  assert.match(exporter, /exportScope: scope/);
  // IPC + preload thread the optional conversationId through to the exporter.
  assert.match(ipc, /"debugLogs:preview", \(_event, mode: unknown, conversationId: unknown\)/);
  assert.match(ipc, /"debugLogs:export", \(event, mode: unknown, conversationId: unknown\)/);
  assert.match(preload, /invoke\("debugLogs:preview", mode, opts\?\.conversationId\)/);
  assert.match(preload, /invoke\("debugLogs:export", mode, opts\?\.conversationId\)/);
});

test("chat entry points scope the export to the active conversation; About does not", () => {
  assert.match(streamItem, /setOpen\(true, useConversationStore\.getState\(\)\.activeId \?\? undefined\)/);
  assert.match(app, /setOpen\(true, activeConversation\?\.id\)/);
  assert.match(aboutTab, /setDebugLogsOpen\(true\)/);
  assert.doesNotMatch(aboutTab, /setDebugLogsOpen\(true, /);
});

test("session logs are secret-redacted at write time and pruned", () => {
  assert.match(runtimeShared, /redactsecrets/);
  assert.match(db, /pruneOldLogs/);
});

test("three entry points mount the export dialog", () => {
  assert.match(app, /ExportDebugLogsDialog/);
  assert.match(aboutTab, /debugLogs\.aboutSectionTitle/);
  assert.match(streamItem, /debugLogs\.exportLink/);
  assert.match(app, /debugLogs\.title/);
  assert.match(aboutTab, /useDebugLogsDialogStore/);
  assert.match(streamItem, /useDebugLogsDialogStore/);
  assert.match(app, /useDebugLogsDialogStore/);
});

test("renderer logger installs global hooks and instruments run failures", () => {
  assert.match(mainEntry, /installDebugLogClient/);
  assert.match(conversationStore, /debugLogClient\.error/);
});

test("updater lifecycle events are logged", () => {
  assert.match(updater, /logMain\(\)\.info\("updater", "checking for update"\)/);
  assert.match(updater, /logMain\(\)\.error\("updater", "update error"/);
});
