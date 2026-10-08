import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export function localDiffFixture(t, diffs, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? "agy-acp-diffs-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const payload = Buffer.from(JSON.stringify({ version: 1, diffs, ...options.body }));
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const filename = path.join(directory, `${sha256}-${randomBytes(8).toString("hex")}.json`);
  fs.writeFileSync(filename, payload, { mode: 0o600 });
  const descriptor = { path: filename, sha256, bytes: payload.length };
  const update = { sessionUpdate: "tool_call_update", toolCallId: "large-edit", status: "completed",
    content: [{ type: "diff", path: diffs[0]?.path ?? "task.md", oldText: null, newText: "",
      _meta: { freebuddy: { action: "create", localDiffFile: descriptor } } }] };
  return { directory, filename, payload, descriptor, update };
}
