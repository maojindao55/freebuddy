# FreeBuddy Windows Compatibility Design

**Date:** 2026-06-20
**Status:** Approved
**Scope:** Fix the runtime/launch/UX issues that prevent FreeBuddy from working correctly on Windows, while keeping macOS/Linux behavior unchanged.

## Context

FreeBuddy is an Electron + React 19 + Vite + TypeScript desktop AI workspace that shells out to
external AI coding agents (codex, claude, opencode, cursor) via `child_process.spawn`. A
compatibility audit found that packaging and CI already target Windows, but the **runtime path is
broken on Windows**:

- `spawn(...)` is called with `shell: false` against `npm` and npm-installed CLIs. On Windows those
  are `.cmd`/`.bat` shims, so spawning them without a shell fails with `ENOENT`.
- Process termination uses `SIGTERM`/`SIGKILL`, which Windows does not support; moreover
  `child.kill()` does not kill the process **tree**, leaving orphaned agent subprocesses.
- `BrowserWindow` uses the macOS-only `titleBarStyle: "hiddenInset"` +
  `trafficLightPosition` unconditionally.
- The maintainer release flow (`scripts/release.sh`) is bash-only; its tests assert bash.

Items already handled correctly (no change): `which`→`where` branching in `check.ts`,
`injectShellPath` early-return on win32, `app.dock.setIcon` darwin guard, `electron-builder.yml`
win/nsis config + `app-icon.ico`, CI `windows-latest` matrix, and `app.getPath("userData")` for DB.

## Goals

- Make **dev, launch, agent check/install, and agent execution** work on Windows.
- Make **Stop/kill** reliably terminate the whole agent process tree on Windows.
- Make the **window chrome** match platform conventions (no macOS chrome on Windows).
- Make the **maintainer release script** run on any OS without bash.
- Zero behavior change on macOS and Linux.

## Non-Goals

- No custom Windows 11 `titleBarOverlay` chrome with renderer-side window controls (future work).
- No new agent adapters or features beyond what is needed for Windows parity.
- No changes to packaging artifacts (NSIS installer config is already correct).

## Decisions

| Decision | Choice |
|---|---|
| spawn on Windows | `cross-spawn` package (handles `.cmd`/`.bat`/PATH/escaping uniformly) |
| Process-tree kill | Hand-written `taskkill /T /F` on Windows, signals on Unix (no extra dep) |
| Window chrome | Platform branch: macOS keeps `hiddenInset` + traffic lights; others use default frame |
| Release script | Rewrite `release.sh` → `release.mjs` (pure Node, git via `execFileSync`) |
| Scope | All five identified issues |

## Architecture

### 1. spawn — unify on `cross-spawn`

Add `cross-spawn` as a dependency. Replace every `spawn` import sourced from
`node:child_process` with `cross-spawn` in:

- `electron/cli/check.ts` — `which()`/`where`, `runVersion()`, `cliInstall()`
- `electron/cli/runtime.ts` — `cliRun()` spawning the agent binary (`built.bin`)
- `scripts/dev-electron.mjs` — `run("npm", …)`
- `scripts/start-electron.mjs` — spawns the resolved electron command
- `scripts/electron-shell.mjs` — `resolveElectronCommand()` (the non-darwin branch returns
  `npm exec electron`; that spawn is performed by the caller)

Behavior on Unix is identical to native `spawn`; on Windows, `cross-spawn` resolves the `.cmd`
shim and escapes arguments without invoking a shell, which also removes the command-injection
surface from user-supplied `extraArgs`.

Note: `cliRun` keeps `stdio: ["pipe","pipe","pipe"]` and its `ChildProcessByStdio` typing; only
the spawn primitive changes.

### 2. Process-tree kill — new helper

New module `electron/cli/process-kill.ts` exporting:

```ts
export function killProcessTree(
  child: { pid?: number | null },
  mode: "term" | "force"
): void
```

- **win32**: `spawn("taskkill", ["/PID", String(pid), "/T", "/F"])` via cross-spawn. `/T` kills the
  whole tree, `/F` forces. There is no graceful/forceful distinction on Windows; both modes use
  `/F` so the tree is guaranteed to be cleaned up.
- **darwin/linux**: `child.kill(mode === "force" ? "SIGKILL" : "SIGTERM")`.

Three call sites are updated:

- `runtime.ts` `cliKill` — Windows: single `taskkill /F`; Unix: keep the two-stage
  `SIGTERM` → 2s → `SIGKILL` escalation.
- `acpRuntime.ts` `cancel()` — Unix `SIGTERM` / Windows `taskkill`.
- `legacyRuntime.ts` timeout — Unix `SIGKILL` / Windows `taskkill`.

All three already hold `child.pid`; the helper is a no-op when `pid` is absent.

### 3. Window chrome — platform branch

In `electron/main.ts` `createWindow()`, replace the unconditional macOS options with:

```ts
const chromeOptions =
  process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 14 } }
    : {};
```

Spread `chromeOptions` into the `BrowserWindow` options. Windows/Linux get the standard OS frame.
`titleBarOverlay` is explicitly deferred (would require renderer-side control buttons).

### 4. Release script — bash → Node

Replace `scripts/release.sh` with `scripts/release.mjs`:

- Argument parsing, dry-run, confirmation prompt → JS (`process.argv`, `readline` for the y/N
  prompt).
- Semver bump + validate → pure functions (unit-testable).
- File rewriting (`package.json`, `package-lock.json`, `desktop/macos/Info.plist`) → reused from
  the existing inline Node logic, factored into named functions.
- Git operations → `child_process.execFileSync("git", [...])`.

Config changes:

- `package.json`: `release` / `release:patch|minor|major` → `node scripts/release.mjs …`.
- `tests/release-script.test.mjs`: assert the new script path and the updated `package.json`
  script entries; add unit tests for the semver-bump pure functions.
- Delete `scripts/release.sh`.

`tests/release-workflow.test.mjs` is unchanged (electron-builder config is untouched).

## Testing

- **Unit (node:test):** semver bump/validate pure functions extracted from the release script;
  existing release-script test rewritten for the `.mjs` path + script entries.
- **Existing suite:** `npm test` must stay green (build:electron + tests/*.mjs).
- **Typecheck:** `npm run typecheck` must pass with the new `cross-spawn` import and
  `process-kill.ts` module.
- **Manual (Windows VM/CI), not automated locally:** run `npm run dev` on Windows, run an agent,
  click Stop, and confirm the tree is gone. Documented as a manual verification step since the
  dev environment is macOS.

## Risks

- **`cross-spawn` adds a dependency.** Mitigation: it is the de-facto standard for this exact
  problem (zero-runtime-deploy, drop-in `spawn` replacement) and removes a real injection surface.
- **`taskkill /F` is not graceful.** Agents get no chance to flush. Acceptable: the user explicitly
  clicked Stop, and on Unix the two-stage escalation already ends in SIGKILL anyway.
- **Release-script rewrite changes a maintainer-facing tool.** Mitigation: behavior is preserved
  (same flags, same files touched, same git sequence) and covered by tests.
