import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ignore from "ignore";
import type { FileEditContent, FileEditPage } from "@freebuddy/protocol";
import { getDb } from "./db.js";
import { requireOwnedConversation } from "./conversations.js";

const git = promisify(execFile);
const DEFAULT_LIMITS = { fileBytes: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, entries: 50_000, milliseconds: 2000 };
type Limits = typeof DEFAULT_LIMITS;
type Version = { state: "absent" | "captured" | "unavailable"; hash?: string; bytes?: number; reason?: "binary" | "large" | "unavailable"; blob?: string };
type Root = { path: string; complete: boolean; directories?: Record<string, string[]> };
type Row = { path: string; identity: string; before_version: string; after_version: string | null; changed: number };
type Run = { task_id: string; conversation_id: string; owner_key: string; roots: string; state: string; complete: number; overlapping: number };
export type TurnFileCapture = {
  db: ReturnType<typeof getDb>; taskId: string; conversationId: string; owner: string;
  roots: Root[]; limits: Limits; complete: boolean; finished: boolean;
};
const active = new Map<string, TurnFileCapture>();
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const snapshotPathIdentity = (filePath: string) => {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};
const within = (filePath: string, root: string) => {
  const relative = path.relative(root, filePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const overlap = (a: Root[], b: Root[]) => a.some(x => b.some(y => within(x.path, y.path) || within(y.path, x.path)));
const entryName = (name: string) => process.platform === "win32" ? name.toLowerCase() : name;
export const turnFileSnapshotsEnabled = () => process.env.FREEBUDDY_FILE_SNAPSHOTS === "1";

async function rememberDirectories(root: Root, files: Map<string, string>, limits: Limits, deadline: number) {
  const directories = new Set([root.path]);
  for (const filePath of files.values()) {
    let directory = path.dirname(filePath);
    while (within(directory, root.path)) {
      directories.add(directory);
      if (directory === root.path) break;
      directory = path.dirname(directory);
    }
  }
  root.directories = {};
  let entries = 0;
  for (const directory of directories) {
    if (Date.now() >= deadline) { root.complete = false; break; }
    try {
      if (!within(await fs.realpath(directory), root.path)) continue;
      const names: string[] = [];
      for await (const entry of await fs.opendir(directory)) {
        if (++entries > limits.entries || Date.now() >= deadline) { root.complete = false; break; }
        names.push(entry.name);
      }
      if (!root.complete) break;
      root.directories[snapshotPathIdentity(directory)] = names.map(entryName);
    } catch { root.complete = false; }
  }
}

// An enumerated Git/non-Git scope excludes ignored files. A directory listing
// from the start distinguishes truly new paths from files unignored mid-turn.
function absentAtStart(filePath: string, roots: Root[]): boolean {
  for (const root of roots) {
    if (!root.complete || !within(filePath, root.path)) continue;
    let child = filePath;
    while (child !== root.path) {
      const parent = path.dirname(child);
      const names = root.directories?.[snapshotPathIdentity(parent)];
      if (names && !names.includes(entryName(path.basename(child)))) return true;
      child = parent;
    }
  }
  return false;
}

// Enumeration proves absence only within a root that completed at the start.
async function enumerate(root: Root, limits: Limits, deadline: number): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  root.complete = true;
  const add = (filePath: string) => {
    if (!within(filePath, root.path) || files.size >= limits.entries || Date.now() >= deadline) { root.complete = false; return false; }
    files.set(snapshotPathIdentity(filePath), filePath);
    return true;
  };
  try {
    const result = await git("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], {
      cwd: root.path, encoding: "utf8", windowsHide: true, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 8 * 1024 * 1024
    });
    for (const entry of result.stdout.split("\0")) {
      if (entry && !add(path.resolve(root.path, entry))) break;
    }
    return files;
  } catch (error) {
    // A missing Git repository uses the same bounded scanner as a non-Git project.
    if (Date.now() >= deadline) { root.complete = false; return files; }
  }
  type Rule = { base: string; matcher: ReturnType<typeof ignore> };
  const excluded = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__"]);
  let visited = 0;
  const walk = async (directory: string, inherited: Rule[]) => {
    if (Date.now() >= deadline || files.size >= limits.entries) { root.complete = false; return; }
    let rules = inherited;
    try {
      const ignoreFile = path.join(directory, ".gitignore");
      const stat = await fs.lstat(ignoreFile);
      if (stat.isSymbolicLink() || stat.size > 256 * 1024) { root.complete = false; return; }
      const body = await fs.readFile(ignoreFile, "utf8");
      rules = [...rules, { base: directory, matcher: ignore().add(body) }];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") root.complete = false;
    }
    try {
      for await (const entry of await fs.opendir(directory)) {
        if (Date.now() >= deadline || ++visited > limits.entries || files.size >= limits.entries) { root.complete = false; break; }
        if (entry.isSymbolicLink() || excluded.has(entry.name)) continue;
        const filePath = path.join(directory, entry.name);
        let ignored = false;
        for (const rule of rules) {
          const result = rule.matcher.test(path.relative(rule.base, filePath).replace(/\\/g, "/") + (entry.isDirectory() ? "/" : ""));
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
        if (ignored) continue;
        if (entry.isDirectory()) await walk(filePath, rules);
        else if (entry.isFile()) add(filePath);
      }
    } catch { root.complete = false; }
  };
  await walk(root.path, []);
  return files;
}

async function captureVersion(filePath: string, roots: Root[], owner: string, budget: { bytes: number }, limits: Limits, deadline: number): Promise<{ version: Version; body?: Buffer }> {
  if (Date.now() >= deadline) return { version: { state: "unavailable", reason: "unavailable" } };
  try {
    // Never follow a replaced symlink outside the authorized workspace.
    if ((await fs.lstat(filePath)).isSymbolicLink()) return { version: { state: "unavailable", reason: "unavailable" } };
    const real = await fs.realpath(filePath);
    if (!roots.some(root => within(real, root.path))) return { version: { state: "unavailable", reason: "unavailable" } };
    const handle = await fs.open(real, "r");
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await handle.stat();
        if (!before.isFile()) return { version: { state: "unavailable", reason: "unavailable" } };
        if (before.size > limits.fileBytes || before.size > budget.bytes) return { version: { state: "unavailable", bytes: before.size, reason: "large" } };
        const body = Buffer.alloc(before.size + 1);
        let bytes = 0;
        while (bytes < body.length && Date.now() < deadline) {
          const result = await handle.read(body, bytes, Math.min(65536, body.length - bytes), bytes);
          if (!result.bytesRead) break;
          bytes += result.bytesRead;
        }
        const after = await handle.stat();
        const current = await fs.stat(real);
        if (Date.now() >= deadline) return { version: { state: "unavailable", reason: "unavailable" } };
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          bytes !== after.size || current.ino !== after.ino || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) continue;
        const contents = body.subarray(0, bytes);
        budget.bytes -= bytes;
        const hash = digest(contents);
        try {
          if (contents.includes(0)) throw new Error("binary");
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contents);
        } catch { return { version: { state: "unavailable", hash, bytes, reason: "binary" } }; }
        return { version: { state: "captured", hash, bytes, blob: digest(`${owner}\0${hash}`) }, body: contents };
      }
      return { version: { state: "unavailable", reason: "unavailable" } };
    } finally { await handle.close(); }
  } catch (error) {
    // ENOENT is an observed absent file, unlike unreadable or excluded files.
    return { version: (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unavailable", reason: "unavailable" } };
  }
}

function saveBlob(capture: TurnFileCapture, version: Version, body?: Buffer) {
  if (version.blob && body) capture.db.prepare("INSERT OR IGNORE INTO file_version_blobs(blob_key, owner_key, payload) VALUES (?, ?, ?)").run(version.blob, capture.owner, body);
}

/** Called once, before any prompt is sent. Errors degrade capture, never the agent run. */
export async function prepareTurnFileCapture(args: { conversationId: string; taskId: string; roots: string[]; limits?: Partial<Limits> }): Promise<TurnFileCapture | undefined> {
  const db = getDb();
  const conversation = requireOwnedConversation(args.conversationId);
  if (!conversation) return;
  if (db.prepare("SELECT 1 FROM turn_file_capture_runs WHERE task_id = ?").get(args.taskId)) return;
  const roots: Root[] = [];
  let rootsComplete = true;
  for (const root of [...new Set(args.roots)].sort((a, b) => a.length - b.length)) {
    try {
      const real = await fs.realpath(root);
      if ((await fs.stat(real)).isDirectory() && !roots.some(existing => within(real, existing.path))) roots.push({ path: real, complete: false });
    } catch { rootsComplete = false; }
  }
  const capture: TurnFileCapture = { db, taskId: args.taskId, conversationId: args.conversationId, owner: conversation.ownerId ?? "local", roots,
    limits: { ...DEFAULT_LIMITS, ...args.limits }, complete: roots.length > 0 && rootsComplete, finished: false };
  db.prepare(`INSERT INTO turn_file_capture_runs(task_id, conversation_id, owner_key, roots, state, started_at) VALUES (?, ?, ?, ?, 'preparing', ?)`)
    .run(capture.taskId, capture.conversationId, capture.owner, JSON.stringify(roots), Date.now());
  for (const other of active.values()) {
    if (other.db !== db || !overlap(roots, other.roots)) continue;
    db.prepare("UPDATE turn_file_capture_runs SET overlapping = 1 WHERE task_id IN (?, ?)").run(capture.taskId, other.taskId);
  }
  active.set(capture.taskId, capture);
  const deadline = Date.now() + capture.limits.milliseconds;
  const budget = { bytes: capture.limits.totalBytes };
  const candidates = new Map<string, string>();
  try {
    for (const root of roots) {
      const files = await enumerate(root, { ...capture.limits, entries: Math.max(0, capture.limits.entries - candidates.size) }, deadline);
      await rememberDirectories(root, files, capture.limits, deadline);
      for (const [identity, filePath] of files) candidates.set(identity, filePath);
      capture.complete &&= root.complete;
    }
    for (const [identity, filePath] of candidates) {
      const { version, body } = await captureVersion(filePath, roots, capture.owner, budget, capture.limits, deadline);
      if (version.state === "unavailable" && !version.hash) capture.complete = false;
      db.transaction(() => {
        saveBlob(capture, version, body);
        db.prepare("INSERT INTO turn_file_versions(task_id, path, identity, before_version, before_blob) VALUES (?, ?, ?, ?, ?)")
          .run(capture.taskId, filePath, identity, JSON.stringify(version), version.blob ?? null);
      })();
    }
    db.prepare("UPDATE turn_file_capture_runs SET state = 'running', complete = ?, roots = ? WHERE task_id = ?")
      .run(Number(capture.complete), JSON.stringify(roots), capture.taskId);
    return capture;
  } catch (error) {
    capture.complete = false;
    db.prepare("UPDATE turn_file_capture_runs SET state = 'running', complete = 0, roots = ?, reason = ? WHERE task_id = ?")
      .run(JSON.stringify(roots.map(root => ({ ...root, complete: false }))), String(error), capture.taskId);
    roots.forEach(root => { root.complete = false; });
    return capture;
  }
}

export async function finalizeTurnFileCapture(capture: TurnFileCapture, uncertain = false): Promise<void> {
  if (capture.finished) return;
  capture.finished = true;
  const { db, taskId } = capture;
  // Conversation deletion can race asynchronous filesystem reads.
  if (!db.prepare("SELECT 1 FROM turn_file_capture_runs WHERE task_id = ?").get(taskId)) { active.delete(taskId); return; }
  db.prepare("UPDATE turn_file_capture_runs SET state = 'finalizing' WHERE task_id = ?").run(taskId);
  const deadline = Date.now() + capture.limits.milliseconds;
  const budget = { bytes: capture.limits.totalBytes };
  let complete = capture.complete && !uncertain;
  try {
    const saved = db.prepare("SELECT path, identity, before_version, after_version, changed FROM turn_file_versions WHERE task_id = ?").all(taskId) as Row[];
    const rows = new Map(saved.map(row => [row.identity, row]));
    const candidates = new Map(saved.map(row => [row.identity, row.path]));
    for (const root of capture.roots) {
      const endRoot = { ...root };
      for (const [identity, filePath] of await enumerate(endRoot, capture.limits, deadline)) {
        if (!candidates.has(identity) && candidates.size >= capture.limits.entries) { complete = false; break; }
        candidates.set(identity, filePath);
      }
      complete &&= endRoot.complete;
    }
    for (const [identity, filePath] of candidates) {
      const original = rows.get(identity);
      const before: Version = original ? JSON.parse(original.before_version) : absentAtStart(filePath, capture.roots)
        ? { state: "absent" } : { state: "unavailable", reason: "unavailable" };
      const { version: after, body } = await captureVersion(filePath, capture.roots, capture.owner, budget, capture.limits, deadline);
      const same = before.state === "absent" && after.state === "absent" || !!before.hash && before.hash === after.hash;
      if (before.state === "unavailable" && !before.hash || after.state === "unavailable" && !after.hash) complete = false;
      db.transaction(() => {
        if (!db.prepare("SELECT 1 FROM turn_file_capture_runs WHERE task_id = ?").get(taskId)) return;
        if (!same) saveBlob(capture, after, body);
        db.prepare(`INSERT INTO turn_file_versions(task_id, path, identity, before_version, after_version, before_blob, after_blob, changed)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, identity) DO UPDATE SET
          after_version = excluded.after_version, before_blob = excluded.before_blob, after_blob = excluded.after_blob, changed = excluded.changed`)
          .run(taskId, filePath, identity, JSON.stringify(before), JSON.stringify(after), same ? null : before.blob ?? null, same ? null : after.blob ?? null, Number(!same));
      })();
    }
    db.prepare("UPDATE turn_file_capture_runs SET state = ?, complete = ?, sealed_at = ? WHERE task_id = ?")
      .run(complete ? "ready" : "incomplete", Number(complete), Date.now(), taskId);
  } catch (error) {
    db.prepare("UPDATE turn_file_capture_runs SET state = 'incomplete', complete = 0, sealed_at = ?, reason = ? WHERE task_id = ?").run(Date.now(), String(error), taskId);
  } finally { active.delete(taskId); }
}

const pairKey = (messageId: string, run: Run, row: Row) => digest(JSON.stringify(["file-versions-v1", messageId, run.conversation_id, run.task_id, row.identity, row.before_version, row.after_version]));
export function snapshotIndex(messageId: string, conversationId: string, taskId: string): {
  edits: FileEditPage["edits"]; identities: Set<string>; roots: Root[]; capture: NonNullable<FileEditPage["capture"]>;
} | undefined {
  const db = getDb();
  const run = db.prepare("SELECT * FROM turn_file_capture_runs WHERE conversation_id = ? AND task_id = ?").get(conversationId, taskId) as Run | undefined;
  if (!run) return;
  const sealed = run.state === "ready" || run.state === "incomplete";
  const capture: NonNullable<FileEditPage["capture"]> = { state: sealed ? run.state as "ready" | "incomplete" : active.has(taskId) ? "finalizing" : "incomplete",
    complete: sealed && !!run.complete, overlapping: !!run.overlapping };
  const roots = JSON.parse(run.roots) as Root[];
  if (!sealed) return { edits: [], identities: new Set(), roots, capture };
  // Deliberately excludes payloads. Hash/existence comparisons were done at seal time.
  const rows = db.prepare("SELECT path, identity, before_version, after_version, changed FROM turn_file_versions WHERE task_id = ? ORDER BY identity").all(taskId) as Row[];
  const identities = new Set<string>();
  const edits: FileEditPage["edits"] = [];
  for (const row of rows) {
    if (!row.after_version) continue;
    const before = JSON.parse(row.before_version) as Version;
    const after = JSON.parse(row.after_version) as Version;
    const reliable = before.state !== "unavailable" && after.state !== "unavailable";
    if (!row.changed || reliable) identities.add(row.identity);
    if (!row.changed) continue;
    edits.push({ kind: "file-edit", path: row.path, action: before.state === "absent" ? "create" : after.state === "absent" ? "delete" : "update",
      turnKey: pairKey(messageId, run, row), source: "snapshot", overlapping: !!run.overlapping, notice: reliable ? undefined : before.reason ?? after.reason ?? "unavailable" });
  }
  return { edits, identities, roots, capture };
}

export function readSnapshotPair(messageId: string, conversationId: string, taskId: string, filePath: string, key: string): FileEditContent | undefined {
  const db = getDb();
  const run = db.prepare("SELECT * FROM turn_file_capture_runs WHERE conversation_id = ? AND task_id = ? AND state IN ('ready', 'incomplete')").get(conversationId, taskId) as Run | undefined;
  if (!run) return;
  const row = db.prepare("SELECT path, identity, before_version, after_version, changed FROM turn_file_versions WHERE task_id = ? AND identity = ?").get(taskId, snapshotPathIdentity(filePath)) as Row | undefined;
  if (!row?.after_version || row.path !== filePath || !row.changed || pairKey(messageId, run, row) !== key) return;
  const before = JSON.parse(row.before_version) as Version;
  const after = JSON.parse(row.after_version) as Version;
  const action = before.state === "absent" ? "create" : after.state === "absent" ? "delete" : "update";
  if (before.state === "unavailable" || after.state === "unavailable") return { source: "snapshot", action, overlapping: !!run.overlapping, notice: before.reason ?? after.reason ?? "unavailable" };
  const read = (version: Version) => {
    if (version.state === "absent") return "";
    const blob = db.prepare("SELECT payload FROM file_version_blobs WHERE blob_key = ? AND owner_key = ?").get(version.blob, run.owner_key) as { payload: Buffer } | undefined;
    if (!blob || digest(blob.payload) !== version.hash) throw new Error("Saved file version unavailable");
    return blob.payload.toString("utf8");
  };
  return { source: "snapshot", action, overlapping: !!run.overlapping, oldText: read(before), newText: read(after), partial: false };
}
