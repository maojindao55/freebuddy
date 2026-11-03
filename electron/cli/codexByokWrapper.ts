/**
 * Platform-specific Codex BYOK wrappers that inject model_catalog_json and the
 * BYOK provider definition via `-c` when codex-acp spawns the real Codex binary
 * through CODEX_PATH.
 *
 * The provider must reach codex's *config layer*, not just the JSON-RPC
 * `thread/start` request that codex-acp already sends. codex 0.166.0 added a
 * `modelProviderMismatch` check on every turn: the provider recorded on the
 * thread must equal the provider the config layer resolves, so a thread whose
 * provider only existed in the request failed with
 * "This chat uses provider-…, but your current provider is openai". Repeating
 * the provider through `-c` keeps 0.165.0 working (it ignores the extra layer)
 * and satisfies 0.166.0+.
 */

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface CodexByokProviderConfig {
  providerId: string;
  providerName?: string;
  baseUrl?: string;
  envKey?: string;
}

/** TOML literal string: single quotes, no escape processing. */
function tomlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * `-c model_provider='<id>'` plus `-c model_providers={<id>={…}}`.
 *
 * The key and values are TOML *literal* strings, so the payload never contains a
 * double quote — safe to hand to `cmd.exe` and `sh` alike, and safe for ids with
 * dots or spaces. Returns `[]` when the provider cannot be described.
 */
export function buildCodexProviderConfigArgs(
  provider: CodexByokProviderConfig | undefined
): string[] {
  const providerId = provider?.providerId?.trim();
  const baseUrl = provider?.baseUrl?.trim();
  if (!providerId || !baseUrl) return [];
  // codex rejects an empty provider name outright.
  const name = provider?.providerName?.trim() || providerId;
  const envKey = provider?.envKey?.trim() || "OPENAI_API_KEY";
  // codex only speaks the Responses wire API; chat/completions providers are
  // reached through FreeBuddy's local Responses↔chat bridge, so the base_url
  // here already points at that bridge when needed.
  const wireApi = "responses";
  const entry =
    `{name=${tomlLiteral(name)},base_url=${tomlLiteral(baseUrl)},` +
    `env_key=${tomlLiteral(envKey)},wire_api=${tomlLiteral(wireApi)}}`;
  return [
    `model_provider=${tomlLiteral(providerId)}`,
    `model_providers={${tomlLiteral(providerId)}=${entry}}`
  ];
}

export function buildCodexAppServerWrapperContent(
  modelCatalogPath: string,
  platform: NodeJS.Platform = process.platform,
  provider?: CodexByokProviderConfig
): { extension: ".cmd" | ".sh"; script: string } {
  if (platform === "win32") {
    // codex-acp on Windows spawns: `"${CODEX_PATH}" app-server` with shell:true,
    // so a .cmd launcher is required (.sh is not executable under cmd.exe).
    // Keep the catalog path in its own variable so nested quotes from
    // JSON.stringify do not break `set "VAR=..."`.
    // FREEBUDDY_CODEX_BIN may point at the bundled `@openai/codex/bin/codex.js`
    // (same entry codex-acp uses when CODEX_PATH is unset); invoke that via node.
    const catalogPathCmd = modelCatalogPath
      .replace(/\//g, "\\")
      .replace(/%/g, "%%");
    // `-c` values are TOML literal strings, so they carry no double quotes; only
    // a literal `%` needs doubling for cmd.exe. Appended inline after the
    // existing model_catalog_json argument, exactly like the catalog path.
    const providerArgsCmd = buildCodexProviderConfigArgs(provider)
      .map((arg) => ` -c "${arg.replace(/%/g, "%%")}"`)
      .join("");
    const script = `@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
set "FREEBUDDY_CATALOG_PATH=${catalogPathCmd}"
set "NODE_BIN=node"
if defined FREEBUDDY_NODE_BIN if exist "%FREEBUDDY_NODE_BIN%" set "NODE_BIN=%FREEBUDDY_NODE_BIN%"
if defined FREEBUDDY_CODEX_BIN if exist "%FREEBUDDY_CODEX_BIN%" (
  if /i "%FREEBUDDY_CODEX_BIN:~-3%"==".js" (
    "%NODE_BIN%" "%FREEBUDDY_CODEX_BIN%" %* -c "model_catalog_json=%FREEBUDDY_CATALOG_PATH%"${providerArgsCmd}
  ) else if /i "%FREEBUDDY_CODEX_BIN:~-4%"==".cmd" (
    call "%FREEBUDDY_CODEX_BIN%" %* -c "model_catalog_json=%FREEBUDDY_CATALOG_PATH%"${providerArgsCmd}
  ) else (
    "%FREEBUDDY_CODEX_BIN%" %* -c "model_catalog_json=%FREEBUDDY_CATALOG_PATH%"${providerArgsCmd}
  )
  exit /b %ERRORLEVEL%
)
where codex >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%I in ('where codex 2^>nul') do (
    "%%I" %* -c "model_catalog_json=%FREEBUDDY_CATALOG_PATH%"${providerArgsCmd}
    exit /b %ERRORLEVEL%
  )
)
if defined APPDATA if exist "%APPDATA%\\npm\\codex.cmd" (
  call "%APPDATA%\\npm\\codex.cmd" %* -c "model_catalog_json=%FREEBUDDY_CATALOG_PATH%"${providerArgsCmd}
  exit /b %ERRORLEVEL%
)
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\\Yarn\\bin\\codex.cmd" (
  call "%LOCALAPPDATA%\\Yarn\\bin\\codex.cmd" %* -c "model_catalog_json=%FREEBUDDY_CATALOG_PATH%"${providerArgsCmd}
  exit /b %ERRORLEVEL%
)
echo FreeBuddy Codex BYOK wrapper could not find the codex binary. 1>&2
exit /b 127
`;
    return { extension: ".cmd", script };
  }

  const catalogArg = `model_catalog_json=${JSON.stringify(modelCatalogPath)}`;
  // Each provider argument is appended as its own shell word via `set --`, so no
  // quoting inside a variable is ever re-parsed. Every value needs its own `-c`.
  const providerWords = buildCodexProviderConfigArgs(provider)
    .map((arg) => ` -c ${shellSingleQuote(arg)}`)
    .join("");
  const script = `#!/bin/sh
catalog_arg=${shellSingleQuote(catalogArg)}
set -- "$@" -c "$catalog_arg"${providerWords}
node_bin=\${FREEBUDDY_NODE_BIN:-node}
if [ -n "$FREEBUDDY_CODEX_BIN" ] && [ -f "$FREEBUDDY_CODEX_BIN" ]; then
  case "$FREEBUDDY_CODEX_BIN" in
    *.js) exec "$node_bin" "$FREEBUDDY_CODEX_BIN" "$@" ;;
    *)
      if [ -x "$FREEBUDDY_CODEX_BIN" ]; then
        exec "$FREEBUDDY_CODEX_BIN" "$@"
      fi
      ;;
  esac
fi
for candidate in "$(command -v codex 2>/dev/null)" "/opt/homebrew/bin/codex" "/usr/local/bin/codex"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done
echo "FreeBuddy Codex BYOK wrapper could not find the codex binary." >&2
exit 127
`;
  return { extension: ".sh", script };
}
