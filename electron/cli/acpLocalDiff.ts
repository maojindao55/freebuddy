import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_BYTES = 8 * 1024 * 1024;
const owns = (stat: fs.Stats) => !process.getuid || stat.uid === process.getuid();

/** Only imports negotiated, same-host AGY artifacts; never arbitrary agent file URLs. */
export function importAgyLocalDiff(update: any, adapter: string): { update: any; imported: boolean; release: () => void } {
  const files: string[] = [];
  const result = { update, imported: false, release: () => {
    for (const file of files) { try { fs.unlinkSync(file); } catch { /* agent may have exited */ } }
  } };
  if (adapter !== "agy-acp" || !Array.isArray(update?.content)) return result;
  const content = update.content.flatMap((entry: any) => {
    const descriptor = entry?._meta?.freebuddy?.localDiffFile;
    if (!descriptor) return [entry];
    try {
      if (entry.type !== "diff" || typeof descriptor.path !== "string" || !path.isAbsolute(descriptor.path)
        || typeof descriptor.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.sha256)
        || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > MAX_BYTES) throw new Error("Invalid diff descriptor");
      const tmp = fs.realpathSync(os.tmpdir());
      const dir = path.dirname(descriptor.path);
      const dirStat = fs.lstatSync(dir);
      if (!dirStat.isDirectory() || !owns(dirStat) || dirStat.isSymbolicLink()
        || fs.realpathSync(path.dirname(dir)) !== tmp || !/^agy-acp-diffs-[\w-]+$/.test(path.basename(dir))
        || !new RegExp(`^${descriptor.sha256}-[a-f0-9]{16}\\.json$`).test(path.basename(descriptor.path))) throw new Error("Invalid diff artifact location");
      const fileStat = fs.lstatSync(descriptor.path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || !owns(fileStat)) throw new Error("Invalid diff artifact file");
      const fd = fs.openSync(descriptor.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let payload: Buffer;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || !owns(stat) || stat.size !== descriptor.bytes) throw new Error("Diff artifact size changed");
        payload = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < payload.length) {
          const read = fs.readSync(fd, payload, offset, Math.min(64 * 1024, payload.length - offset), offset);
          if (!read) throw new Error("Incomplete diff artifact");
          offset += read;
        }
      } finally { fs.closeSync(fd); }
      if (createHash("sha256").update(payload).digest("hex") !== descriptor.sha256) throw new Error("Diff artifact checksum mismatch");
      const body = JSON.parse(payload.toString("utf8"));
      if (body?.version !== 1 || !Array.isArray(body.diffs) || !body.diffs.length || body.diffs.length > 4096
        || body.diffs.some((diff: any) => diff?.type !== "diff" || typeof diff.path !== "string" || !diff.path
          || [diff.patch, diff.oldText, diff.newText].some(value => value !== undefined && value !== null && typeof value !== "string"))
        || body.diffs[0].path !== entry.path) throw new Error("Invalid diff artifact content");
      files.push(descriptor.path);
      result.imported = true;
      return body.diffs;
    } catch {
      return [{ type: "diff", path: entry.path, oldText: entry.oldText, newText: "<truncated 1 bytes>",
        _meta: { freebuddy: { action: entry._meta?.freebuddy?.action, truncated: true } } },
      { type: "content", content: { type: "text", text: "Full diff artifact is unavailable or invalid." } }];
    }
  });
  result.update = { ...update, content };
  return result;
}

/** A storage error must not push imported megabytes into renderer IPC. */
export function withoutInlineFileBodies(items: any[]): any[] {
  return items.map(item => item.kind === "file-edit" ? {
    ...(item.blobKey ? item : { kind: item.kind, path: item.path, action: item.action, truncated: true }),
    oldText: undefined, newText: undefined, patch: undefined
  } : item.kind === "tool-call" ? {
    ...item, input: undefined,
    ...(item.toolOutputs ? { toolOutputs: withoutInlineFileBodies(item.toolOutputs) } : {})
  } : item);
}
