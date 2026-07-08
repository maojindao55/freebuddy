# FreeBuddy

<p align="center">
  <a href="https://freebuddy.dev"><img src="assets/logo.png" alt="FreeBuddy Logo" width="120"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

**A local-first desktop workspace for coding agents.** ⚡

Run Codex, ClaudeCode, OpenCode, Cursor, Kimi, Qoder, and CodeBuddy side-by-side — each in its own workspace, tracked in one place.

### [⬇️ Download FreeBuddy](https://github.com/maojindao55/freebuddy/releases/latest)

---

## Features

| Feature | Description | Screenshot |
|---------|-------------|-------------|
| **Multi-Agent Support** | Switch between Codex, ClaudeCode, OpenCode, Cursor, Kimi, Qoder, and CodeBuddy without rebuilding your workflow around each CLI. | ![Multi-Agent](assets/features/multi-agent.gif) |
| **Structured Task Stream** | Watch assistant messages, tool calls, commands, file edits, usage, stderr, and errors unfold as auditable events in real-time. | ![Task Stream](assets/features/task-stream.gif) |
| **Session Resume** | Resume previous tool sessions for iterative work without losing context. The same `(agent, workspace)` pair remembers your conversation. | ![Session](assets/features/session-resume.gif) |
| **File Attachments** | Drag and drop files, images, and documents directly into prompts. The agent reasons with that context automatically. | ![Attachments](assets/features/attachments.gif) |
| **Agent Bridge** | Let agents call back to FreeBuddy for previews, notifications, and more. Built-in local HTTP server (port 17878). | ![Bridge](assets/features/agent-bridge.gif) |
| **Workflow Teams** | Orchestrate multi-agent workflows with team templates. Run Codex for implementation, ClaudeCode for review — all in parallel. | ![Workflows](assets/features/workflow-teams.gif) |
| **Local-First Storage** | All data lives on your machine — task history, runtimes, sessions, and logs. No cloud dependency. | ![Storage](assets/features/local-storage.gif) |
| **ACP Protocol Native** | FreeBuddy uses ACP as the product-facing runtime layer. The UI focuses on agents and tasks rather than protocol glue. | ![ACP](assets/features/acp-protocol.gif) |
| **Quick Open** | Global search across worktrees, files, agents, commands, and repository context. Never interrupt your workflow. | ![Quick Open](assets/features/quick-open.gif) |
| **Usage Tracking** | Real-time view of Claude, Codex usage and rate limit reset times. Hot-switch accounts without re-login. | ![Usage](assets/features/usage-tracking.gif) |

> 📸 **Screenshots coming soon!** GIFs will be added in the next release.

---

## Built-In Agents

FreeBuddy is compatible with **all CLI-based AI coding tools**. Currently adapted agents:

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

## Install

### Desktop (macOS / Windows / Linux)

**Quick download:** [FreeBuddy Releases](https://github.com/maojindao55/freebuddy/releases/latest)

| Platform | Download | Package Manager |
|----------|---------|----------------|
| **macOS (Apple Silicon)** | `.dmg` | `brew install --cask maojindao55/freebuddy/freebuddy` |
| **macOS (Intel)** | `.dmg` | - |
| **Windows** | `.exe` installer | - |
| **Linux** | `.AppImage` | AUR: `yay -S freebuddy-bin` |

### Build from Source

Prerequisites: Node.js 18+, npm 9+

```bash
# Clone the repo
git clone https://github.com/maojindao55/freebuddy.git
cd freebuddy

# Install dependencies
npm install

# Run in dev mode
npm run dev

# Build for production
npm run build
npm run start
```

> **Note:** `postinstall` runs `electron-rebuild` for `better-sqlite3` so the native binding matches your Electron version.

---

## Community & Support

- 💬 **Discord:** [Join our community](https://discord.gg/freebuddy)
- 🐦 **X (Twitter):** [@freebuddy](https://twitter.com/freebuddy)
- 🐛 **Issues:** [Report bugs or request features](https://github.com/maojindao55/freebuddy/issues)
- 📖 **Wiki:** [Documentation](https://github.com/maojindao55/freebuddy/wiki)
- 🔒 **Privacy:** [Telemetry & Data Collection](https://github.com/maojindao55/freebuddy/wiki/privacy)

**Support this project:** ⭐ [Star the repo](https://github.com/maojindao55/freebuddy) to follow daily updates!

---

## Roadmap

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

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) before getting started.

### Contributors

<a href="https://github.com/maojindao55/freebuddy/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=maojindao55/freebuddy" />
</a>

---

## License

FreeBuddy is [MIT licensed](LICENSE).

---

<p align="center">
  Built with ❤️ by <a href="https://github.com/maojindao55">maojindao55</a>
</p>
