import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

/** Read bridge IDs without rewriting its state, so opting back into the bridge is safe. */
export function resolveAntigravitySession(
  sessionId: string,
  home = os.homedir()
): { sessionId?: string; migrated: boolean } {
  const file = path.join(home, ".agy-acp", "sessions", createHash("sha256").update(sessionId).digest("hex") + ".json");
  let record: any;
  try {
    record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record?.sessionId !== sessionId) throw new Error("Invalid Antigravity bridge session record");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      record = JSON.parse(fs.readFileSync(path.join(home, ".agy-acp-state.json"), "utf8"))?.sessions?.[sessionId];
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") throw legacyError;
    }
  }
  if (!record) return { sessionId, migrated: false };
  if (typeof record !== "object" || Array.isArray(record) ||
      (record.sessionId !== undefined && record.sessionId !== sessionId)) {
    throw new Error("Invalid Antigravity bridge session record");
  }
  // A deleted or never-started bridge session has no native history to reopen.
  if (record.deleted || !record.conversationId) return { migrated: true };
  if (typeof record.conversationId !== "string" || !record.conversationId.trim()) {
    throw new Error("Invalid Antigravity conversation ID in bridge state");
  }
  return { sessionId: record.conversationId, migrated: true };
}
