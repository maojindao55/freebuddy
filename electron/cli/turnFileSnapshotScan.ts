import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ignore from "ignore";

const git = promisify(execFile);
export const DEFAULT_LIMITS = { fileBytes: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, entries: 50_000, milliseconds: 2000 };
export type Limits = typeof DEFAULT_LIMITS;
export type Version = { state: "absent" | "captured" | "unavailable"; hash?: string; bytes?: number; reason?: "binary" | "large" | "unavailable"; blob?: string };
export type Root = { path: string; complete: boolean; aliases?: Array<{ path: string; target: string }>; directories?: Record<string, string[]> };
export type Row = { path: string; identity: string; before_version: string; after_version: string | null; changed: number };
export const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const snapshotPathIdentity = (filePath: string) => {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};
export const within = (filePath: string, root: string) => {
  const relative = path.relative(root, filePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const entryName = (name: string) => process.platform === "win32" ? name.toLowerCase() : name;
// A file can become a FIFO or symlink between lstat and open. Nonblocking,
// no-follow opens let the descriptor type check reject that race safely.
const READ_FLAGS = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);
/** Resolve saved workspace aliases without consulting today's filesystem. */
export function snapshotPathIdentities(filePath: string, roots: Root[]): string[] {
  const paths = path.isAbsolute(filePath) ? [filePath] : roots.map(root => path.resolve(root.path, filePath));
  const aliases = roots.flatMap(root => root.aliases ?? []).sort((a, b) => b.path.length - a.path.length);
  return [...new Set(paths.map(candidate => {
    const alias = aliases.find(alias => within(candidate, alias.path));
    return snapshotPathIdentity(alias ? path.resolve(alias.target, path.relative(alias.path, candidate)) : candidate);
  }))];
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
async function enumerate(root: Root, limits: Limits, deadline: number, rememberDirectories = false): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  root.complete = true;
  if (rememberDirectories) root.directories = {};
  const add = (filePath: string) => {
    if (!within(filePath, root.path) || files.size >= limits.entries || Date.now() >= deadline) { root.complete = false; return false; }
    files.set(snapshotPathIdentity(filePath), filePath);
    return true;
  };
  let gitEnumerated = false;
  try {
    const result = await git("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], {
      cwd: root.path, encoding: "utf8", windowsHide: true, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 8 * 1024 * 1024
    });
    for (const entry of result.stdout.split("\0")) {
      if (entry && !add(path.resolve(root.path, entry))) break;
    }
    gitEnumerated = true;
    if (!rememberDirectories) return files;
  } catch (error) {
    // A missing Git repository uses the same bounded scanner as a non-Git project.
    if (Date.now() >= deadline) { root.complete = false; return files; }
  }
  type Rule = { base: string; matcher: ReturnType<typeof ignore> };
  const excluded = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__"]);
  // Tracked files can live in otherwise ignored directories. Visit their
  // ancestors as well as unignored empty directories to preserve start listings.
  const trackedDirectories = new Set<string>();
  if (gitEnumerated) for (const filePath of files.values()) {
    let directory = path.dirname(filePath);
    while (within(directory, root.path)) {
      trackedDirectories.add(snapshotPathIdentity(directory));
      if (directory === root.path) break;
      directory = path.dirname(directory);
    }
  }
  let visited = 0;
  const walk = async (directory: string, inherited: Rule[]) => {
    if (Date.now() >= deadline || (!gitEnumerated && files.size >= limits.entries)) { root.complete = false; return; }
    let rules = inherited;
    try {
      const ignoreFile = path.join(directory, ".gitignore");
      const stat = await fs.lstat(ignoreFile);
      if (!stat.isFile() || stat.size > 256 * 1024) { root.complete = false; return; }
      const handle = await fs.open(ignoreFile, READ_FLAGS);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > 256 * 1024) { root.complete = false; return; }
        const body = await handle.readFile("utf8");
        rules = [...rules, { base: directory, matcher: ignore().add(body) }];
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") root.complete = false;
    }
    try {
      if (!within(await fs.realpath(directory), root.path)) { root.complete = false; return; }
      const names: string[] = [];
      for await (const entry of await fs.opendir(directory)) {
        if (Date.now() >= deadline || ++visited > limits.entries || (!gitEnumerated && files.size >= limits.entries)) { root.complete = false; break; }
        names.push(entryName(entry.name));
        if (entry.isSymbolicLink()) continue;
        const filePath = path.join(directory, entry.name);
        const tracked = trackedDirectories.has(snapshotPathIdentity(filePath));
        if (excluded.has(entry.name) && !tracked) continue;
        let ignored = false;
        for (const rule of rules) {
          const result = rule.matcher.test(path.relative(rule.base, filePath).replace(/\\/g, "/") + (entry.isDirectory() ? "/" : ""));
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
        if (ignored && !tracked) continue;
        if (entry.isDirectory()) await walk(filePath, rules);
        else if (entry.isFile() && !gitEnumerated) add(filePath);
      }
      if (rememberDirectories && root.complete) root.directories![snapshotPathIdentity(directory)] = names;
    } catch { root.complete = false; }
  };
  await walk(root.path, []);
  return files;
}

async function captureVersion(filePath: string, roots: Root[], owner: string, budget: { bytes: number }, limits: Limits, deadline: number): Promise<{ version: Version; body?: Buffer }> {
  if (Date.now() >= deadline) return { version: { state: "unavailable", reason: "unavailable" } };
  try {
    // Never follow a replaced symlink outside the authorized workspace.
    if (!(await fs.lstat(filePath)).isFile()) return { version: { state: "unavailable", reason: "unavailable" } };
    const real = await fs.realpath(filePath);
    if (!roots.some(root => within(real, root.path))) return { version: { state: "unavailable", reason: "unavailable" } };
    const handle = await fs.open(real, READ_FLAGS);
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

export type SnapshotScanRequest = {
  phase: "before" | "after"; roots: Root[]; owner: string; limits: Limits; complete: boolean;
  before?: Array<Pick<Row, "path" | "identity" | "before_version">>;
};
export type SnapshotVersion = { path: string; identity: string; before: Version; after?: Version; same?: boolean; body?: Uint8Array };
export type SnapshotScanEvent = { kind: "roots"; roots: Root[] } | { kind: "batch"; entries: SnapshotVersion[] };
export const SNAPSHOT_BATCH_ENTRIES = 32;
export const SNAPSHOT_BATCH_BYTES = 1024 * 1024;

/** Runs only in the capture process. Acknowledged batches bound bodies in flight. */
export async function scanSnapshotVersions(request: SnapshotScanRequest, publish: (event: SnapshotScanEvent) => Promise<void>): Promise<boolean> {
  const { roots, limits, owner } = request;
  const deadline = Date.now() + limits.milliseconds;
  const budget = { bytes: limits.totalBytes };
  let complete = request.complete;
  const saved = new Map((request.before ?? []).map(row => [row.identity, row]));
  const candidates = new Map([...saved.values()].map(row => [row.identity, row.path]));
  for (const root of roots) {
    const scannedRoot = request.phase === "before" ? root : { ...root };
    const remaining = request.phase === "before" ? Math.max(0, limits.entries - candidates.size) : limits.entries;
    for (const [identity, filePath] of await enumerate(scannedRoot, { ...limits, entries: remaining }, deadline, request.phase === "before")) {
      if (!candidates.has(identity) && candidates.size >= limits.entries) { complete = false; break; }
      candidates.set(identity, filePath);
    }
    complete &&= scannedRoot.complete;
  }
  if (request.phase === "before") await publish({ kind: "roots", roots });
  let entries: SnapshotVersion[] = [], batchBytes = 0;
  const flush = async () => {
    if (!entries.length) return;
    await publish({ kind: "batch", entries });
    entries = []; batchBytes = 0;
  };
  for (const [identity, filePath] of candidates) {
    const { version, body } = await captureVersion(filePath, roots, owner, budget, limits, deadline);
    let entry: SnapshotVersion;
    if (request.phase === "before") {
      if (version.state === "unavailable" && !version.hash) complete = false;
      entry = { path: filePath, identity, before: version, body };
    } else {
      const original = saved.get(identity);
      const before: Version = original ? JSON.parse(original.before_version) : absentAtStart(filePath, roots)
        ? { state: "absent" } : { state: "unavailable", reason: "unavailable" };
      const same = before.state === "absent" && version.state === "absent" || !!before.hash && before.hash === version.hash;
      if (before.state === "unavailable" && !before.hash || version.state === "unavailable" && !version.hash) complete = false;
      entry = { path: filePath, identity, before, after: version, same, body: same ? undefined : body };
    }
    const bytes = entry.body?.byteLength ?? 0;
    if (entries.length && batchBytes + bytes > SNAPSHOT_BATCH_BYTES) await flush();
    entries.push(entry); batchBytes += bytes;
    if (entries.length >= SNAPSHOT_BATCH_ENTRIES || batchBytes >= SNAPSHOT_BATCH_BYTES) await flush();
  }
  await flush();
  return complete;
}
