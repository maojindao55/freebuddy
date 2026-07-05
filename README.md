# FreeBuddy

[English](README.md) | [简体中文](README.zh-CN.md)

<p align="center">
  <a href="https://github.com/maojindao55/freebuddy/blob/main/LICENSE"><img src="https://img.shields.io/github/license/maojindao55/freebuddy?style=flat-square&color=blue" alt="License"></a>
  <img src="https://img.shields.io/badge/Electron-25.0+-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
</p>

**A local-first desktop workspace for coding agents.**

<p align="center">
  <a href="https://www.bilibili.com/video/BV1zQTp6HERQ/" target="_blank">
    <img src="assets/video-poster.jpg" width="100%" alt="FreeBuddy Demo Video" style="border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.15);"/>
  </a>
</p>



FreeBuddy turns tools like Codex, ClaudeCode, OpenCode, and Cursor into
first-class teammates inside one focused desktop app. Pick an agent, point it at
a workspace, attach useful context, and watch the task unfold as a structured,
auditable stream instead of a black-box chat.

It is built for developers who want the power of local AI coding agents without
juggling terminals, command flags, scattered logs, and one-off sessions.

## Why FreeBuddy

AI coding tools are most useful when they can work where your code already
lives, keep context across follow-up turns, and show what they are doing while
they do it. FreeBuddy wraps that workflow in a calm desktop interface:

- **One workspace for many agents** — switch between Codex, ClaudeCode,
  OpenCode, and Cursor without rebuilding your workflow around each CLI.
- **Local project context** — start from a real workdir, send prompts with file
  attachments, and keep the conversation tied to the codebase that matters.
- **Transparent execution** — assistant messages, tool calls, commands, file
  edits, usage, stderr, and errors render live as structured task events.
- **Session continuity** — follow-up turns can resume the saved tool session for
  the same `(agent, workspace)` pair, so iterative work does not restart from
  zero.
- **Local-first storage** — task history, runtime checks, overrides, sessions,
  and logs live on your machine.
- **Agent Client Protocol inside** — FreeBuddy uses ACP as the product-facing
  runtime layer so the UI can focus on agents and tasks rather than protocol
  glue.

## What You Can Do

- Ask an agent to analyze a repository before you touch a risky change.
- Send a bug report, logs, screenshots, or design notes as attachments and let
  the agent reason with that context.
- Run implementation, review, and debugging tasks from the same desktop surface.
- Compare how different local agents approach the same codebase.
- Resume a previous tool session when a feature needs several rounds of work.
- Keep a readable history of what happened, which agent ran, and which workspace
  it acted on.

## Product Flow

1. Open FreeBuddy.
2. Choose a coding agent.
3. Select a workspace directory, or leave it unset for a general task.
4. Type a prompt, optionally attach local files, and start the task.
5. Follow the live stream of messages, commands, edits, usage, and errors.
6. Continue the conversation later with the same agent and workspace context.

## Built-In Agents

| Agent | Command | Install hint |
| --- | --- | --- |
| Codex | `codex-acp` | `npm install -g @zed-industries/codex-acp` |
| ClaudeCode | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp` |
| OpenCode | `opencode` | `npm install -g opencode-ai` |
| Cursor | `cursor-agent` | `curl https://cursor.com/install -fsS \| bash` |
| Kimi | `kimi` | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` |
| Qoder | `qodercli` | `curl -fsSL https://qoder.com/install \| bash` |

Open **Settings -> Coding Agents** to check installed runtimes, run the
recommended install command, customize a binary path, set a model, pass extra
arguments, configure environment variables, or choose an agent avatar.

## Desktop Capabilities

FreeBuddy uses Electron because coding-agent work needs more than a browser tab:

- access to local files and workspace directories
- local agent processes
- terminal-style execution streams
- persistent task history and JSONL logs
- runtime checks and per-agent configuration
- permission prompts and task interruption

The browser preview is useful for visual iteration, but only the desktop app can
reach the CLI bridge.

## Install

```sh
npm install
```

`postinstall` runs `electron-rebuild` for `better-sqlite3` so the native binding
matches your Electron version.

## Run The Desktop App

```sh
npm run dev
```

## Build

```sh
npm run build
npm run start
```

## Browser Preview

```sh
npm run preview
```

The browser preview cannot reach the CLI bridge; it is only useful for visual
iteration.

## Storage

State lives under `<userData>/freebuddy/`:

- `freebuddy.db` — SQLite database for executor overrides, tasks, runtimes,
  conversations, messages, and tool sessions
- `cli-logs/<sessionId>.jsonl` — per-task JSONL log

## Legacy Native macOS Shell

The previous AppKit + `WKWebView` experiment is still in `desktop/macos` for
comparison. The main direction is now Electron because FreeBuddy needs
WorkBuddy-like desktop runtime capabilities: filesystem, terminal, local agent
processes, plugins, and richer debugging.
