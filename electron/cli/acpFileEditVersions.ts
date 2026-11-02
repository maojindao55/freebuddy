import { applyFileEditPatch } from "@freebuddy/cli-stream";
import type { CliStreamItem } from "@freebuddy/protocol";

type FileEdit = Extract<CliStreamItem, { kind: "file-edit" }>;

/** Claude's displayed diff bodies are hunk projections; its response has the original document. */
export function fileEditFromToolResponse(update: any): FileEdit | undefined {
  const metadata = update?._meta?.claudeCode;
  const response = metadata?.toolResponse;
  if (metadata?.toolName !== "Edit" || update.status === "failed" || !response ||
    typeof response.filePath !== "string" || !response.filePath || typeof response.originalFile !== "string") return;
  const before = response.originalFile;
  if (before.length > 4 * 1024 * 1024) return;
  let after: string | undefined;
  if (Array.isArray(response.structuredPatch) && response.structuredPatch.length) {
    if (response.structuredPatch.length > 4096) return;
    const patches: string[] = [];
    for (const hunk of response.structuredPatch) {
      if (!hunk || ![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]
        .every(value => Number.isSafeInteger(value) && value >= 0) ||
        !Array.isArray(hunk.lines) || !hunk.lines.every((line: unknown) => typeof line === "string")) return;
      patches.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`);
    }
    const patch = patches.join("\n");
    if (patch.length > 400_000) return;
    after = applyFileEditPatch(before, patch);
  } else if (response.userModified !== true && typeof response.oldString === "string" && response.oldString &&
    typeof response.newString === "string") {
    const position = before.indexOf(response.oldString);
    if (position < 0) return;
    if (response.replaceAll === true) after = before.split(response.oldString).join(response.newString);
    else if (before.indexOf(response.oldString, position + 1) < 0) {
      after = before.slice(0, position) + response.newString + before.slice(position + response.oldString.length);
    }
  }
  if (after !== undefined) return { kind: "file-edit", path: response.filePath, action: "update", oldText: before, newText: after };
}
