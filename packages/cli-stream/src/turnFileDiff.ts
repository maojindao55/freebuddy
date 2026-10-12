import type { CliStreamItem } from "@freebuddy/protocol";
import { buildFileDiff } from "./fileDiff.js";

type FileEdit = Extract<CliStreamItem, { kind: "file-edit" }>;
type PatchLine = { kind: " " | "+" | "-"; text: string; noNewline?: boolean };
type Hunk = { oldStart: number; newStart: number; oldCount: number; newCount: number; lines: PatchLine[] };
const MAX_LINES = 20_000;

function parsePatch(patch: string, edit?: FileEdit): Hunk[] | undefined {
  const hunks: Hunk[] = [];
  for (const line of patch.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      hunks.push({ oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1), newStart: Number(match[3]), newCount: Number(match[4] ?? 1), lines: [] });
    } else if (hunks.length && /^[ +\-]/.test(line)) {
      hunks.at(-1)!.lines.push({ kind: line[0] as PatchLine["kind"], text: line.slice(1) });
    } else if (hunks.length && line === "\\ No newline at end of file") {
      const previous = hunks.at(-1)!.lines.at(-1);
      if (!previous || previous.noNewline) return undefined;
      previous.noNewline = true;
    } else if (hunks.length && line !== "") {
      return undefined;
    }
  }
  for (const [index, hunk] of hunks.entries()) {
    for (const [lineIndex, line] of hunk.lines.entries()) {
      if (line.noNewline && (index !== hunks.length - 1 ||
        hunk.lines.slice(lineIndex + 1).some(next => line.kind === " " || next.kind === " " || next.kind === line.kind))) return undefined;
    }
    const oldCount = hunk.lines.filter(line => line.kind !== "+").length;
    const newCount = hunk.lines.filter(line => line.kind !== "-").length;
    if (oldCount === hunk.oldCount && newCount === hunk.newCount) continue;
    const missing = hunk.oldCount - oldCount;
    // Older AGY records trimmed trailing blank context lines. Accept only a
    // missing unchanged tail corroborated by both captured replacement snippets.
    // Omit that unknown context; never manufacture blank lines or changed text.
    const snippet = (text: string | undefined) => text?.replace(/\r?\n$/, "");
    if (index !== hunks.length - 1 || missing < 1 || missing > 3 || missing !== hunk.newCount - newCount ||
      hunk.lines.at(-1)?.kind !== " " || edit?.oldText === undefined || edit.newText === undefined ||
      hunk.lines.filter(line => line.kind === "-").map(line => line.text).join("\n") !== snippet(edit.oldText) ||
      hunk.lines.filter(line => line.kind === "+").map(line => line.text).join("\n") !== snippet(edit.newText)) return undefined;
    hunk.oldCount = oldCount;
    hunk.newCount = newCount;
  }
  return hunks.length ? hunks : undefined;
}

function replaceSnippet(text: string, before: string, after: string): string | undefined {
  if (!before) return undefined;
  const index = text.indexOf(before);
  if (index < 0 || text.indexOf(before, index + 1) >= 0) return undefined;
  return text.slice(0, index) + after + text.slice(index + before.length);
}

function applyPatch(text: string, patch: string, reverse = false, edit?: FileEdit): string | undefined {
  const hunks = parsePatch(patch, edit);
  if (!hunks) return undefined;
  const trailingNewline = text.endsWith("\n");
  const lines = text ? text.split("\n") : [];
  if (trailingNewline) lines.pop();
  let delta = 0, end = 0;
  for (const hunk of hunks) {
    const source = hunk.lines.filter(line => line.kind !== (reverse ? "-" : "+"));
    const before = source.map(line => line.text);
    const after = hunk.lines.filter(line => line.kind !== (reverse ? "+" : "-")).map(line => line.text);
    const start = reverse ? hunk.newStart : hunk.oldStart;
    const offset = before.length ? start - 1 : start;
    const index = offset + delta;
    const targetStart = reverse ? hunk.oldStart : hunk.newStart;
    const targetOffset = after.length ? targetStart - 1 : targetStart;
    if (offset < end || index < 0 || index !== targetOffset || index + before.length > lines.length || before.some((line, i) => lines[index + i] !== line)) return undefined;
    if (source.some((line, i) => line.noNewline && (trailingNewline || index + i !== lines.length - 1))) return undefined;
    lines.splice(index, before.length, ...after);
    const target = hunk.lines.filter(line => line.kind !== (reverse ? "+" : "-"));
    if (target.some((line, i) => line.noNewline && index + i !== lines.length - 1)) return undefined;
    end = offset + before.length;
    delta += after.length - before.length;
  }
  const hasEofMarker = hunks.some(hunk => hunk.lines.some(line => line.noNewline));
  const target = hunks.at(-1)!.lines.filter(line => line.kind !== (reverse ? "+" : "-"));
  const ending = hasEofMarker ? !target.at(-1)?.noNewline : trailingNewline || text === "";
  return lines.join("\n") + (ending && lines.length ? "\n" : "");
}

/** Apply a validated captured patch to a complete version, including EOF markers. */
export { applyPatch as applyFileEditPatch };

function applyEdit(text: string, edit: FileEdit, reverse = false): string | undefined {
  const before = edit.oldText ?? (edit.action === "create" ? "" : undefined);
  const after = edit.newText ?? (edit.action === "delete" ? "" : undefined);
  const from = reverse ? after : before, to = reverse ? before : after;
  if (!edit.partial && from === text && to !== undefined) return to;
  if (edit.patch) return applyPatch(text, edit.patch, reverse, edit);
  if (edit.partial && from !== undefined && to !== undefined) return replaceSnippet(text, from, to);
  // An overwrite may capture only the complete new version.
  if (!edit.partial && !reverse && edit.action === "update" && before === undefined) return after;
  return undefined;
}

/** Compose patches against sparse original lines; untouched file content stays unknown. */
function composePatches(edits: FileEdit[]): string | undefined {
  type Line = { origin?: number; text?: string };
  const original: Line[] = [], current: Line[] = [];
  const ensure = (length: number): boolean => {
    if (length > MAX_LINES) return false;
    while (current.length < length) {
      const line = { origin: original.length };
      original.push(line);
      current.push(line);
    }
    return true;
  };
  for (const edit of edits) {
    const hunks = edit.patch && parsePatch(edit.patch, edit);
    if (!hunks) return undefined;
    // Sparse captures cannot establish the document's EOF state.
    if (hunks.some(hunk => hunk.lines.some(line => line.noNewline))) return undefined;
    let delta = 0, end = 0;
    for (const hunk of hunks) {
      const offset = hunk.oldCount ? hunk.oldStart - 1 : hunk.oldStart;
      const index = offset + delta;
      const newOffset = hunk.newCount ? hunk.newStart - 1 : hunk.newStart;
      if (offset < end || index < 0 || index !== newOffset || !ensure(index + hunk.oldCount)) return undefined;
      const replacement: Line[] = [];
      let consumed = 0;
      for (const line of hunk.lines) {
        if (line.kind === "+") { replacement.push({ text: line.text }); continue; }
        const existing = current[index + consumed++];
        if (existing.text !== undefined && existing.text !== line.text) return undefined;
        existing.text = line.text;
        if (line.kind === " ") replacement.push(existing);
      }
      current.splice(index, consumed, ...replacement);
      if (original.length + current.length > MAX_LINES * 2) return undefined;
      end = offset + hunk.oldCount;
      delta += hunk.newCount - hunk.oldCount;
    }
  }
  // Unknown, unchanged lines separate independent captured regions. Diff each
  // known region so intermediate additions/deletions and reversions cancel out.
  const patches: string[] = [];
  let oldIndex = 0, newIndex = 0, oldStart = 0, newStart = 0;
  let before: string[] = [], after: string[] = [];
  const flush = (): boolean => {
    const diff = buildFileDiff({ kind: "file-edit", path: edits[0].path, action: "update", oldText: before.length ? before.join("\n") + "\n" : "", newText: after.length ? after.join("\n") + "\n" : "" });
    if (diff.notice) return false;
    if (diff.added || diff.removed) {
      patches.push(`@@ -${oldStart + (before.length ? 1 : 0)},${before.length} +${newStart + (after.length ? 1 : 0)},${after.length} @@\n` +
        diff.rows.map(row => `${row.kind === "add" ? "+" : row.kind === "delete" ? "-" : " "}${row.text}`).join("\n"));
    }
    before = []; after = [];
    return true;
  };
  while (oldIndex < original.length || newIndex < current.length) {
    const next = current[newIndex];
    if (next && next.origin === undefined) { after.push(next.text!); newIndex++; }
    else if (next?.origin === oldIndex) {
      if (next.text === undefined) {
        if (!flush()) return undefined;
        oldStart = oldIndex + 1; newStart = newIndex + 1;
      } else { before.push(next.text); after.push(next.text); }
      oldIndex++; newIndex++;
    } else {
      const line = original[oldIndex++];
      if (!line || line.text === undefined) return undefined;
      before.push(line.text);
    }
  }
  if (!flush()) return undefined;
  const patch = patches.join("\n");
  return patch.length <= 400_000 ? patch : undefined;
}

function composeSnippets(edits: FileEdit[], summary: FileEdit): FileEdit | undefined {
  const regions: { before: string; after: string }[] = [];
  for (const edit of edits) {
    const before = edit.oldText!, after = edit.newText!;
    if (!before) return summary;
    const matches = regions.filter(region => region.after.includes(before));
    if (matches.length > 1) return summary;
    if (matches.length === 1) {
      const next = replaceSnippet(matches[0].after, before, after);
      if (next === undefined) return summary;
      matches[0].after = next;
      continue;
    }
    const containing = regions.filter(region => region.after && before.includes(region.after));
    if (containing.length > 1) return summary;
    if (containing.length === 1) {
      const original = replaceSnippet(before, containing[0].after, containing[0].before);
      if (original === undefined) return summary;
      containing[0].before = original;
      containing[0].after = after;
      continue;
    }
    // Disjoint captured regions have no known file offsets. Keep their own
    // snippet-relative line numbers instead of inventing a combined document.
    if (regions.some(region => region.before.includes(before) || before.includes(region.before))) return summary;
    regions.push({ before, after });
  }
  const changed = regions.filter(region => region.before !== region.after);
  if (!changed.length) return undefined;
  if (changed.length === 1) return { ...summary, oldText: changed[0].before, newText: changed[0].after, partial: true };
  const patches: string[] = [];
  for (const [index, region] of changed.entries()) {
    const diff = buildFileDiff({ ...summary, oldText: region.before, newText: region.after, partial: true });
    if (diff.notice) return summary;
    const oldCount = diff.rows.filter(row => row.kind === "context" || row.kind === "delete").length;
    const newCount = diff.rows.filter(row => row.kind === "context" || row.kind === "add").length;
    patches.push(`@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@ (fragment ${index + 1})\n` +
      diff.rows.map(row => `${row.kind === "add" ? "+" : row.kind === "delete" ? "-" : row.kind === "meta" ? "\\ " : " "}${row.text}`).join("\n"));
  }
  const patch = patches.join("\n");
  return patch.length <= 400_000 ? { ...summary, patch, partial: true } : summary;
}

function summarize(edits: FileEdit[]): FileEdit | undefined {
  const first = edits[0], last = edits.at(-1)!;
  if (first.action === "create" && last.action === "delete") return undefined;
  if (edits.length === 1) return first;
  const action = first.action === "create" ? "create" : last.action === "delete" ? "delete" : "update";
  const summary: FileEdit = { kind: "file-edit", path: first.path, action };
  if (edits.some(edit => edit.truncated || buildFileDiff(edit).notice === "truncated")) return summary;
  const pivot = edits.findIndex(edit => !edit.partial &&
    (edit.oldText !== undefined || edit.action === "create") &&
    (edit.newText !== undefined || edit.action === "delete") &&
    // AGY can supply replacement snippets alongside a file-relative patch.
    // They are complete versions only if that patch applies to the whole text.
    (!edit.patch || applyPatch(edit.oldText ?? "", edit.patch, false, edit) === (edit.newText ?? "")));
  if (pivot >= 0) {
    let before: string | undefined = edits[pivot].oldText ?? "";
    let after: string | undefined = edits[pivot].newText ?? "";
    for (let i = pivot - 1; i >= 0 && before !== undefined; i--) before = applyEdit(before, edits[i], true);
    for (let i = pivot + 1; i < edits.length && after !== undefined; i++) after = applyEdit(after, edits[i]);
    if (before !== undefined && after !== undefined) {
      if (action === "update" && before === after) return undefined;
      return { ...summary, oldText: before, newText: after };
    }
  }
  if (edits.every(edit => edit.patch)) {
    const patch = composePatches(edits);
    return patch === "" ? undefined : { ...summary, ...(patch !== undefined ? { patch } : {}) };
  }
  if (edits.every(edit => edit.partial && edit.oldText !== undefined && edit.newText !== undefined)) {
    return composeSnippets(edits, summary);
  }
  return summary;
}

/** One net change per file, scoped to the edits captured in a single turn. */
export function aggregateFileEdits(edits: FileEdit[]): FileEdit[] {
  const groups = new Map<string, FileEdit[]>();
  for (const edit of edits) {
    if (edit.status && edit.status !== "completed") continue;
    const key = edit.path.replace(/\\/g, "/");
    const group = groups.get(key) ?? [];
    group.push(edit);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap(group => {
    const edit = summarize(group);
    if (!edit) return [];
    if (edit.action === "update" && edit.oldText !== undefined && edit.oldText === edit.newText && buildFileDiff(edit).notice !== "truncated") return [];
    return [edit];
  });
}
