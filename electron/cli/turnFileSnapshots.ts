import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileEditContent, FileEditPage } from "@freebuddy/protocol";
import { getDb } from "./db.js";
import { requireOwnedConversation } from "./conversations.js";
import { scanSnapshots } from "./turnFileSnapshotProcess.js";
import { DEFAULT_LIMITS, digest, within, snapshotPathIdentity, snapshotPathIdentities, type Limits, type Version, type Root, type Row } from "./turnFileSnapshotScan.js";
export { snapshotPathIdentity, snapshotPathIdentities } from "./turnFileSnapshotScan.js";

type Run = { task_id: string; conversation_id: string; owner_key: string; roots: string; state: string; complete: number; overlapping: number };
export type TurnFileCapture = {
  db: ReturnType<typeof getDb>; taskId: string; conversationId: string; owner: string;
  roots: Root[]; limits: Limits; complete: boolean; finished: boolean;
};
const active = new Map<string, TurnFileCapture>();
const overlap = (a: Root[], b: Root[]) => a.some(x => b.some(y => within(x.path, y.path) || within(y.path, x.path)));

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
      if ((await fs.stat(real)).isDirectory()) {
        let capturedRoot = roots.find(existing => within(real, existing.path));
        if (!capturedRoot) { capturedRoot = { path: real, complete: false }; roots.push(capturedRoot); }
        const alias = path.resolve(root);
        if (snapshotPathIdentity(alias) !== snapshotPathIdentity(real)) {
          (capturedRoot.aliases ??= []).push({ path: alias, target: real });
        }
      }
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
  try {
    capture.complete = await scanSnapshots({ phase: "before", roots, owner: capture.owner, limits: capture.limits, complete: capture.complete }, event => {
      if (!db.prepare("SELECT 1 FROM turn_file_capture_runs WHERE task_id = ?").get(capture.taskId)) throw new Error("Conversation deleted during file capture");
      if (event.kind === "roots") {
        capture.roots = event.roots;
        db.prepare("UPDATE turn_file_capture_runs SET roots = ? WHERE task_id = ?").run(JSON.stringify(capture.roots), capture.taskId);
        return;
      }
      db.transaction(() => {
        for (const entry of event.entries) {
          const body = entry.body && (Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body));
          saveBlob(capture, entry.before, body);
          db.prepare("INSERT INTO turn_file_versions(task_id, path, identity, before_version, before_blob) VALUES (?, ?, ?, ?, ?)")
            .run(capture.taskId, entry.path, entry.identity, JSON.stringify(entry.before), entry.before.blob ?? null);
        }
      })();
    });
    db.prepare("UPDATE turn_file_capture_runs SET state = 'running', complete = ?, roots = ? WHERE task_id = ?")
      .run(Number(capture.complete), JSON.stringify(capture.roots), capture.taskId);
    return capture;
  } catch (error) {
    capture.complete = false;
    capture.roots.forEach(root => { root.complete = false; });
    db.prepare("UPDATE turn_file_capture_runs SET state = 'running', complete = 0, roots = ?, reason = ? WHERE task_id = ?")
      .run(JSON.stringify(capture.roots), String(error), capture.taskId);
    return capture;
  }
}

export async function finalizeTurnFileCapture(capture: TurnFileCapture, uncertain = false): Promise<void> {
  if (capture.finished) return;
  capture.finished = true;
  const { db, taskId } = capture;
  if (!db.prepare("SELECT 1 FROM turn_file_capture_runs WHERE task_id = ?").get(taskId)) { active.delete(taskId); return; }
  db.prepare("UPDATE turn_file_capture_runs SET state = 'finalizing' WHERE task_id = ?").run(taskId);
  try {
    const before = db.prepare("SELECT path, identity, before_version FROM turn_file_versions WHERE task_id = ?").all(taskId) as Row[];
    const complete = await scanSnapshots({ phase: "after", roots: capture.roots, owner: capture.owner, limits: capture.limits,
      complete: capture.complete && !uncertain, before }, event => {
      if (!db.prepare("SELECT 1 FROM turn_file_capture_runs WHERE task_id = ?").get(taskId)) throw new Error("Conversation deleted during file capture");
      if (event.kind !== "batch") return;
      db.transaction(() => {
        for (const entry of event.entries) {
          if (!entry.after) throw new Error("Missing ending file version");
          const body = entry.body && (Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body));
          if (!entry.same) saveBlob(capture, entry.after, body);
          db.prepare(`INSERT INTO turn_file_versions(task_id, path, identity, before_version, after_version, before_blob, after_blob, changed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, identity) DO UPDATE SET
            after_version = excluded.after_version, before_blob = excluded.before_blob, after_blob = excluded.after_blob, changed = excluded.changed`)
            .run(taskId, entry.path, entry.identity, JSON.stringify(entry.before), JSON.stringify(entry.after),
              entry.same ? null : entry.before.blob ?? null, entry.same ? null : entry.after.blob ?? null, Number(!entry.same));
        }
      })();
    });
    db.prepare("UPDATE turn_file_capture_runs SET state = ?, complete = ?, sealed_at = ? WHERE task_id = ?")
      .run(complete ? "ready" : "incomplete", Number(complete), Date.now(), taskId);
  } catch (error) {
    db.transaction(() => {
      // Keep sealed pairs, but release baselines that acquired no ending version.
      db.prepare("UPDATE turn_file_versions SET before_blob = NULL WHERE task_id = ? AND after_version IS NULL").run(taskId);
      db.prepare("UPDATE turn_file_capture_runs SET state = 'incomplete', complete = 0, sealed_at = ?, reason = ? WHERE task_id = ?")
        .run(Date.now(), String(error), taskId);
    })();
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
