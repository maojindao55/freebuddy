import fs from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv"
};

export function buildAttachmentPreviewUrl(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  return `freebuddy-file://open?path=${encodeURIComponent(normalized)}`;
}

export function resolveAttachmentFilePath(requestUrl: string): string {
  const url = new URL(requestUrl);

  if (url.hostname === "open") {
    const rawPath = url.searchParams.get("path");
    if (!rawPath) {
      throw new Error("Missing attachment path");
    }
    const decoded = decodeURIComponent(rawPath);
    const normalized = path.normalize(decoded);
    if (!path.isAbsolute(normalized)) {
      throw new Error("Attachment path must be absolute");
    }
    return normalized;
  }

  // Legacy host/path URLs: freebuddy-file://local/home/user/file.png
  const legacyPath = decodeURIComponent(
    `${url.pathname}${url.search}`.replace(/^\//, "")
  );
  const normalized = path.isAbsolute(legacyPath)
    ? path.normalize(legacyPath)
    : path.normalize(`/${legacyPath}`);
  if (!path.isAbsolute(normalized)) {
    throw new Error("Attachment path must be absolute");
  }
  return normalized;
}

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export async function handleFreebuddyFileRequest(
  request: Request
): Promise<Response> {
  try {
    const absolute = resolveAttachmentFilePath(request.url);
    const data = await fs.readFile(absolute);
    return new Response(data, {
      headers: {
        "Content-Type": mimeForPath(absolute),
        "Cache-Control": "private, max-age=3600"
      }
    });
  } catch (error) {
    return new Response((error as Error).message, { status: 404 });
  }
}
