import fs from "node:fs";
import path from "node:path";

interface CodexAppServerWrapperInput {
  modelCatalogPath: string;
  codexAcpPath?: string;
  platform?: NodeJS.Platform;
}

interface CreateCodexAppServerWrapperInput
  extends CodexAppServerWrapperInput {
  dataDir: string;
}

export interface CodexAppServerWrapper {
  extension: ".cmd" | ".sh";
  contents: string;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function batchLiteral(value: string): string {
  return value.replace(/%/g, "%%");
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function safeCodexFilePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url").slice(0, 80);
}

function bundledCodexCandidates(
  codexAcpPath: string | undefined,
  platform: NodeJS.Platform
): string[] {
  if (!codexAcpPath) return [];
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalized = pathApi.normalize(codexAcpPath);
  const packageMarker = pathApi.join(
    "node_modules",
    "@agentclientprotocol",
    "codex-acp"
  );
  const markerIndex = normalized.toLowerCase().indexOf(packageMarker.toLowerCase());
  const packageRoot =
    markerIndex >= 0
      ? normalized.slice(0, markerIndex + packageMarker.length)
      : undefined;
  const shimRoot = pathApi.dirname(normalized);
  const extension = platform === "win32" ? ".cmd" : "";

  return unique([
    packageRoot
      ? pathApi.join(packageRoot, "node_modules", ".bin", `codex${extension}`)
      : undefined,
    pathApi.join(
      shimRoot,
      "node_modules",
      "@agentclientprotocol",
      "codex-acp",
      "node_modules",
      ".bin",
      `codex${extension}`
    ),
    pathApi.join(
      shimRoot,
      "node_modules",
      ".bin",
      `codex${extension}`
    )
  ]);
}

function buildWindowsWrapper(
  modelCatalogPath: string,
  codexAcpPath?: string
): string {
  const catalogArg = batchLiteral(
    `model_catalog_json=${modelCatalogPath}`
  );
  const bundledCandidates = bundledCodexCandidates(
    codexAcpPath,
    "win32"
  ).map(batchLiteral);
  const candidateBlocks = bundledCandidates
    .map(
      (candidate) => `if exist "${candidate}" (
  call "${candidate}" %* -c "${catalogArg}"
  exit /b
)`
    )
    .join("\r\n");

  return `@echo off\r
setlocal DisableDelayedExpansion\r
if defined FREEBUDDY_CODEX_BIN (\r
  call "%FREEBUDDY_CODEX_BIN%" %* -c "${catalogArg}"\r
  exit /b\r
)\r
${candidateBlocks}\r
where codex >nul 2>nul\r
if not errorlevel 1 (\r
  call codex %* -c "${catalogArg}"\r
  exit /b\r
)\r
echo FreeBuddy Codex BYOK wrapper could not find the codex binary. 1>&2\r
exit /b 127\r
`;
}

function buildPosixWrapper(
  modelCatalogPath: string,
  codexAcpPath?: string,
  platform: NodeJS.Platform = process.platform
): string {
  const catalogArg = `model_catalog_json=${JSON.stringify(modelCatalogPath)}`;
  const candidates = bundledCodexCandidates(codexAcpPath, platform)
    .map(shellSingleQuote)
    .join(" ");
  return `#!/bin/sh
catalog_arg=${shellSingleQuote(catalogArg)}
for candidate in "$FREEBUDDY_CODEX_BIN" ${candidates} "$(command -v codex 2>/dev/null)" "/opt/homebrew/bin/codex" "/usr/local/bin/codex"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    exec "$candidate" "$@" -c "$catalog_arg"
  fi
done
echo "FreeBuddy Codex BYOK wrapper could not find the codex binary." >&2
exit 127
`;
}

export function buildCodexAppServerWrapper(
  input: CodexAppServerWrapperInput
): CodexAppServerWrapper {
  const platform = input.platform ?? process.platform;
  return platform === "win32"
    ? {
        extension: ".cmd",
        contents: buildWindowsWrapper(
          input.modelCatalogPath,
          input.codexAcpPath
        )
      }
    : {
        extension: ".sh",
        contents: buildPosixWrapper(
          input.modelCatalogPath,
          input.codexAcpPath,
          platform
        )
      };
}

export function createCodexAppServerWrapper(
  input: CreateCodexAppServerWrapperInput
): string {
  const wrapper = buildCodexAppServerWrapper(input);
  const dir = path.join(input.dataDir, "codex-wrappers");
  fs.mkdirSync(dir, { recursive: true });
  const signature = safeCodexFilePart(input.modelCatalogPath);
  const file = path.join(dir, `${signature}${wrapper.extension}`);
  let currentContents: string | undefined;
  try {
    currentContents = fs.readFileSync(file, "utf8");
  } catch {
    // Create or repair the wrapper below.
  }
  if (currentContents !== wrapper.contents) {
    fs.writeFileSync(file, wrapper.contents, {
      encoding: "utf8",
      ...(wrapper.extension === ".sh" ? { mode: 0o755 } : {})
    });
  }
  if (
    wrapper.extension === ".sh" &&
    (fs.statSync(file).mode & 0o111) === 0
  ) {
    fs.chmodSync(file, 0o755);
  }
  return file;
}
