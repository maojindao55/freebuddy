import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  extensionFromMime,
  extensionFromName,
  resolveManagedBufferAttachment
} from "../shared/managedBufferValidation.js";
import { getDataDir, getDb } from "./db.js";

export {
  detectMagicBinaryType,
  extensionFromMime,
  extensionFromName,
  mimeTypeCompatibleWithExtension,
  resolveManagedBufferAttachment
} from "../shared/managedBufferValidation.js";

export const MANAGED_ATTACHMENTS_DIR_NAME = "managed-attachments";
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const ATTACHMENT_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "pdf",
  "txt",
  "md",
  "json",
  "csv",
  "log",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "rs",
  "go",
  "java",
  "php",
  "html",
  "css",
  "scss",
  "yaml",
  "yml",
  "toml",
  "xml",
  "sh"
]);

export interface AttachmentCandidateResult {
  path: string;
  name: string;
  size: number;
  extension: string;
  mimeType: string;
  managed?: boolean;
  created?: boolean;
}

export type PrepareAttachmentPayload =
  | { kind: "path"; path: string }
  | {
      kind: "buffer";
      name: string;
      mimeType: string;
      size: number;
      data: ArrayBuffer | Buffer;
    };

function attachmentMimeFromExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "pdf":
      return "application/pdf";
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    default:
      return "text/plain";
  }
}

export function getManagedAttachmentsDir(): string {
  const dir = path.join(getDataDir(), MANAGED_ATTACHMENTS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rejectPathAttachment(
  filePath: string
): AttachmentPrepareRejection | AttachmentCandidateResult {
  const name = path.basename(filePath) || filePath;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { name, reason: "unsupported_type" };
    }
    const extension = path.extname(filePath).replace(/^\./, "").toLowerCase();
    if (!ATTACHMENT_EXTENSIONS.has(extension)) {
      return { name, reason: "unsupported_type" };
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      return { name, reason: "file_too_large" };
    }
    const managed = isManagedAttachmentPath(filePath);
    return {
      path: filePath,
      name,
      size: stat.size,
      extension,
      mimeType: attachmentMimeFromExtension(extension),
      ...(managed ? { managed: true } : {})
    };
  } catch {
    return { name, reason: "unsupported_type" };
  }
}

export interface AttachmentPrepareRejection {
  name: string;
  reason: "unsupported_type" | "file_too_large";
}

export interface PrepareAttachmentFilesResult {
  candidates: AttachmentCandidateResult[];
  rejections: AttachmentPrepareRejection[];
}

function writeManagedAttachment(
  name: string,
  mimeType: string,
  size: number,
  data: ArrayBuffer | Buffer
): AttachmentCandidateResult | AttachmentPrepareRejection {
  const displayName =
    name.trim() && name.trim() !== "blob" ? path.basename(name) : "clipboard-image";
  if (size > MAX_ATTACHMENT_BYTES) {
    return { name: displayName, reason: "file_too_large" };
  }

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    return { name: displayName, reason: "file_too_large" };
  }

  const resolved = resolveManagedBufferAttachment(name, mimeType, buffer);
  if ("reason" in resolved) {
    return { name: displayName, reason: resolved.reason };
  }

  const { extension, mimeType: resolvedMimeType } = resolved;
  const dir = getManagedAttachmentsDir();
  const fileName = `${crypto.randomUUID()}.${extension}`;
  const filePath = path.join(dir, fileName);

  fs.writeFileSync(filePath, buffer);
  const stat = fs.statSync(filePath);
  const resolvedName =
    name.trim() && name.trim() !== "blob"
      ? path.basename(name)
      : `clipboard-${fileName}`;

  return {
    path: filePath,
    name: resolvedName,
    size: stat.size,
    extension,
    mimeType: resolvedMimeType,
    managed: true,
    created: true
  };
}

export function prepareAttachmentFiles(
  payloads: PrepareAttachmentPayload[]
): PrepareAttachmentFilesResult {
  const candidates: AttachmentCandidateResult[] = [];
  const rejections: AttachmentPrepareRejection[] = [];

  for (const payload of payloads) {
    if (payload.kind === "path") {
      const filePath = payload.path.trim();
      if (!filePath) continue;
      const outcome = rejectPathAttachment(filePath);
      if ("reason" in outcome) rejections.push(outcome);
      else candidates.push(outcome);
      continue;
    }

    const outcome = writeManagedAttachment(
      payload.name,
      payload.mimeType,
      payload.size,
      payload.data
    );
    if ("reason" in outcome) rejections.push(outcome);
    else candidates.push(outcome);
  }

  return { candidates, rejections };
}

export function isManagedAttachmentPath(filePath: string): boolean {
  const managedDir = path.resolve(getManagedAttachmentsDir());
  const resolved = path.resolve(filePath);
  return resolved === managedDir || resolved.startsWith(`${managedDir}${path.sep}`);
}

export function discardManagedAttachment(filePath: string): boolean {
  if (!isManagedAttachmentPath(filePath)) return false;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return true;
  } catch {
    return false;
  }
}

export function cleanupManagedAttachments(paths: string[]): void {
  for (const filePath of paths) {
    discardManagedAttachment(filePath);
  }
}

function parseManagedPathsFromAttachmentsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const attachments = JSON.parse(raw) as Array<{ path?: string; managed?: boolean }>;
    return attachments
      .filter(
        (attachment) =>
          typeof attachment.path === "string" &&
          (attachment.managed || isManagedAttachmentPath(attachment.path))
      )
      .map((attachment) => path.resolve(attachment.path!));
  } catch {
    return [];
  }
}

export function listReferencedManagedAttachmentPaths(): Set<string> {
  const referenced = new Set<string>();
  const rows = getDb()
    .prepare(
      `SELECT attachments FROM conversation_messages WHERE attachments IS NOT NULL`
    )
    .all() as Array<{ attachments: string | null }>;

  for (const row of rows) {
    for (const filePath of parseManagedPathsFromAttachmentsJson(row.attachments)) {
      referenced.add(filePath);
    }
  }
  return referenced;
}

export function countManagedAttachmentReferences(filePath: string): number {
  if (!isManagedAttachmentPath(filePath)) return 0;
  const target = path.resolve(filePath);
  let count = 0;
  const rows = getDb()
    .prepare(
      `SELECT attachments FROM conversation_messages WHERE attachments IS NOT NULL`
    )
    .all() as Array<{ attachments: string | null }>;

  for (const row of rows) {
    for (const managedPath of parseManagedPathsFromAttachmentsJson(row.attachments)) {
      if (managedPath === target) count += 1;
    }
  }
  return count;
}

export function discardManagedAttachmentIfUnreferenced(filePath: string): boolean {
  if (!isManagedAttachmentPath(filePath)) return false;
  if (countManagedAttachmentReferences(filePath) > 0) return false;
  return discardManagedAttachment(filePath);
}

export function cleanupManagedAttachmentsIfUnreferenced(paths: string[]): void {
  for (const filePath of paths) {
    discardManagedAttachmentIfUnreferenced(filePath);
  }
}

export function cleanupOrphanManagedAttachments(): number {
  const referenced = listReferencedManagedAttachmentPaths();
  const dir = getManagedAttachmentsDir();
  let removed = 0;

  for (const entry of fs.readdirSync(dir)) {
    const filePath = path.join(dir, entry);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    const resolved = path.resolve(filePath);
    if (!referenced.has(resolved)) {
      if (discardManagedAttachment(resolved)) removed += 1;
    }
  }

  return removed;
}
