import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Keep this list aligned with `ATTACHMENT_EXTENSIONS` in attachments.ts.
 * This module must stay Electron-free so tests can import it without sqlite.
 */
export const SHELL_OPEN_FILE_EXTENSIONS = new Set([
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
  "sh",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "zip",
  "tar",
  "gz",
  "7z",
  "rar"
]);

export const SHELL_OPEN_FLAG = "--open";

const PROTOCOL_PREFIXES = ["freebuddy://", "freebuddy-dev://"];

export interface ShellOpenCollectOptions {
  execPath: string;
  appPath?: string;
}

export interface ShellOpenTarget {
  cwd?: string;
  files: string[];
}

export interface WindowsContextMenuSpec {
  exePath: string;
  appPath?: string;
  packaged: boolean;
  locale: string;
  productName: string;
  isDevInstance: boolean;
}

export type PathKind = "file" | "directory" | "missing";

function sameResolvedPath(left: string, right: string | undefined): boolean {
  if (!right) return false;
  try {
    return path.resolve(left) === path.resolve(right);
  } catch {
    return false;
  }
}

function isProtocolUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return PROTOCOL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function unwrapArg(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function isSupportedShellOpenFile(filePath: string): boolean {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return ext.length > 0 && SHELL_OPEN_FILE_EXTENSIONS.has(ext);
}

export function collectShellOpenPaths(
  argv: readonly string[],
  options: ShellOpenCollectOptions
): string[] {
  const out: string[] = [];
  const skip = new Set<string>();
  const rememberSkip = (value: string | undefined) => {
    if (!value) return;
    try {
      skip.add(path.resolve(value));
    } catch {
      skip.add(value);
    }
  };
  rememberSkip(options.execPath);
  rememberSkip(options.appPath);

  const pushPath = (raw: string) => {
    const value = unwrapArg(raw);
    if (!value || isProtocolUrl(value)) return;
    try {
      if (skip.has(path.resolve(value))) return;
    } catch {
      return;
    }
    out.push(value);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === SHELL_OPEN_FLAG) {
      const next = argv[i + 1];
      if (next) {
        pushPath(next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${SHELL_OPEN_FLAG}=`)) {
      pushPath(arg.slice(SHELL_OPEN_FLAG.length + 1));
      continue;
    }
    if (arg === "--" || arg.startsWith("-")) continue;
    if (isProtocolUrl(arg)) continue;
    pushPath(arg);
  }

  return out;
}

export function classifyShellOpenPaths(
  rawPaths: readonly string[],
  kindOf: (candidate: string) => PathKind = defaultPathKind
): ShellOpenTarget {
  const directories: string[] = [];
  const files: string[] = [];
  const unresolvedFiles: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawPaths) {
    const resolved = path.resolve(unwrapArg(raw));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const kind = kindOf(resolved);
    if (kind === "directory") {
      directories.push(resolved);
      continue;
    }
    if (kind === "file") {
      if (isSupportedShellOpenFile(resolved)) files.push(resolved);
      else unresolvedFiles.push(resolved);
    }
  }

  if (directories.length > 0) {
    return { cwd: directories[0], files };
  }
  const fallback = files[0] ?? unresolvedFiles[0];
  return {
    ...(fallback ? { cwd: path.dirname(fallback) } : {}),
    files
  };
}

function defaultPathKind(candidate: string): PathKind {
  try {
    const stat = fs.statSync(candidate);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "missing";
  } catch {
    return "missing";
  }
}

export function windowsContextMenuVerb(isDevInstance: boolean): string {
  return isDevInstance ? "FreeBuddyDev" : "FreeBuddy";
}

export function windowsContextMenuLabel(locale: string, productName: string): string {
  const language = locale.toLowerCase();
  if (language.startsWith("zh")) return `使用 ${productName} 打开`;
  return `Open with ${productName}`;
}

export function windowsContextMenuCommand(
  spec: Pick<WindowsContextMenuSpec, "exePath" | "appPath" | "packaged">,
  placeholder: "%1" | "%V"
): string {
  const args = spec.packaged
    ? [quoteForCommand(spec.exePath), SHELL_OPEN_FLAG, `"${placeholder}"`]
    : [
        quoteForCommand(spec.exePath),
        quoteForCommand(spec.appPath || ""),
        SHELL_OPEN_FLAG,
        `"${placeholder}"`
      ];
  return args.filter((part) => part.length > 0).join(" ");
}

function quoteForCommand(value: string): string {
  if (!value) return "";
  return `"${value.replace(/"/g, "")}"`;
}

export function windowsContextMenuKeys(verb: string): string[] {
  return [
    `HKCU\\Software\\Classes\\Directory\\shell\\${verb}`,
    `HKCU\\Software\\Classes\\Directory\\Background\\shell\\${verb}`,
    `HKCU\\Software\\Classes\\Drive\\shell\\${verb}`,
    `HKCU\\Software\\Classes\\*\\shell\\${verb}`
  ];
}

export function buildWindowsContextMenuReg(spec: WindowsContextMenuSpec): string {
  const verb = windowsContextMenuVerb(spec.isDevInstance);
  const label = windowsContextMenuLabel(spec.locale, spec.productName);
  const icon = spec.exePath;
  const fileCommand = windowsContextMenuCommand(spec, "%1");
  const backgroundCommand = windowsContextMenuCommand(spec, "%V");
  const entries: Array<{ key: string; values: Array<[string, string]> }> = [
    {
      key: `HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\${verb}`,
      values: [
        ["", label],
        ["Icon", icon]
      ]
    },
    {
      key: `HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\${verb}\\command`,
      values: [["", fileCommand]]
    },
    {
      key: `HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\${verb}`,
      values: [
        ["", label],
        ["Icon", icon]
      ]
    },
    {
      key: `HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\${verb}\\command`,
      values: [["", backgroundCommand]]
    },
    {
      key: `HKEY_CURRENT_USER\\Software\\Classes\\Drive\\shell\\${verb}`,
      values: [
        ["", label],
        ["Icon", icon]
      ]
    },
    {
      key: `HKEY_CURRENT_USER\\Software\\Classes\\Drive\\shell\\${verb}\\command`,
      values: [["", fileCommand]]
    },
    {
      key: `HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\${verb}`,
      values: [
        ["", label],
        ["Icon", icon]
      ]
    },
    {
      key: `HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\${verb}\\command`,
      values: [["", fileCommand]]
    }
  ];

  const lines = ["Windows Registry Editor Version 5.00", ""];
  for (const entry of entries) {
    lines.push(`[${entry.key}]`);
    for (const [name, value] of entry.values) {
      const encoded = escapeRegSz(value);
      lines.push(name ? `"${name}"="${encoded}"` : `@="${encoded}"`);
    }
    lines.push("");
  }
  return `${lines.join("\r\n")}\r\n`;
}

function escapeRegSz(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function applyWindowsContextMenu(
  spec: WindowsContextMenuSpec,
  importReg: (filePath: string) => Promise<void> = importRegFile
): Promise<void> {
  if (process.platform !== "win32") return;
  if (!spec.packaged) return;
  const contents = buildWindowsContextMenuReg(spec);
  const filePath = path.join(
    os.tmpdir(),
    `freebuddy-context-menu-${windowsContextMenuVerb(spec.isDevInstance)}.reg`
  );
  fs.writeFileSync(filePath, `\uFEFF${contents}`, "utf16le");
  try {
    await importReg(filePath);
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

async function importRegFile(filePath: string): Promise<void> {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const regExe = path.win32.join(systemRoot, "System32", "reg.exe");
  await execFileAsync(regExe, ["import", filePath], {
    windowsHide: true
  });
}
