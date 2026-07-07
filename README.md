# FreeBuddy

<p align="center">
  <a href="https://github.com/maojindao55/freebuddy/stargazers"><img src="https://img.shields.io/github/stars/maojindao55/freebuddy?style=social" alt="GitHub Stars"></a>
  <a href="https://github.com/maojindao55/freebuddy/releases"><img src="https://img.shields.io/github/downloads/maojindao55/freebuddy/total?style=social" alt="Downloads"></a>
  <a href="https://github.com/maojindao55/freebuddy/blob/main/LICENSE"><img src="https://img.shields.io/github/license/maojindao55/freebuddy?style=flat-square&color=blue" alt="License"></a>
  <img src="https://img.shields.io/badge/Electron-25.0+-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
</p>

<p align="center">
  <a href="https://discord.gg/freebuddy"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://twitter.com/freebuddy"><img src="https://img.shields.io/badge/X-Follow-000000?style=flat-square&logo=x&logoColor=white" alt="X(Twitter)"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a>
</p>

**A local-first desktop workspace for coding agents.** ⚡️

<p align="center">
  <a href="https://www.bilibili.com/video/BV1zQTp6HERQ/" target="_blank">
    <img src="assets/video-poster.jpg" width="960px" alt="FreeBuddy Demo Video" style="border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.15);">
  </a>
</p>

<p align="center">
  <a href="https://github.com/maojindao55/freebuddy/releases/latest"><strong>⬇️ Download FreeBuddy</strong></a>
</p>

---

## 🚀 Why FreeBuddy?

FreeBuddy turns tools like **Codex, ClaudeCode, OpenCode, Cursor, Kimi, Qoder, and CodeBuddy** into first-class teammates inside one focused desktop app.

AI coding tools are most useful when they can work where your code already lives, keep context across follow-up turns, and show what they are doing while they do it. FreeBuddy wraps that workflow in a calm desktop interface:

- **🤖 One workspace for many agents** — switch between Codex, ClaudeCode, OpenCode, Cursor, Kimi, Qoder, and CodeBuddy without rebuilding your workflow around each CLI.
- **📁 Local project context** — start from a real workdir, send prompts with file attachments, and keep the conversation tied to the codebase that matters.
- **🔍 Transparent execution** — assistant messages, tool calls, commands, file edits, usage, stderr, and errors render live as structured task events.
- **🔄 Session continuity** — follow-up turns can resume the saved tool session for the same `(agent, workspace)` pair, so iterative work does not restart from zero.
- **💾 Local-first storage** — task history, runtime checks, overrides, sessions, and logs live on your machine.
- **🔌 Agent Client Protocol inside** — FreeBuddy uses ACP as the product-facing runtime layer so the UI can focus on agents and tasks rather than protocol glue.

---

## ✨ Core Features

| Feature | Description | Docs |
|---------|-------------|------|
| **Multi-Agent Support** | Run Codex, ClaudeCode, OpenCode, Cursor, Kimi, Qoder, and CodeBuddy side by side | [Agents →](#-built-in-agents) |
| **Structured Task Stream** | Watch assistant messages, tool calls, commands, and file edits unfold as auditable events | [Task Stream →]() |
| **Session Resume** | Resume previous tool sessions for iterative work without losing context | [Sessions →]() |
| **File Attachments** | Drag and drop files, images, and documents into prompts | [Attachments →]() |
| **Agent Bridge** | Let agents call back to FreeBuddy for previews, notifications, and more | [Bridge →]() |
| **Workflow Teams** | Orchestrate multi-agent workflows with team templates | [Workflows →]() |
| **Local-First** | All data stored locally in SQLite — no cloud dependency | [Storage →]() |
| **ACP Protocol** | Native support for Agent Client Protocol (ACP) | [ACP Docs →](https://www.codebuddy.cn/docs/cli/acp) |

---

## 📦 Built-In Agents

FreeBuddy supports **all CLI-based AI coding tools**. Currently adapted agents:

| Agent | Command | Install | Status |
|--------|---------|--------|--------|
| **Codex** | `codex-acp` | `npm install -g --force @agentclientprotocol/codex-acp` | ✅ |
| **ClaudeCode** | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp` | ✅ |
| **OpenCode** | `opencode` | `npm install -g opencode-ai` | ✅ |
| **Cursor** | `cursor-agent` | `curl https://cursor.com/install -fsS \| bash` | ✅ |
| **Kimi** | `kimi` | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` | ✅ |
| **Qoder** | `qodercli` | `curl -fsSL https://qoder.com/install \| bash` | ✅ |
| **CodeBuddy** | `codebuddy` | `npm install -g @tencent-ai/codebuddy-code` | 🆕 |
| **Your CLI** | *any* | *any* | ✅ |

> **New:** CodeBuddy Code is now supported! Read the [ACP integration docs](https://www.codebuddy.cn/docs/cli/acp).

Open **Settings → Coding Agents** to:
- ✅ Check installed runtimes
- 📥 Run the recommended install command
- ⚙️ Customize binary path, model, extra arguments
- 🌐 Configure environment variables
- 🎨 Choose an agent avatar

---

## 🎯 What You Can Do

- 🔍 **Analyze repositories** before touching risky changes
- 🐛 **Send bug reports, logs, screenshots, or design notes** as attachments
- 🚀 **Run implementation, review, and debugging tasks** from the same desktop surface
- ⚖️ **Compare how different local agents** approach the same codebase
- 🔄 **Resume previous tool sessions** when a feature needs several rounds of work
- 📜 **Keep a readable history** of what happened, which agent ran, and which workspace it acted on

---

## 💻 Desktop Capabilities

FreeBuddy uses Electron because coding-agent work needs more than a browser tab:

- ✅ Access to local files and workspace directories
- ✅ Local agent processes
- ✅ Terminal-style execution streams
- ✅ Persistent task history and JSONL logs
- ✅ Runtime checks and per-agent configuration
- ✅ Permission prompts and task interruption

> 💡 **Tip:** The browser preview is useful for visual iteration, but only the desktop app can reach the CLI bridge.

---

## 🛠️ Quick Start

### 1. Download & Install

Download the latest release for your platform:

| Platform | Download | Package Manager |
|----------|---------|----------------|
| **macOS (Apple Silicon)** | `.dmg` | `brew install --cask maojindao55/freebuddy/freebuddy` |
| **macOS (Intel)** | `.dmg` | - |
| **Windows** | `.exe` installer | - |
| **Linux** | `.AppImage` | AUR: `yay -S freebuddy-bin` |

👉 **[Download Latest Release →](https://github.com/maojindao55/freebuddy/releases/latest)**

### 2. Run FreeBuddy

1. Open FreeBuddy
2. Choose a coding agent
3. Select a workspace directory (or leave unset for general tasks)
4. Type a prompt, optionally attach local files, and start the task
5. Follow the live stream of messages, commands, edits, usage, and errors
6. Continue the conversation later with the same agent and workspace context

---

## 🏗️ Build from Source

### Prerequisites

- Node.js 18+
- npm 9+

### Install Dependencies

```bash
npm install
```

`postinstall` runs `electron-rebuild` for `better-sqlite3` so the native binding matches your Electron version.

### Run the Desktop App (Dev Mode)

```bash
npm run dev
```

### Build for Production

```bash
npm run build
npm run start
```

### Browser Preview (Limited)

```bash
npm run preview
```

> ⚠️ **Note:** The browser preview cannot reach the CLI bridge; it is only useful for visual iteration.

---

## 📂 Storage

State lives under `<userData>/freebuddy/`:

- `freebuddy.db` — SQLite database for executor overrides, tasks, runtimes, conversations, messages, and tool sessions
- `cli-logs/<sessionId>.jsonl` — per-task JSONL log

---

## 🤝 Community & Support

- 💬 **Discord:** [Join our community](https://discord.gg/freebuddy)
- 🐦 **X (Twitter):** [@freebuddy](https://twitter.com/freebuddy)
- 🐛 **Issues:** [Report bugs or request features](https://github.com/maojindao55/freebuddy/issues)
- 📖 **Wiki:** [Documentation](https://github.com/maojindao55/freebuddy/wiki)

---

## 🔮 Roadmap

- [ ] Mobile companion app (like Orca)
- [ ] Terminal split-screen (built-in terminal)
- [ ] Design mode (click-to-inspect UI elements)
- [ ] GitHub & Linear native integration
- [ ] SSH worktrees (remote server support)
- [ ] AI code diff annotations
- [ ] File drag-to-agent
- [ ] FreeBuddy CLI (scriptable workflows)

👉 **[View full roadmap →](https://github.com/maojindao55/freebuddy/projects)**

---

## 👥 Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) before getting started.

### Contributors

<a href="https://github.com/maojindao55/freebuddy/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=maojindao55/freebuddy" />
</a>

---

## 📄 License

FreeBuddy is [MIT licensed](LICENSE).

---

## ⭐️ Star History

<a href="https://star-history.com/#maojindao55/freebuddy&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=maojindao55/freebuddy&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=maojindao55/freebuddy&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=maojindao55/freebuddy&type=Date" />
  </picture>
</a>

---

<p align="center">
  Built with ❤️ by <a href="https://github.com/maojindao55">maojindao55</a>
</p>
