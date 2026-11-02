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
  "build/index.html",
  "out/index.html",
  "storybook-static/index.html",
  "docs/index.html",
  "site/index.html",
  "app/index.html",
  "src/index.html",
  "www/index.html"
];

const FRAMEWORK_ENTRY_CANDIDATES: Record<string, string[]> = {
  vite: ["index.html", "dist/index.html"],
  next: ["out/index.html"],
  nuxt: ["dist/index.html", ".output/public/index.html"],
  astro: ["dist/index.html"],
  svelte: ["build/index.html", "dist/index.html"],
  angular: ["dist/index.html"],
  vue: ["index.html", "dist/index.html"],
  react: ["index.html", "build/index.html", "dist/index.html"],
  preact: ["index.html", "dist/index.html"],
  solid: ["index.html", "dist/index.html"]
};

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function isWithinRoot(target: string, root: string): boolean {
  const normTarget = path.normalize(target);
  const normRoot = path.normalize(root);
  if (process.platform === "win32" || process.platform === "darwin") {
    const tLower = normTarget.toLowerCase();
    const rLower = normRoot.toLowerCase();
    if (tLower === rLower) return true;
    return tLower.startsWith(rLower.endsWith(path.sep) ? rLower : rLower + path.sep);
  }
  if (normTarget === normRoot) return true;
  return normTarget.startsWith(normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep);
}

export interface BrowserRequestParams {
  root: string;
  rel: string;
}

function parsePathRootUrl(url: URL): BrowserRequestParams | null {
  const raw = url.pathname.replace(/^\//, "");
  const parts = raw.split("/");
  if (parts.length < 2 || !parts[0]) return null;
  const root = path.resolve(decodeURIComponent(parts[0]));
  if (!path.isAbsolute(root)) return null;
  const rel = parts.slice(1).map(decodeURIComponent).join("/") || "index.html";
  return { root, rel };
}

export function parseBrowserUrl(requestUrl: string): BrowserRequestParams {
  const url = new URL(requestUrl);
  const rootRaw = url.searchParams.get("root");
  if (rootRaw) {
    const root = path.resolve(decodeURIComponent(rootRaw));
    if (!path.isAbsolute(root)) throw new Error("root must be absolute");
    const relRaw = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const rel = relRaw === "" ? "index.html" : relRaw;
    return { root, rel };
  }

  const pathRoot = parsePathRootUrl(url);
  if (pathRoot) return pathRoot;
  throw new Error("Missing root");
}

export async function handleBrowserRequest(
  request: Request
): Promise<Response> {
  try {
    const { root, rel } = parseBrowserUrl(request.url);
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

async function isFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readPackageCandidates(cwd: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {})
    };
    const scripts = Object.values(pkg.scripts ?? {}).join(" ").toLowerCase();
    const names = new Set<string>();
    for (const name of Object.keys(FRAMEWORK_ENTRY_CANDIDATES)) {
      if (deps[name] || scripts.includes(name)) names.add(name);
    }
    if (deps["@vitejs/plugin-react"] || deps["@vitejs/plugin-vue"]) names.add("vite");
    if (deps["@sveltejs/kit"]) names.add("svelte");
    return [...names].flatMap((name) => FRAMEWORK_ENTRY_CANDIDATES[name] ?? []);
  } catch {
    return [];
  }
}

async function discoverHtmlCandidates(cwd: string): Promise<string[]> {
  const dirs = [".", "public", "dist", "build", "out"];
  const candidates: string[] = [];
  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(path.join(cwd, dir), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) {
          candidates.push(dir === "." ? entry.name : `${dir}/${entry.name}`);
        }
      }
    } catch {
      // try next directory
    }
  }
  return candidates;
}

const DOCUMENT_EXTENSIONS = new Set([
  "md", "markdown", "mdx",
  "txt", "log", "json", "jsonc", "json5", "yaml", "yml", "csv", "tsv",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "php", "go", "rs", "java", "kt", "kts", "swift", "scala",
  "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "cs",
  "rb", "lua", "pl", "pm", "r", "dart", "ex", "exs", "erl", "clj",
  "sql", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "toml", "ini", "conf", "cfg", "env", "properties",
  "xml", "plist", "graphql", "gql", "proto", "prisma",
  "vue", "svelte", "astro", "css", "scss", "sass", "less", "styl",
  "lock", "gitignore", "dockerignore", "editorconfig",
  "dockerfile", "makefile", "license"
]);

export async function readBrowserMarkdown(
  cwd: string,
  rel: string
): Promise<string | null> {
  if (!cwd || !path.isAbsolute(cwd) || !rel) return null;
  const cleanRel = rel
    .split("?")[0]
    .split("#")[0]
    .replace(/:(\d+)(?::\d+)?$/, "")
    .trim();
  if (!cleanRel) return null;
  const root = path.resolve(cwd);
  const filePath = path.resolve(root, cleanRel);
  if (!isWithinRoot(filePath, root)) return null;
  const base = path.basename(filePath);
  const dotIndex = base.lastIndexOf(".");
  const ext = dotIndex >= 0 ? base.slice(dotIndex + 1).toLowerCase() : base.toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(ext)) return null;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function resolveBrowserEntry(
  cwd: string
): Promise<string | null> {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  const root = path.resolve(cwd);
  const candidates = [
    ...ENTRY_CANDIDATES,
    ...(await readPackageCandidates(root)),
    ...(await discoverHtmlCandidates(root))
  ];
  for (const candidate of [...new Set(candidates)]) {
    const full = path.resolve(root, candidate);
    if (!isWithinRoot(full, root)) continue;
    if (await isFile(full)) return candidate;
  }
  return null;
}
