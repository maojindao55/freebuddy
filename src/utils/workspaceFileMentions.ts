export interface WorkspaceFileMentionDraft {
  start: number;
  end: number;
  query: string;
}

export type WorkspaceFileMentionSegment =
  | { kind: "text"; value: string }
  | { kind: "mention"; value: string; path: string };

const EXTENSIONLESS_FILE_NAMES = new Set([
  "dockerfile",
  "makefile",
  "gemfile",
  "procfile",
  "license",
  "readme",
  "changelog"
]);

function isAsciiAddressCharacter(value: string): boolean {
  return /[A-Za-z0-9._%+-]/.test(value);
}

function isMentionBoundary(value: string): boolean {
  return /[\s,!?;:()[\]{}<>，。！？；：、]/u.test(value);
}

function looksLikeWorkspaceFile(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  const name = normalized.split("/").pop()?.toLocaleLowerCase() ?? "";
  if (!name || normalized.endsWith("/")) return false;
  if (normalized.includes("/")) return true;
  if (name.startsWith(".") && name.length > 1) return true;
  if (name.includes(".")) return true;
  return EXTENSIONLESS_FILE_NAMES.has(name);
}

export function findWorkspaceFileMentionDraft(
  value: string,
  cursorPosition: number
): WorkspaceFileMentionDraft | null {
  const cursor = Math.min(Math.max(Math.trunc(cursorPosition), 0), value.length);
  let at = cursor - 1;

  while (at >= 0 && value[at] !== "@" && !isMentionBoundary(value[at])) {
    at -= 1;
  }
  if (at < 0 || value[at] !== "@") return null;
  if (at > 0 && isAsciiAddressCharacter(value[at - 1])) return null;

  const rawQuery = value.slice(at + 1, cursor);
  if (rawQuery.includes("@") || rawQuery.includes("\n")) return null;

  const quoted = rawQuery.startsWith('"');
  const query = quoted ? rawQuery.slice(1) : rawQuery;
  let end = cursor;
  if (quoted) {
    while (end < value.length && value[end] !== '"' && value[end] !== "\n") end += 1;
    if (value[end] === '"') end += 1;
  } else {
    while (end < value.length && !isMentionBoundary(value[end]) && value[end] !== "@") {
      end += 1;
    }
  }

  return { start: at, end, query };
}

export function formatWorkspaceFileMention(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return /\s/.test(normalized) ? `@"${normalized.replace(/"/g, '\\"')}"` : `@${normalized}`;
}

export function insertWorkspaceFileMention(
  value: string,
  mention: WorkspaceFileMentionDraft,
  filePath: string
): { value: string; cursor: number } {
  const inserted = formatWorkspaceFileMention(filePath);
  const next = `${value.slice(0, mention.start)}${inserted}${value.slice(mention.end)}`;
  return {
    value: next,
    cursor: mention.start + inserted.length
  };
}

export function splitWorkspaceFileMentions(
  value: string
): WorkspaceFileMentionSegment[] {
  const segments: WorkspaceFileMentionSegment[] = [];
  let textStart = 0;
  let index = 0;

  while (index < value.length) {
    if (value[index] !== "@" || (index > 0 && isAsciiAddressCharacter(value[index - 1]))) {
      index += 1;
      continue;
    }

    let end = index + 1;
    let filePath = "";
    if (value[end] === '"') {
      const closingQuote = value.indexOf('"', end + 1);
      if (closingQuote < 0) {
        index += 1;
        continue;
      }
      filePath = value.slice(end + 1, closingQuote);
      end = closingQuote + 1;
    } else {
      while (end < value.length && !isMentionBoundary(value[end]) && value[end] !== "@") {
        end += 1;
      }
      while (end > index + 1 && /[.]/.test(value[end - 1])) end -= 1;
      filePath = value.slice(index + 1, end);
    }

    if (!looksLikeWorkspaceFile(filePath)) {
      index += 1;
      continue;
    }

    if (textStart < index) {
      segments.push({ kind: "text", value: value.slice(textStart, index) });
    }
    segments.push({
      kind: "mention",
      value: value.slice(index, end),
      path: filePath.replace(/\\/g, "/")
    });
    textStart = end;
    index = end;
  }

  if (textStart < value.length) {
    segments.push({ kind: "text", value: value.slice(textStart) });
  }
  return segments.length > 0 ? segments : [{ kind: "text", value }];
}
