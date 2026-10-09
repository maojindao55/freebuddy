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

export interface MacOpenWithServiceSpec {
  bundleId: string;
  productName: string;
}

export function macOpenWithServiceLabel(
  locale: string,
  productName: string
): string {
  return windowsContextMenuLabel(locale, productName);
}

export function macOpenWithServiceFileName(productName: string): string {
  return `Open with ${productName}.workflow`;
}

export function macOpenWithServiceScript(bundleId: string): string {
  return `open -b '${bundleId.replace(/'/g, "")}' "$@"`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildMacOpenWithServiceInfoPlist(
  spec: MacOpenWithServiceSpec
): string {
  const label = macOpenWithServiceLabel("en", spec.productName);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSBackgroundColorName</key>
      <string>background</string>
      <key>NSIconName</key>
      <string>NSShareTemplate</string>
      <key>NSMenuItem</key>
      <dict>
        <key>default</key>
        <string>${escapeXml(label)}</string>
      </dict>
      <key>NSMessage</key>
      <string>runWorkflowAsService</string>
      <key>NSRequiredContext</key>
      <dict>
        <key>NSApplicationIdentifier</key>
        <string>com.apple.finder</string>
      </dict>
      <key>NSSendFileTypes</key>
      <array>
        <string>public.item</string>
        <string>public.folder</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
`;
}

export function buildMacOpenWithServiceWorkflow(
  spec: MacOpenWithServiceSpec
): string {
  const script = escapeXml(macOpenWithServiceScript(spec.bundleId));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMDocumentVersion</key>
  <string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Optional</key>
          <false/>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.path</string>
          </array>
        </dict>
        <key>AMActionVersion</key>
        <string>2.0.3</string>
        <key>AMApplication</key>
        <array>
          <string>Automator</string>
        </array>
        <key>AMParameterProperties</key>
        <dict>
          <key>COMMAND_STRING</key>
          <dict/>
          <key>CheckedForUserDefaultShell</key>
          <dict/>
          <key>inputMethod</key>
          <dict/>
          <key>shell</key>
          <dict/>
          <key>source</key>
          <dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.path</string>
          </array>
        </dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key>
        <string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key>
          <string>${script}</string>
          <key>CheckedForUserDefaultShell</key>
          <true/>
          <key>inputMethod</key>
          <integer>1</integer>
          <key>shell</key>
          <string>/bin/zsh</string>
          <key>source</key>
          <string></string>
        </dict>
        <key>BundleIdentifier</key>
        <string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key>
        <string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key>
        <false/>
        <key>CanShowWhenRun</key>
        <true/>
        <key>Category</key>
        <array>
          <string>AMCategoryUtilities</string>
        </array>
        <key>Class Name</key>
        <string>RunShellScriptAction</string>
        <key>InputUUID</key>
        <string>8f3c1a62-0b4e-4d5a-9c7f-2a1d6b8e4c90</string>
        <key>Keywords</key>
        <array>
          <string>Shell</string>
        </array>
        <key>OutputUUID</key>
        <string>b2d91e04-7c53-4aa1-8f16-5e0c9a47d2bb</string>
        <key>UUID</key>
        <string>d4a77c18-9e2f-4b80-a631-1c8f5d0e93aa</string>
        <key>UnlocalizedApplications</key>
        <array>
          <string>Automator</string>
        </array>
      </dict>
    </dict>
  </array>
  <key>connectors</key>
  <dict/>
  <key>workflowTypeIdentifier</key>
  <string>com.apple.Automator.quickAction</string>
</dict>
</plist>
`;
}

export function writeMacOpenWithService(
  appBundlePath: string,
  spec: MacOpenWithServiceSpec
): string {
  const workflowRoot = path.join(
    appBundlePath,
    "Contents",
    "Library",
    "Services",
    macOpenWithServiceFileName(spec.productName)
  );
  const contentsDir = path.join(workflowRoot, "Contents");
  const resourcesZh = path.join(contentsDir, "Resources", "zh_CN.lproj");
  fs.mkdirSync(resourcesZh, { recursive: true });
  fs.writeFileSync(
    path.join(contentsDir, "Info.plist"),
    buildMacOpenWithServiceInfoPlist(spec),
    "utf8"
  );
  fs.writeFileSync(
    path.join(contentsDir, "document.wflow"),
    buildMacOpenWithServiceWorkflow(spec),
    "utf8"
  );
  const englishLabel = macOpenWithServiceLabel("en", spec.productName);
  const chineseLabel = macOpenWithServiceLabel("zh-CN", spec.productName);
  fs.writeFileSync(
    path.join(resourcesZh, "InfoPlist.strings"),
    `"${englishLabel.replace(/"/g, '\\"')}" = "${chineseLabel.replace(/"/g, '\\"')}";\n`,
    "utf8"
  );
  return workflowRoot;
}
