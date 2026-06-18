# FreeBuddy

FreeBuddy is a WorkBuddy-style desktop AI workspace built with Electron, React, Vite, and TypeScript.

It treats local ACP coding agents (Codex ACP, Claude Agent ACP, OpenCode ACP, …) as **first-class members** and provides a unified configuration, structured stream view, task history, and tool-session resume. Direct CLI JSON adapters remain available as legacy fallbacks in settings.

## Install

```sh
npm install
```

`postinstall` runs `electron-rebuild` for `better-sqlite3` so the native binding matches your Electron version.

## Run Desktop App

```sh
npm run dev
```

## Build

```sh
npm run build
npm run start
```

## ACP Agents

Open **Settings → CLI Adapters** to:

- Check whether an adapter binary is installed (auto-detects via `which` + `--version`)
- One-click install via the adapter's recommended install command
- Override binary path, extra args, and environment variables per adapter

Then on the home screen pick an agent, optionally set a workdir, and send a prompt. The structured stream (assistant text, tool calls, commands, file edits, usage, errors) renders live in the task panel.

### Primary adapters

| Adapter      | Binary         | Install hint                                  |
|--------------|----------------|-----------------------------------------------|
| Codex ACP    | `codex-acp`    | `npm install -g @zed-industries/codex-acp`    |
| Claude ACP   | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp` |
| OpenCode ACP | `opencode acp` | `npm install -g opencode-ai`                  |

### Legacy fallback adapters

These stay available in Settings for debugging or emergencies, but they are no longer the default home-screen members.

| Adapter      | Binary         | Install hint                                  |
|--------------|----------------|-----------------------------------------------|
| Codex Legacy | `codex`        | `npm install -g @openai/codex`                |
| Claude Code Legacy | `claude` | `npm install -g @anthropic-ai/claude-code`    |
| OpenCode Legacy | `opencode` | `npm install -g opencode-ai`                  |

### Tool session resume

ACP sessions are persisted per `(agentId, workdir)`. Follow-up turns use ACP session resume when the agent supports it, while replayed history updates are suppressed so only the current turn renders. Legacy fallback adapters still persist emitted `session_id` values and attach their native resume flags.

### Storage

State lives under `<userData>/freebuddy/`:

- `freebuddy.db` — sqlite (executor overrides, tasks, runtimes, tool sessions)
- `cli-logs/<sessionId>.jsonl` — per-task JSONL log

## Browser Preview

```sh
npm run preview
```

The browser preview cannot reach the CLI bridge; it is only useful for visual iteration.

## Legacy Native macOS Shell

The previous AppKit + `WKWebView` experiment is still in `desktop/macos` for comparison. The main direction is now Electron because FreeBuddy needs WorkBuddy-like desktop runtime capabilities: filesystem, terminal, local agent processes, plugins, and richer debugging.
