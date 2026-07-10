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

const BINARY_ATTACHMENT_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "pdf"]);

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

export function extensionFromMime(mimeType: string): string | null {
  switch (mimeType.toLowerCase().split(";")[0].trim()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "application/pdf":
      return "pdf";
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "md";
    case "application/json":
      return "json";
    case "text/csv":
      return "csv";
    default:
      return null;
  }
}

export function extensionFromName(name: string): string | null {
  const base = name.replace(/\\/g, "/").split("/").pop() || name;
  const idx = base.lastIndexOf(".");
  if (idx <= 0 || idx === base.length - 1) return null;
  const extension = base.slice(idx + 1).toLowerCase();
  return ATTACHMENT_EXTENSIONS.has(extension) ? extension : null;
}

export function detectMagicBinaryType(
  buffer: Buffer
): { extension: string; mimeType: string } | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }
  if (
    buffer.length >= 6 &&
    (buffer.toString("ascii", 0, 6) === "GIF87a" ||
      buffer.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return { extension: "gif", mimeType: "image/gif" };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { extension: "webp", mimeType: "image/webp" };
  }
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "%PDF") {
    return { extension: "pdf", mimeType: "application/pdf" };
  }
  return null;
}

function extensionsEquivalent(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) return true;
  return (
    (a === "jpg" || a === "jpeg") &&
    (b === "jpg" || b === "jpeg")
  );
}

export function mimeTypeCompatibleWithExtension(mimeType: string, extension: string): boolean {
  const normalizedMime = mimeType.toLowerCase().split(";")[0].trim();
  if (!normalizedMime || normalizedMime === "application/octet-stream") {
    return true;
  }
  const expectedMime = attachmentMimeFromExtension(extension);
  if (normalizedMime === expectedMime) return true;
  if (
    (extension === "jpg" || extension === "jpeg") &&
    (normalizedMime === "image/jpeg" || normalizedMime === "image/jpg")
  ) {
    return true;
  }
  if (normalizedMime.startsWith("text/")) {
    return !BINARY_ATTACHMENT_EXTENSIONS.has(extension.toLowerCase());
  }
  return false;
}

export function resolveManagedBufferAttachment(
  name: string,
  mimeType: string,
  buffer: Buffer
): { extension: string; mimeType: string } | { reason: "unsupported_type" } {
  const normalizedMime = (mimeType || "application/octet-stream").toLowerCase().split(";")[0].trim();
  const nameExtension = extensionFromName(name);
  const mimeExtension = extensionFromMime(mimeType);
  const detected = detectMagicBinaryType(buffer);

  if (detected) {
    if (nameExtension && !extensionsEquivalent(nameExtension, detected.extension)) {
      return { reason: "unsupported_type" };
    }
    if (!mimeTypeCompatibleWithExtension(normalizedMime, detected.extension)) {
      return { reason: "unsupported_type" };
    }
    return detected;
  }

  if (nameExtension && BINARY_ATTACHMENT_EXTENSIONS.has(nameExtension)) {
    return { reason: "unsupported_type" };
  }
  if (mimeExtension && BINARY_ATTACHMENT_EXTENSIONS.has(mimeExtension)) {
    return { reason: "unsupported_type" };
  }

  const extension = nameExtension ?? mimeExtension;
  if (!extension) {
    return { reason: "unsupported_type" };
  }
  if (nameExtension && mimeExtension && nameExtension !== mimeExtension) {
    return { reason: "unsupported_type" };
  }
  if (!mimeTypeCompatibleWithExtension(normalizedMime, extension)) {
    return { reason: "unsupported_type" };
  }

  return {
    extension,
    mimeType: attachmentMimeFromExtension(extension)
  };
}
