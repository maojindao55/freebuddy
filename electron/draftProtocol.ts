import fs from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  jsx: "text/javascript; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  tsx: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  wasm: "application/wasm",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf"
};

const ENTRY_CANDIDATES = [
  "index.html",
  "public/index.html",
  "dist/index.html",
  "build/index.html"
];

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function isWithinRoot(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root + path.sep);
}

export interface DraftRequestParams {
  root: string;
  rel: string;
}

export function parseDraftUrl(requestUrl: string): DraftRequestParams {
  const url = new URL(requestUrl);
  const rootRaw = url.searchParams.get("root");
  if (!rootRaw) throw new Error("Missing root");
  const root = path.resolve(decodeURIComponent(rootRaw));
  if (!path.isAbsolute(root)) throw new Error("root must be absolute");

  const relRaw = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const rel = relRaw === "" ? "index.html" : relRaw;
  return { root, rel };
}

export async function handleDraftRequest(
  request: Request
): Promise<Response> {
  try {
    const { root, rel } = parseDraftUrl(request.url);
    const abs = path.resolve(root, rel);
    if (!isWithinRoot(abs, root)) {
      return new Response("Forbidden", { status: 403 });
    }

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      return new Response("Not found", { status: 404 });
    }

    let filePath = abs;
    if (stat.isDirectory()) {
      filePath = path.join(abs, "index.html");
      try {
        await fs.stat(filePath);
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }

    const data = await fs.readFile(filePath);
    return new Response(data, {
      headers: {
        "Content-Type": mimeForPath(filePath),
        "Cache-Control": "no-cache"
      }
    });
  } catch (error) {
    return new Response((error as Error).message, { status: 500 });
  }
}

export async function resolveDraftEntry(
  cwd: string
): Promise<string | null> {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  for (const candidate of ENTRY_CANDIDATES) {
    try {
      const full = path.join(cwd, candidate);
      const stat = await fs.stat(full);
      if (stat.isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}
