# FreeBuddy

FreeBuddy is a WorkBuddy-style desktop AI workspace built with Electron, React, Vite, and TypeScript.

It treats local CLI coding agents (Codex, Claude Code, OpenCode, …) as **first-class members** and provides a unified configuration, structured stream view, task history, and tool-session resume.

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

## CLI Agents

Open **Settings → CLI Adapters** to:

- Check whether an adapter binary is installed (auto-detects via `which` + `--version`)
- One-click install via the adapter's recommended install command
- Override binary path, extra args, and environment variables per adapter

Then on the home screen pick an agent, optionally set a workdir, and send a prompt. The structured stream (assistant text, tool calls, commands, file edits, usage, errors) renders live in the task panel.

### Built-in adapters

| Adapter      | Binary         | Install hint                                  |
|--------------|----------------|-----------------------------------------------|
| Codex        | `codex`        | `npm install -g @openai/codex`                |
| Claude Code  | `claude`       | `npm install -g @anthropic-ai/claude-code`    |
| OpenCode     | `opencode`     | `npm install -g opencode-ai`                  |

### Tool session resume

When an adapter emits a `session_id`, FreeBuddy persists it per `(agentId, workdir)`. The next run with the same agent and workdir auto-attaches the resume flag (`--resume` for Claude, `--session` for OpenCode, etc.), so context carries over. Override with explicit `--resume` / `--session` in adapter extra args if you want manual control.

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
