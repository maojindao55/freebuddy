import fs from "node:fs";
import { fileEditFromToolResponse } from "./acpFileEditVersions.js";
import type { CliStreamItem } from "@freebuddy/protocol";

type FileEdit = Extract<CliStreamItem, { kind: "file-edit" }>;
export type LoggedFileEdit = { source: Pick<FileEdit, "path" | "oldText" | "newText" | "patch">; edit: FileEdit };
const MAX_LOG_BYTES = 8 * 1024 * 1024;

/** Recover captured documents from a bounded run log, never from today's workspace files. */
export function readFileEditLogVersions(filename: string): Map<string, LoggedFileEdit[]> {
  const versions = new Map<string, LoggedFileEdit[]>();
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LOG_BYTES) return versions;
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    if (bytes !== stat.size) return versions;
    for (const line of buffer.subarray(0, bytes).toString("utf8").split("\n")) {
      try {
        const record = JSON.parse(line);
        if (record.type !== "stdout") continue;
        const event = JSON.parse(record.content);
        const update = event.params?.update;
        if (event.method !== "session/update" || update?.sessionUpdate !== "tool_call_update" || !update.toolCallId) continue;
        const edit = fileEditFromToolResponse(update);
        if (!edit) continue;
        const sources = (Array.isArray(update.content) ? update.content : [])
          .filter((entry: any) => entry?.type === "diff" && entry.path === edit.path && !entry._meta?.freebuddy?.truncated)
          .map((entry: any) => ({ source: { path: entry.path,
            ...(typeof entry.oldText === "string" ? { oldText: entry.oldText } : {}),
            ...(typeof entry.newText === "string" ? { newText: entry.newText } : {}),
            ...(typeof entry.patch === "string" && entry.patch.trim() ? { patch: entry.patch } : {}) }, edit }));
        if (sources.length) versions.set(String(update.toolCallId), sources);
      } catch { /* Partial or unrelated lines do not establish a captured document. */ }
    }
  } catch { /* Missing or inaccessible historical logs retain their stored captures. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return versions;
}
