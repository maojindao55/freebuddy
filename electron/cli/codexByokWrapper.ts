/**
 * Platform-specific Codex BYOK wrappers that inject model_catalog_json via `-c`
 * when codex-acp spawns the real Codex binary through CODEX_PATH.
 */

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCodexAppServerWrapperContent(
  modelCatalogPath: string,
  platform: NodeJS.Platform = process.platform
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
    const script = `@echo off
setlocal EnableExtensions
set "FREEBUDDY_CATALOG_PATH=${catalogPathCmd}"
set "NODE_BIN=node"
if defined FREEBUDDY_NODE_BIN if exist "%FREEBUDDY_NODE_BIN%" set "NODE_BIN=%FREEBUDDY_NODE_BIN%"
if defined FREEBUDDY_CODEX_BIN if exist "%FREEBUDDY_CODEX_BIN%" (
  if /i "%FREEBUDDY_CODEX_BIN:~-3%"==".js" (
    "%NODE_BIN%" "%FREEBUDDY_CODEX_BIN%" %* -c "model_catalog_json=%FREEBUDDY_CATALOG_PATH%"
  ) else if /i "%FREEBUDDY_CODEX_BIN:~-4%"==".cmd" (
    call "%FREEBUDDY_CODEX_BIN%" %* -c "model_catalog_json=%FREEBUDDY_CATALOG_PATH%"
  ) else (
    "%FREEBUDDY_CODEX_BIN%" %* -c "model_catalog_json=%FREEBUDDY_CATALOG_PATH%"
  )
  exit /b %ERRORLEVEL%
)
where codex >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%I in ('where codex 2^>nul') do (
    "%%I" %* -c "model_catalog_json=%FREEBUDDY_CATALOG_PATH%"
    exit /b %ERRORLEVEL%
  )
)
if defined APPDATA if exist "%APPDATA%\\npm\\codex.cmd" (
  call "%APPDATA%\\npm\\codex.cmd" %* -c "model_catalog_json=%FREEBUDDY_CATALOG_PATH%"
  exit /b %ERRORLEVEL%
)
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\\Yarn\\bin\\codex.cmd" (
  call "%LOCALAPPDATA%\\Yarn\\bin\\codex.cmd" %* -c "model_catalog_json=%FREEBUDDY_CATALOG_PATH%"
  exit /b %ERRORLEVEL%
)
echo FreeBuddy Codex BYOK wrapper could not find the codex binary. 1>&2
exit /b 127
`;
    return { extension: ".cmd", script };
  }

  const catalogArg = `model_catalog_json=${JSON.stringify(modelCatalogPath)}`;
  const script = `#!/bin/sh
catalog_arg=${shellSingleQuote(catalogArg)}
node_bin=\${FREEBUDDY_NODE_BIN:-node}
if [ -n "$FREEBUDDY_CODEX_BIN" ] && [ -f "$FREEBUDDY_CODEX_BIN" ]; then
  case "$FREEBUDDY_CODEX_BIN" in
    *.js) exec "$node_bin" "$FREEBUDDY_CODEX_BIN" "$@" -c "$catalog_arg" ;;
    *)
      if [ -x "$FREEBUDDY_CODEX_BIN" ]; then
        exec "$FREEBUDDY_CODEX_BIN" "$@" -c "$catalog_arg"
      fi
      ;;
  esac
fi
for candidate in "$(command -v codex 2>/dev/null)" "/opt/homebrew/bin/codex" "/usr/local/bin/codex"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    exec "$candidate" "$@" -c "$catalog_arg"
  fi
done
echo "FreeBuddy Codex BYOK wrapper could not find the codex binary." >&2
exit 127
`;
  return { extension: ".sh", script };
}
