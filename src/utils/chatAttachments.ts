export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export type ChatAttachmentKind = "image" | "document" | "code";

export interface ChatAttachment {
  id: string;
  kind: ChatAttachmentKind;
  name: string;
  path: string;
  mimeType?: string;
  size?: number;
  extension?: string;
}

export interface AttachmentCandidate {
  path: string;
  name?: string;
  size?: number;
  mimeType?: string;
  mime_type?: string;
}

export type AttachmentValidationReason =
  | "unsupported_type"
  | "file_too_large";

export interface AttachmentClassification {
  kind: ChatAttachmentKind;
  extension: string;
  mimeType: string;
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif"
};

const DOCUMENT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  log: "text/plain"
};

const CODE_EXTENSIONS = new Set([
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

function fallbackId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `att-${random}`;
}

export function basenameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() || path;
}

export function extensionFromPath(path: string): string {
  const name = basenameFromPath(path);
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

export function classifyAttachmentPath(
  path: string
): AttachmentClassification | null {
  const extension = extensionFromPath(path);
  if (!extension) return null;

  const imageMime = IMAGE_MIME[extension];
  if (imageMime) return { kind: "image", extension, mimeType: imageMime };

  const documentMime = DOCUMENT_MIME[extension];
  if (documentMime) {
    return { kind: "document", extension, mimeType: documentMime };
  }

  if (CODE_EXTENSIONS.has(extension)) {
    return { kind: "code", extension, mimeType: "text/plain" };
  }

  return null;
}

export function createChatAttachment(
  candidate: AttachmentCandidate
): ChatAttachment | null {
  const path = candidate.path.trim();
  if (!path) return null;

  const classification = classifyAttachmentPath(path);
  if (!classification) return null;

  const mimeType = candidate.mimeType ?? candidate.mime_type;
  const attachment: ChatAttachment = {
    id: fallbackId(),
    kind: classification.kind,
    name: candidate.name?.trim() || basenameFromPath(path),
    path,
    mimeType: mimeType?.trim() || classification.mimeType,
    extension: classification.extension
  };

  if (
    typeof candidate.size === "number" &&
    Number.isFinite(candidate.size) &&
    candidate.size >= 0
  ) {
    attachment.size = candidate.size;
  }

  return attachment;
}

export function validateAttachmentCandidate(
  attachment: ChatAttachment | null
): { ok: true } | { ok: false; reason: AttachmentValidationReason } {
  if (!attachment) return { ok: false, reason: "unsupported_type" };
  if (
    typeof attachment.size === "number" &&
    attachment.size > MAX_ATTACHMENT_BYTES
  ) {
    return { ok: false, reason: "file_too_large" };
  }
  return { ok: true };
}

export function formatBytes(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) return `${Math.round(value)} B`;
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ${units[unitIndex]}`;
}

export function formatAttachmentForPrompt(
  attachment: ChatAttachment
): string {
  const mime = attachment.mimeType || attachment.extension || attachment.kind;
  const size =
    typeof attachment.size === "number" ? `, ${formatBytes(attachment.size)}` : "";
  return `- ${attachment.name} (${mime}${size}): ${attachment.path}`;
}

export function composeMessageWithAttachments(
  content: string,
  attachments: ChatAttachment[]
): string {
  const text = content.trim();
  if (attachments.length === 0) return text;

  const body = text || "请查看这些附件。";
  return `用户消息：\n${body}\n\n附件：\n${attachments.map(formatAttachmentForPrompt).join("\n")}`;
}

/**
 * Build a renderer-safe URL for a local attachment path. The custom
 * `freebuddy-file://` protocol is registered in the main process and reads the
 * file from disk so we can show image thumbnails without dropping webSecurity.
 */
export function attachmentPreviewUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").map((segment) => encodeURIComponent(segment));
  return `freebuddy-file://local${parts.join("/")}`;
}
