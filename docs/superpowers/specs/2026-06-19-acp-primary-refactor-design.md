# ACP Primary Refactor Design

## Goal

Move FreeBuddy from "multiple CLI JSON adapters plus an ACP side path" to an ACP-first architecture.

ACP agents become the default product path for Codex, Claude, and OpenCode. Existing direct CLI JSON integrations remain available only as a hidden legacy fallback so users are not blocked if an ACP adapter is missing or temporarily broken.

## Non-Goals

- Do not remove the legacy CLI JSON code in this pass.
- Do not implement full ACP filesystem or terminal client capabilities yet.
- Do not build a new permission UI yet; permission requests remain conservative until a dedicated permissions pass.
- Do not redesign the whole chat UI beyond tool stream presentation required by ACP.

## Current Problems

- Adapter definitions mix protocol selection, stream parsing, command construction, install hints, and resume flags.
- `electron/cli/runtime.ts` contains both short-lived CLI execution and ACP JSON-RPC orchestration in one large function.
- Renderer still chooses parsers via `streamMode`, even though ACP already emits semantic `items`.
- Built-in members expose both legacy and ACP adapters equally, which makes ACP feel like an option rather than the main path.
- Tool calls are now more expressive under ACP, but the UI still treats them as a flat item list.

## Architecture

### Adapter Model

Introduce a clearer adapter shape:

- `protocol: "acp" | "legacy-cli-json"`
- `launch`: binary plus args strategy
- `installHint` and docs remain metadata
- legacy resume flag metadata moves under a legacy-only field

ACP adapter definitions:

- `codex-acp`: `codex-acp`
- `claude-agent-acp`: `claude-agent-acp`
- `opencode-acp`: `opencode acp --cwd <cwd>`

Legacy adapters stay in code but are labeled as fallback and hidden from the default member list.

### Runtime Split

Split main-process execution into two narrow runtimes:

- `runAcpAgent()`: owns JSON-RPC stdio, initialize, session create/resume, prompt, cancel, close, ACP update normalization.
- `runLegacyCliAgent()`: owns the existing spawn/stdout/stderr line flow and renderer parser compatibility.

`cliRun()` becomes a dispatcher that handles shared task bookkeeping and delegates protocol-specific behavior.

### Event Flow

ACP runtime emits semantic `items` events only. It should not emit raw ACP JSON to the renderer except as diagnostics on error.

Legacy runtime continues emitting stdout/stderr events, which the existing parser registry consumes.

Renderer keeps `CliStreamItem` as the UI contract. ACP updates normalize into this contract in main process.

### Session Behavior

ACP sessions remain persisted in the existing `cli_tool_sessions` table.

On follow-up turns:

- use `session/resume` when the agent advertises support.
- suppress replayed history updates until the current `session/prompt` starts.
- save the active ACP session id back to the existing session store.

### Tool UI

Keep the grouped tool presentation introduced during ACP iteration:

- adjacent tool call/result pairs render as one collapsed block.
- input and result details appear only when expanded.
- empty results do not get empty expandable panels.

This behavior should live in renderer normalization/rendering, not in ACP protocol code.

### Settings and Members

Default built-in members become:

- Codex ACP
- Claude Agent ACP
- OpenCode ACP

Legacy members move behind a fallback section or advanced setting. They should not be the first choices on the home screen.

Settings still lists all adapters so users can install and check both ACP and fallback binaries.

## Error Handling

- ACP JSON-RPC errors become user-visible `error` items.
- Unknown ACP client requests return JSON-RPC method-not-found unless explicitly handled.
- `session/request_permission` continues returning cancelled for now.
- stderr remains diagnostic unless an adapter fails before emitting structured errors.

## Testing

Use Node's built-in test runner for main-process protocol behavior:

- command construction for ACP adapters.
- initialize/session/prompt request shape.
- ACP update normalization.
- replay suppression before current prompt.
- tool output extraction from `{ output }`, `{ content }`, and string outputs.

Use TypeScript build as renderer verification:

- `npm test`
- `npm run build`

## Migration Plan

1. Extract ACP runtime into its own module.
2. Extract legacy CLI JSON runtime into its own module.
3. Turn `cliRun()` into a protocol dispatcher with shared task logging.
4. Rename protocol values and adapter metadata to make ACP primary.
5. Move legacy built-in members out of the default home list.
6. Keep settings visibility for legacy fallback adapters.
7. Update README to describe ACP as the main path and legacy CLI JSON as fallback.
8. Run `npm test` and `npm run build`.

## Decisions

- Legacy fallback members are hidden from the default home selector. Settings still lists the adapters for installation, checks, and manual overrides.
- `session/request_permission` remains a follow-up. This refactor keeps the conservative cancelled response.
