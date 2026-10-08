import { buildFileDiff, type DiffRow, type FileDiff } from "@freebuddy/cli-stream";
import type { CliStreamItem } from "@/services/cli/parsers";

export type FileEdit = Extract<CliStreamItem, { kind: "file-edit" }>;
export { buildFileDiff, type DiffRow, type FileDiff } from "@freebuddy/cli-stream";

export function isMarkdownFile(path: string): boolean {
  return /\.(?:md|markdown|mdown|mkd)$/i.test(path);
}

/** Preview only captured documents, never infer a full file from a patch/snippet. */
export function markdownVersions(edit: FileEdit): { before?: string; after?: string } {
  if (!isMarkdownFile(edit.path) || edit.partial || getFileDiff(edit).notice) return {};
  return {
    ...(edit.action !== "create" && edit.oldText !== undefined ? { before: edit.oldText } : {}),
    ...(edit.action !== "delete" && edit.newText !== undefined ? { after: edit.newText } : {})
  };
}

/** Retain original selection indices so lazy loading and refresh keep their identities. */
export function groupFileEditRecords(edits: FileEdit[]): { path: string; indices: number[] }[] {
  const groups = new Map<string, { path: string; indices: number[] }>();
  edits.forEach((edit, index) => {
    const group = groups.get(edit.path) ?? { path: edit.path, indices: [] };
    group.indices.push(index);
    groups.set(edit.path, group);
  });
  return [...groups.values()];
}

function extractToolOutputText(
  item: Extract<CliStreamItem, { kind: "tool-call" }>,
  result?: Extract<CliStreamItem, { kind: "tool-result" }>
): string {
  if (typeof item.output === "string" && item.output) return item.output;
  if (typeof result?.content === "string" && result.content) return result.content;
  if (item.toolOutputs) {
    for (const out of item.toolOutputs) {
      if (out.kind === "command-output" && typeof out.content === "string" && out.content) {
        return out.content;
      }
      if (out.kind === "content-block" && typeof out.text === "string" && out.text) {
        return out.text;
      }
      const raw = out as Record<string, unknown>;
      if (typeof raw.content === "string" && raw.content) {
        return raw.content;
      }
    }
  }
  return "";
}

function extractFilePath(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  const p = input.TargetFile ?? input.targetFile ?? input.file_path ?? input.filePath ?? input.path ?? input.Path;
  return typeof p === "string" && p ? p : undefined;
}

/** Keep individual edits when their baselines cannot safely be combined. */
export function collectFileEdits(items: CliStreamItem[]): FileEdit[] {
  const edits: FileEdit[] = [];
  const results = new Map<string, Extract<CliStreamItem, { kind: "tool-result" }>>();
  for (const item of items) if (item.kind === "tool-result" && item.id) results.set(item.id, item);
  for (const item of items) {
    if (item.kind === "file-edit" && (!item.status || item.status === "completed")) edits.push(item);
    if (item.kind !== "tool-call" || item.isError || (item.status && item.status !== "completed")) continue;
    const result = item.id ? results.get(item.id) : undefined;
    if (result?.isError) continue;
    let hollowNested: FileEdit[] | null = null;
    if (item.toolOutputs?.length) {
      const nested = collectFileEdits(item.toolOutputs);
      if (nested.length > 0) {
        const hasContent = nested.some((e) => e.blobKey || e.patch || e.oldText !== undefined || e.newText !== undefined);
        if (hasContent) {
          edits.push(...nested);
          continue;
        }
        hollowNested = nested;
      }
    }
    // Claude/Antigravity file edits only show after success.
    if (!(result || item.status === "completed")) continue;

    const startCount = edits.length;
    // Check if tool output contains unified diff patch (e.g. Antigravity replace_file_content output)
    const outputText = extractToolOutputText(item, result);
    const diffBlockMatch = outputText.match(/\[diff_block_start\]\s*([\s\S]*?)\s*\[diff_block_end\]/);
    const input = item.input as Record<string, unknown> | undefined;
    const targetPath = item.locations?.[0]?.path || hollowNested?.[0]?.path || extractFilePath(input);

    if (diffBlockMatch && targetPath) {
      edits.push({ kind: "file-edit", path: targetPath, action: "update", patch: diffBlockMatch[1].trim() });
      continue;
    }

    if (!input) {
      if (hollowNested && edits.length === startCount) {
        edits.push(...hollowNested);
      }
      continue;
    }

    // Claude Edit contains snippets, not the complete file.
    if (item.tool === "Edit" || typeof input.old_string === "string") {
      if (typeof input.file_path === "string" && typeof input.old_string === "string" && typeof input.new_string === "string") {
        edits.push({ kind: "file-edit", path: input.file_path, action: "update", oldText: input.old_string, newText: input.new_string, partial: true });
        continue;
      }
    }

    // Antigravity replace_file_content
    const targetContent = input.TargetContent ?? input.targetContent;
    const replacementContent = input.ReplacementContent ?? input.replacementContent;
    if (targetPath && typeof targetContent === "string" && typeof replacementContent === "string") {
      edits.push({ kind: "file-edit", path: targetPath, action: "update", oldText: targetContent, newText: replacementContent, partial: true });
      continue;
    }

    // Antigravity write_to_file
    const codeContent = input.CodeContent ?? input.codeContent ?? (typeof input.content === "string" && (item.tool === "write_to_file" || item.tool.includes("write")) ? input.content : undefined);
    if (targetPath && typeof codeContent === "string") {
      const isOverwrite = input.Overwrite === true || input.overwrite === true || input.Overwrite === "true";
      edits.push({ kind: "file-edit", path: targetPath, action: isOverwrite ? "update" : "create", newText: codeContent });
      continue;
    }

    // Antigravity multi_replace_file_content
    const replacements = input.Replacements ?? input.replacements;
    if (targetPath && Array.isArray(replacements)) {
      for (const rep of replacements) {
        if (typeof rep?.TargetContent === "string" && typeof rep?.ReplacementContent === "string") {
          edits.push({ kind: "file-edit", path: targetPath, action: "update", oldText: rep.TargetContent, newText: rep.ReplacementContent, partial: true });
        }
      }
    }

    if (hollowNested && edits.length === startCount) {
      edits.push(...hollowNested);
    }
  }
  const seen = new Set<string>();
  return edits.filter(edit => {
    if (!edit.blobKey) return true;
    if (seen.has(edit.blobKey)) return false;
    seen.add(edit.blobKey);
    return true;
  });
}

export function mergeStoredFileEdits(inline: FileEdit[], stored?: FileEdit[]): FileEdit[] {
  if (!stored) return inline;
  const paths = new Set(stored.map(edit => edit.path));
  return [
    ...inline.filter(edit => !edit.blobKey && (!paths.has(edit.path) || edit.patch !== undefined || edit.oldText !== undefined || edit.newText !== undefined)),
    ...stored
  ];
}

const diffCache = new WeakMap<FileEdit, FileDiff>();

/** Diffs are pure per edit; reuse them across the card and the panel. */
export function getFileDiff(edit: FileEdit): FileDiff {
  let diff = diffCache.get(edit);
  if (!diff) diffCache.set(edit, diff = buildFileDiff(edit));
  return diff;
}

export function getFileEditCounts(edit: FileEdit): FileEdit["counts"] {
  if (edit.counts) return edit.counts;
  const diff = getFileDiff(edit);
  return diff.notice ? undefined : { added: diff.added, removed: diff.removed };
}

export type FoldRow = { kind: "fold"; start: number; count: number };
const FOLD_CONTEXT = 3, FOLD_MIN = 3;

/** Collapse unchanged runs without modifying the underlying diff or its counts. */
export function foldDiffRows(rows: DiffRow[], expanded: ReadonlySet<number> = new Set()): (DiffRow | FoldRow)[] {
  const out: (DiffRow | FoldRow)[] = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== "context") { out.push(rows[i++]); continue; }
    let end = i;
    while (end < rows.length && rows[end].kind === "context") end++;
    // Edge runs only need context on the side that touches a change.
    const whole = i === 0 && end === rows.length;
    const head = i === 0 && !whole ? 0 : FOLD_CONTEXT;
    const tail = end === rows.length && !whole ? 0 : FOLD_CONTEXT;
    const start = i + head, count = end - i - head - tail;
    if (count >= FOLD_MIN && !expanded.has(start)) out.push(...rows.slice(i, start), { kind: "fold", start, count }, ...rows.slice(end - tail, end));
    else out.push(...rows.slice(i, end));
    i = end;
  }
  return out;
}

const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

/** Changed span of a modified line, snapped to word boundaries so highlights stay readable. */
export function inlineChange(before: string, after: string): { old: [number, number]; new: [number, number] } | undefined {
  if (before === after) return undefined;
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  while (prefix > 0 && isWord(before[prefix - 1]) && (isWord(before[prefix]) || isWord(after[prefix]))) prefix--;
  let suffix = 0;
  while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  while (suffix > 0 && isWord(before[before.length - suffix]) && (isWord(before[before.length - 1 - suffix]) || isWord(after[after.length - 1 - suffix]))) suffix--;
  // Sharing only indentation means the whole line changed; a highlight would be noise.
  if (!before.slice(0, prefix).trim() && !before.slice(before.length - suffix).trim()) return undefined;
  return { old: [prefix, before.length - suffix], new: [prefix, after.length - suffix] };
}

/** Pair each deleted line with the added line that replaced it, for intra-line highlights. */
export function inlineHighlights(rows: DiffRow[]): Map<DiffRow, [number, number]> {
  const marks = new Map<DiffRow, [number, number]>();
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== "delete") { i++; continue; }
    let mid = i;
    while (mid < rows.length && rows[mid].kind === "delete") mid++;
    let end = mid;
    while (end < rows.length && rows[end].kind === "add") end++;
    // Only equal-sized blocks pair up reliably line by line.
    if (end - mid === mid - i) for (let k = 0; k < mid - i; k++) {
      const change = inlineChange(rows[i + k].text, rows[mid + k].text);
      if (change) { marks.set(rows[i + k], change.old); marks.set(rows[mid + k], change.new); }
    }
    i = Math.max(end, i + 1);
  }
  return marks;
}

function normalizeRoot(root: string): string {
  return root.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Strip the longest matching workspace root from an absolute path.
 * Paths outside every root are returned unchanged. Matching is case-insensitive
 * so macOS / Windows paths with differing case still collapse.
 */
export function relativePath(path: string, roots: ReadonlyArray<string | undefined>): string {
  const normalized = path.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  let best = "";
  for (const raw of roots) {
    if (!raw) continue;
    const root = normalizeRoot(raw);
    if (!root || root.length <= best.length) continue;
    const prefix = root.toLowerCase() + "/";
    if (lower.startsWith(prefix)) best = root;
  }
  return best ? normalized.slice(best.length + 1) : path;
}

/** Split a path into file name and (possibly empty) parent directory. */
export function splitPath(path: string): { name: string; dir: string } {
  const name = path.split(/[\\/]/).pop() || path;
  return { name, dir: path.slice(0, path.length - name.length).replace(/[\\/]+$/, "") };
}

/**
 * Picker labels: file name only, plus the relative directory when two different
 * paths share the same file name.
 */
export function pickerLabels(paths: ReadonlyArray<string>, roots: ReadonlyArray<string | undefined>): string[] {
  const parts = paths.map((path) => splitPath(relativePath(path, roots)));
  const owners = new Map<string, Set<string>>();
  paths.forEach((path, i) => {
    const set = owners.get(parts[i].name) ?? new Set<string>();
    set.add(path);
    owners.set(parts[i].name, set);
  });
  return parts.map(({ name, dir }) => ((owners.get(name)?.size ?? 0) > 1 && dir ? `${name} — ${dir}` : name));
}
