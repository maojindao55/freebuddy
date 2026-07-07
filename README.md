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

### Multi-Agent Support

Switch between Codex, ClaudeCode, OpenCode, Cursor, Kimi, Qoder, and CodeBuddy without rebuilding your workflow around each CLI.

[Learn more →](#-built-in-agents)

### Structured Task Stream

Watch assistant messages, tool calls, commands, file edits, usage, stderr, and errors unfold as auditable events in real-time.

[Task Stream Docs →](https://github.com/maojindao55/freebuddy/wiki/task-stream)

### Session Resume

Resume previous tool sessions for iterative work without losing context. The same `(agent, workspace)` pair remembers your conversation.

[Session Docs →](https://github.com/maojindao55/freebuddy/wiki/sessions)

### File Attachments

Drag and drop files, images, and documents directly into prompts. The agent reasons with that context automatically.

[Attachments Docs →](https://github.com/maojindao55/freebuddy/wiki/attachments)

### Agent Bridge

Let agents call back to FreeBuddy for previews, notifications, and more. Built-in local HTTP server (port 17878) for agent-to-app communication.

[Bridge Docs →](https://github.com/maojindao55/freebuddy/wiki/agent-bridge)

### Workflow Teams

Orchestrate multi-agent workflows with team templates. Run Codex for implementation, ClaudeCode for review, and Kimi for testing — all in parallel.

[Workflows Docs →](https://github.com/maojindao55/freebuddy/wiki/workflows)

### Local-First Storage

All data lives on your machine — task history, runtime checks, overrides, sessions, and logs. No cloud dependency.

[Storage Docs →](https://github.com/maojindao55/freebuddy/wiki/storage)

### ACP Protocol Native

FreeBuddy uses ACP (Agent Client Protocol) as the product-facing runtime layer. The UI focuses on agents and tasks rather than protocol glue.

[ACP Docs →](https://www.codebuddy.cn/docs/cli/acp)

### Quick Open (Command Palette)

Global search across worktrees, files, agents, commands, and repository context. Never interrupt your workflow.

[Quick Open Docs →](https://github.com/maojindao55/freebuddy/wiki/quick-open)

### Account Switching & Usage Tracking

Real-time view of Claude, Codex usage and rate limit reset times. Hot-switch accounts without re-login.

[Usage Docs →](https://github.com/maojindao55/freebuddy/wiki/usage-tracking)

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
