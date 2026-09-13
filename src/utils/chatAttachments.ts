import i18next from "i18next";

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
  managed?: boolean;
  created?: boolean;
}

export interface AttachmentCandidate {
  path: string;
  name?: string;
  size?: number;
  mimeType?: string;
  mime_type?: string;
  managed?: boolean;
  created?: boolean;
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
  log: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar"
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

  if (candidate.managed) {
    attachment.managed = true;
  }
  if (candidate.created) {
    attachment.created = true;
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

  const body = text || i18next.t("attachments.review");
  return `${i18next.t("attachments.userMessage")}\n${body}\n\n${i18next.t("attachments.attached")}\n${attachments.map(formatAttachmentForPrompt).join("\n")}`;
}

/** True for POSIX absolute paths and Windows drive paths. */
export function isAbsoluteLocalPath(filePath: string): boolean {
  return /^([A-Za-z]:[\\/]|\/)/.test(filePath.trim());
}

/**
 * Resolve a workspace-relative or absolute local path. Relative paths require
 * `cwd`; without it they cannot be turned into a previewable absolute path.
 */
export function resolveLocalFilePath(filePath: string, cwd = ""): string {
  const normalized = filePath.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  if (isAbsoluteLocalPath(normalized)) return normalized;
  const root = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return "";
  const rel = normalized.replace(/^\.\//, "");
  if (!rel || rel.startsWith("../") || rel.includes("/../")) return "";
  return `${root}/${rel}`;
}

/**
 * Build a renderer-safe URL for a local attachment path. The custom
 * `freebuddy-file://` protocol is registered in the main process and reads the
 * file from disk so we can show image thumbnails without dropping webSecurity.
 */
export function attachmentPreviewUrl(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  if (typeof window !== "undefined" && window.freebuddy?.platform === "web") {
    const params = new URLSearchParams({ path: normalized });
    // <img> / <iframe> cannot send Authorization; include the session token so
    // restored localStorage logins still load workspace files.
    const token = window.freebuddy.sessionToken?.()?.trim();
    if (token) params.set("token", token);
    return `/api/attachment?${params.toString()}`;
  }
  return `freebuddy-file://open?path=${encodeURIComponent(normalized)}`;
}

/** Append auth + cache-buster query params for WebUI Draft image URLs. */
export function withWebMediaAuth(url: string, extra?: Record<string, string>): string {
  if (!url) return "";
  if (typeof window === "undefined" || window.freebuddy?.platform !== "web") {
    if (!extra) return url;
    const parsed = new URL(url, "http://local.invalid");
    for (const [key, value] of Object.entries(extra)) {
      parsed.searchParams.set(key, value);
    }
    return parsed.protocol.startsWith("http")
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.toString();
  }
  const parsed = new URL(url, "http://local.invalid");
  const token = window.freebuddy.sessionToken?.()?.trim();
  if (token) parsed.searchParams.set("token", token);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      parsed.searchParams.set(key, value);
    }
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
