/**
 * Builds the debug-log zip bundle: app logs + recent agent session logs
 * (cli-logs) + environment.json, filtered by export mode.
 */
import { app, dialog, type BrowserWindow } from "electron";
import AdmZip from "adm-zip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { debugLogDir, mainLogDroppedLines } from "./debugLog.js";
import { getDataDir, getDb, getLogDir } from "./cli/db.js";
import { getSetting } from "./cli/settings.js";
import {
  buildDshAcpRuntimeDiagnostics,
  cliAdapterDefinitions,
  dshAcpManagedRoot,
  dshHarnessOverlayDir
} from "./cli/adapters.js";
import { LOG_RETENTION_DAYS } from "./shared/debugLogCore.js";
import { buildEnvironmentInfo } from "./shared/environmentInfo.js";
import {
  buildPathMasks,
  filterOwnLogLine,
  filterSessionLogLine,
  type ExportMode,
  type PathMask
} from "./shared/logSanitize.js";
import {
  collapseAcpHistoryReplayLines,
  filterJsonlLinesByTimestamp,
  groupSessionLogEntries,
  localDayRange,
  type TimestampRange
} from "./shared/debugLogExportCore.js";

const SESSION_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_FILES = 20;
const PREVIEW_LINES = 200;
const SELF_CHECK_DIR_PREFIX = "freebuddy-agent-self-check-";
const SELF_CHECK_RETENTION_MS = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** ISO 8601 timestamp in the machine's local timezone, e.g. 2026-07-31T07:18:13.481+08:00. */
function formatLocalTimestamp(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const tz = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `.${String(date.getMilliseconds()).padStart(3, "0")}${tz}`
  );
}

/** Filesystem-safe local stamp for the bundle name, e.g. 2026-07-31T07-18-13-481. */
function localFileStamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}` +
    `-${String(date.getMilliseconds()).padStart(3, "0")}`
  );
}

export interface DebugLogPreviewFile {
  name: string;
  totalLines: number;
  lines: string[];
  truncated: boolean;
}

export interface DebugLogPreview {
  environment: Record<string, unknown>;
  files: DebugLogPreviewFile[];
}

function gatherPathMasks(): PathMask[] {
  const workspaces = new Set<string>();
  try {
    const db = getDb();
    for (const row of db
      .prepare("SELECT DISTINCT cwd FROM conversations WHERE cwd IS NOT NULL")
      .all() as Array<{ cwd: string }>) {
      if (row.cwd) workspaces.add(row.cwd);
    }
    for (const row of db
      .prepare("SELECT DISTINCT cwd FROM cli_tasks WHERE cwd IS NOT NULL")
      .all() as Array<{ cwd: string }>) {
      if (row.cwd) workspaces.add(row.cwd);
    }
  } catch {
    /* masks degrade gracefully */
  }
  return buildPathMasks({
    home: os.homedir(),
    userData: app.getPath("userData"),
    workspaces: [...workspaces]
  });
}

function gatherEnvironment(
  mode: ExportMode,
  exportedAt: string,
  scope: "conversation" | "all"
): Record<string, unknown> {
  let conversationCount = 0;
  try {
    conversationCount = (
      getDb().prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }
    ).n;
  } catch {
    /* keep 0 */
  }
  let locale = "";
  try {
    locale = app.getLocale();
  } catch {
    /* not ready */
  }
  return buildEnvironmentInfo({
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    locale,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    telemetryEnabled: getSetting("telemetry.enabled") !== "0",
    adapters: cliAdapterDefinitions.map((d) => ({ id: d.id, label: d.label })),
    conversationCount,
    droppedLines: mainLogDroppedLines(),
    exportedAt,
    exportMode: mode,
    exportScope: scope
  });
}

function filterLines(lines: string[], kind: "own" | "session", mode: ExportMode, masks: PathMask[]): string[] {
  const filter = kind === "own" ? filterOwnLogLine : filterSessionLogLine;
  return lines.filter((l) => l.trim().length > 0).map((l) => filter(l, mode, masks));
}

function readAppLogFiles(
  mode: ExportMode,
  masks: PathMask[],
  dayRange: TimestampRange
): Array<{ name: string; lines: string[] }> {
  const out: Array<{ name: string; lines: string[] }> = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(debugLogDir());
  } catch {
    return out;
  }
  for (const name of entries.filter((n) => /\.(log)(\.\d+)?$/.test(n)).sort()) {
    try {
      const text = fs.readFileSync(path.join(debugLogDir(), name), "utf8");
      const todayLines = filterJsonlLinesByTimestamp(text.split("\n"), dayRange);
      const lines = filterLines(todayLines, "own", mode, masks);
      if (lines.length > 0) out.push({ name, lines });
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

interface ConversationSessionSelection {
  taskIds: Set<string>;
  toolSessionIdByTask: Map<string, string>;
}

// On failure returns an empty selection so a broken scope filter can never
// leak other conversations' sessions into a conversation-scoped export.
function sessionsForConversation(conversationId: string): ConversationSessionSelection {
  const selection: ConversationSessionSelection = {
    taskIds: new Set<string>(),
    toolSessionIdByTask: new Map<string, string>()
  };
  try {
    const rows = getDb()
      .prepare(
        `SELECT DISTINCT m.task_id, t.tool_session_id
         FROM conversation_messages m
         LEFT JOIN cli_tasks t ON t.id = m.task_id
         WHERE m.conversation_id = ? AND m.task_id IS NOT NULL`
      )
      .all(conversationId) as Array<{ task_id: string; tool_session_id: string | null }>;
    for (const row of rows) {
      if (!row.task_id) continue;
      selection.taskIds.add(row.task_id);
      const toolSessionId = row.tool_session_id?.trim();
      if (toolSessionId) selection.toolSessionIdByTask.set(row.task_id, toolSessionId);
    }
  } catch {
    /* keep empty */
  }
  return selection;
}

function safeSessionLogName(logicalSessionId: string): string {
  const safe = logicalSessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  return `${safe || "session"}.jsonl`;
}

function readSessionLogFiles(
  mode: ExportMode,
  masks: PathMask[],
  conversationId?: string
): Array<{ name: string; lines: string[] }> {
  const out: Array<{ name: string; lines: string[] }> = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(getLogDir()).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return out;
  }
  let toolSessionIdByTask = new Map<string, string>();
  if (conversationId) {
    const selection = sessionsForConversation(conversationId);
    toolSessionIdByTask = selection.toolSessionIdByTask;
    names = names.filter((n) => selection.taskIds.has(n.replace(/\.jsonl$/, "")));
  }
  const stat: Array<{ taskId: string; name: string; mtimeMs: number }> = [];
  const recencyCutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000; // sessions are "近 7 天"
  for (const name of names) {
    try {
      const mtimeMs = fs.statSync(path.join(getLogDir(), name)).mtimeMs;
      if (mtimeMs < recencyCutoff) continue;
      stat.push({ taskId: name.replace(/\.jsonl$/, ""), name, mtimeMs });
    } catch {
      /* file deleted or unreadable mid-scan — skip it, keep the rest */
    }
  }
  const groups = groupSessionLogEntries(
    stat,
    toolSessionIdByTask,
    MAX_SESSION_FILES
  );
  for (const group of groups) {
    const mergedLines: string[] = [];
    for (const { name } of group.entries) {
      const file = path.join(getLogDir(), name);
      try {
        const size = fs.statSync(file).size;
        let text: string;
        let truncated = false;
        // Full exports/self-checks need the prompt and initialization evidence too.
        if (mode !== "full" && size > SESSION_TAIL_BYTES) {
          const fd = fs.openSync(file, "r");
          try {
            const buf = Buffer.alloc(SESSION_TAIL_BYTES);
            const bytesRead = fs.readSync(fd, buf, 0, SESSION_TAIL_BYTES, size - SESSION_TAIL_BYTES);
            text = buf.subarray(0, bytesRead).toString("utf8");
          } finally {
            fs.closeSync(fd);
          }
          const idx = text.indexOf("\n");
          if (idx >= 0) text = text.slice(idx + 1); // drop partial first line
          truncated = true;
        } else {
          text = fs.readFileSync(file, "utf8");
        }
        const compacted = collapseAcpHistoryReplayLines(text.split("\n"));
        const lines = filterLines(compacted, "session", mode, masks);
        if (truncated) {
          lines.unshift(
            JSON.stringify({
              type: "system",
              content: `[export] ${name} truncated to last 2MB`
            })
          );
        }
        mergedLines.push(...lines);
      } catch {
        /* skip unreadable file */
      }
    }
    if (mergedLines.length > 0) {
      out.push({ name: safeSessionLogName(group.logicalSessionId), lines: mergedLines });
    }
  }
  return out;
}

function gatherDshAcpRuntime(): Record<string, unknown> {
  try {
    return {
      ...buildDshAcpRuntimeDiagnostics({
        runtimeRoot: dshAcpManagedRoot(getDataDir()),
        overlayDir: dshHarnessOverlayDir()
      })
    };
  } catch (err) {
    return { error: (err as Error)?.message ?? String(err) };
  }
}

function collectBundle(mode: ExportMode, exportedAt: string, conversationId?: string) {
  const masks = gatherPathMasks();
  const dayRange = localDayRange(new Date(exportedAt));
  return {
    environment: gatherEnvironment(mode, exportedAt, conversationId ? "conversation" : "all"),
    dshAcpRuntime: gatherDshAcpRuntime(),
    appLogs: readAppLogFiles(mode, masks, dayRange),
    sessionLogs: readSessionLogFiles(mode, masks, conversationId)
  };
}

export async function buildDebugLogPreview(
  mode: ExportMode,
  conversationId?: string
): Promise<DebugLogPreview> {
  const { environment, appLogs, sessionLogs } = collectBundle(
    mode,
    formatLocalTimestamp(new Date()),
    conversationId
  );
  const files: DebugLogPreviewFile[] = [...appLogs, ...sessionLogs].map((f) => ({
    name: f.name,
    totalLines: f.lines.length,
    lines: f.lines.slice(-PREVIEW_LINES),
    truncated: f.lines.length > PREVIEW_LINES
  }));
  return { environment, files };
}

function cleanupStaleSelfCheckDirectories(now = Date.now()): void {
  const tempRoot = os.tmpdir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(tempRoot);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(SELF_CHECK_DIR_PREFIX)) continue;
    const candidate = path.join(tempRoot, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        now - stat.mtimeMs > SELF_CHECK_RETENTION_MS
      ) {
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    } catch {
      /* stale cleanup is best-effort */
    }
  }
}

export async function prepareAgentSelfCheckLogs(
  conversationId: string
): Promise<{ path: string }> {
  const exportedAt = formatLocalTimestamp(new Date());
  const { environment, dshAcpRuntime, appLogs, sessionLogs } = collectBundle(
    "full",
    exportedAt,
    conversationId
  );
  cleanupStaleSelfCheckDirectories();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), SELF_CHECK_DIR_PREFIX));
  try {
    try {
      fs.chmodSync(target, 0o700);
    } catch {
      /* Windows may not apply POSIX modes */
    }
    const logsDir = path.join(target, "logs");
    const sessionsDir = path.join(target, "sessions");
    fs.mkdirSync(logsDir, { mode: 0o700 });
    fs.mkdirSync(sessionsDir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(target, "environment.json"),
      JSON.stringify(environment, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(target, "dsh-acp-runtime.json"),
      JSON.stringify(dshAcpRuntime, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(target, "README.txt"),
      [
        readmeText("full", exportedAt, "conversation"),
        "This temporary directory was created for Agent self-check."
      ].join("\n\n"),
      { encoding: "utf8", mode: 0o600 }
    );
    for (const file of appLogs) {
      fs.writeFileSync(path.join(logsDir, file.name), file.lines.join("\n") + "\n", {
        encoding: "utf8",
        mode: 0o600
      });
    }
    for (const file of sessionLogs) {
      fs.writeFileSync(path.join(sessionsDir, file.name), file.lines.join("\n") + "\n", {
        encoding: "utf8",
        mode: 0o600
      });
    }
    return { path: target };
  } catch (err) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* preserve the original write error */
    }
    throw err;
  }
}

function readmeText(mode: ExportMode, exportedAt: string, scope: "conversation" | "all"): string {
  return [
    "FreeBuddy debug log bundle",
    `Exported at: ${exportedAt}`,
    `Mode: ${mode}${mode === "standard" ? " (message content and paths redacted)" : " (FULL — contains conversation content)"}`,
    `Scope: ${scope === "conversation" ? "current conversation only (sessions/)" : "all recent sessions"}`,
    "",
    "logs/       app logs from the export day (JSONL: {ts, level, scope, msg, data?})",
    "sessions/   agent session transcripts (JSONL: {ts, type, content})",
    "environment.json  environment snapshot",
    "dsh-acp-runtime.json  DeepSeek ACP overlay / koffi / cordis snapshot",
    "",
    "Please attach this file to a GitHub issue or send it to the developers."
  ].join("\n");
}

export async function exportDebugLogs(
  parent: BrowserWindow,
  mode: ExportMode,
  conversationId?: string
): Promise<{ path?: string; canceled?: boolean }> {
  const now = new Date();
  const exportedAt = formatLocalTimestamp(now);
  const stamp = localFileStamp(now);
  const result = await dialog.showSaveDialog(parent, {
    title: "Export debug logs",
    defaultPath: path.join(app.getPath("downloads"), `freebuddy-debug-${stamp}.zip`),
    filters: [{ name: "Zip archive", extensions: ["zip"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  let zip: AdmZip;
  try {
    const { environment, dshAcpRuntime, appLogs, sessionLogs } = collectBundle(mode, exportedAt, conversationId);
    zip = new AdmZip();
    zip.addFile("environment.json", Buffer.from(JSON.stringify(environment, null, 2)));
    zip.addFile("dsh-acp-runtime.json", Buffer.from(JSON.stringify(dshAcpRuntime, null, 2)));
    zip.addFile(
      "README.txt",
      Buffer.from(readmeText(mode, exportedAt, conversationId ? "conversation" : "all"))
    );
    for (const f of appLogs) {
      zip.addFile(`logs/${f.name}`, Buffer.from(f.lines.join("\n") + "\n"));
    }
    for (const f of sessionLogs) {
      zip.addFile(`sessions/${f.name}`, Buffer.from(f.lines.join("\n") + "\n"));
    }
  } catch (err) {
    // Bundle assembly failed before we touched the target path — surface a
    // readable cause but do NOT delete anything at result.filePath: the user
    // may have picked a pre-existing file we never wrote to.
    const message = (err as Error)?.message ?? String(err);
    throw new Error(message, { cause: err });
  }
  const preExisted = fs.existsSync(result.filePath);
  try {
    zip.writeZip(result.filePath);
  } catch (err) {
    // best-effort cleanup of the partial zip we created, then surface a readable
    // cause — but only if the target didn't pre-exist: if writeZip failed on a
    // pre-existing user file before truncating it, don't delete their file
    if (!preExisted) {
      try {
        fs.rmSync(result.filePath, { force: true });
      } catch {
        /* cleanup failed — leave the partial file */
      }
    }
    const message = (err as Error)?.message ?? String(err);
    throw new Error(message, { cause: err });
  }
  return { path: result.filePath };
}
