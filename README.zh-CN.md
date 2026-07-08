# FreeBuddy

<p align="center">
  <a href="https://freebuddy.dev"><img src="assets/logo.png" alt="FreeBuddy Logo" width="120"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

**面向本地编码 Agent 的桌面工作台。** ⚡

把 Codex、ClaudeCode、OpenCode、Cursor、Kimi、Qoder 和 CodeBuddy 放在一个界面里并行使用 —— 每个 Agent 在独立的工作区运行，所有任务统一追踪。

### [⬇️ 下载 FreeBuddy](https://github.com/maojindao55/freebuddy/releases/latest)

---

## 功能特性

| 功能 | 说明 | 截图 |
|---------|-------------|-------------|
| **多 Agent 支持** | 在 Codex、ClaudeCode、OpenCode、Cursor、Kimi、Qoder 和 CodeBuddy 之间切换，无需为每个 CLI 重新适应工作流。 | ![多Agent](assets/features/multi-agent-zh.gif) |
| **结构化任务流** | 实时查看助手消息、工具调用、命令执行、文件编辑、用量、stderr 和错误，以可审计的事件流呈现。 | ![任务流](assets/features/task-stream-zh.gif) |
| **会话恢复** | 恢复之前的工具会话，继续多轮迭代工作，不丢失上下文。同一个 `(agent, workspace)` 对会记住你的对话。 | ![会话恢复](assets/features/session-resume-zh.gif) |
| **文件附件** | 直接拖拽文件、图片和文档到提示词输入框。Agent 会自动结合这些上下文进行推理。 | ![附件](assets/features/attachments-zh.gif) |
| **Agent 桥接** | 让 Agent 回调 FreeBuddy 进行预览、通知等。内置本地 HTTP 服务器（端口 17878）用于 Agent 到应用的通信。 | ![桥接](assets/features/agent-bridge-zh.gif) |
| **工作流团队** | 使用团队模板编排多 Agent 工作流。并行运行 Codex 实现、ClaudeCode 审查、Kimi 测试。 | ![工作流](assets/features/workflow-teams-zh.gif) |
| **本地优先存储** | 所有数据保存在你的机器上 —— 任务历史、运行时检查、配置覆盖、会话和日志。无云端依赖。 | ![存储](assets/features/local-storage-zh.gif) |
| **ACP 协议原生支持** | FreeBuddy 使用 ACP（Agent Client Protocol）作为产品侧运行层。UI 专注于 Agent 和任务本身，而非协议细节。 | ![ACP](assets/features/acp-protocol-zh.gif) |
| **快速打开（命令面板）** | 跨工作树、文件、Agent、命令和仓库上下文的全局搜索。永远不中断你的工作流。 | ![快速打开](assets/features/quick-open-zh.gif) |
| **账号切换和用量追踪** | 实时查看 Claude、Codex 用量和速率限制重置时间。热切换账号，无需重新登录。 | ![用量追踪](assets/features/usage-tracking-zh.gif) |

> 📸 **截图即将推出！** GIF 将在下一个版本中添加。

---

## 内置 Agent

FreeBuddy 兼容**所有基于 CLI 的 AI 编码工具**。当前已适配的 Agent：

| Agent | 命令 | 安装方式 | 状态 |
|--------|---------|--------|--------|
| **Codex** | `codex-acp` | `npm install -g --force @agentclientprotocol/codex-acp` | ✅ |
| **ClaudeCode** | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp` | ✅ |
| **OpenCode** | `opencode` | `npm install -g opencode-ai` | ✅ |
| **Cursor** | `cursor-agent` | `curl https://cursor.com/install -fsS \| bash` | ✅ |
| **Kimi** | `kimi` | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` | ✅ |
| **Qoder** | `qodercli` | `curl -fsSL https://qoder.com/install \| bash` | ✅ |
| **CodeBuddy** | `codebuddy` | `npm install -g @tencent-ai/codebuddy-code` | 🆕 |
| **你的 CLI** | *任意* | *任意* | ✅ |

> **新功能：** CodeBuddy Code 现已支持！阅读 [ACP 集成文档](https://www.codebuddy.cn/docs/cli/acp)。

打开 **设置 → 编码 Agent** 可以：
- ✅ 检查已安装的运行时
- 📥 运行推荐的安装命令
- ⚙️ 自定义二进制路径、模型、额外参数
- 🌐 配置环境变量
- 🎨 选择 Agent 头像

---

## 安装

### 桌面端（macOS / Windows / Linux）

**快速下载：** [FreeBuddy Releases](https://github.com/maojindao55/freebuddy/releases/latest)

| 平台 | 下载 | 包管理器 |
|----------|---------|----------------|
| **macOS (Apple Silicon)** | `.dmg` | `brew install --cask maojindao55/freebuddy/freebuddy` |
| **macOS (Intel)** | `.dmg` | - |
| **Windows** | `.exe` 安装包 | - |
| **Linux** | `.AppImage` | AUR: `yay -S freebuddy-bin` |

### 从源码构建

前置要求：Node.js 18+, npm 9+

```bash
# 克隆仓库
git clone https://github.com/maojindao55/freebuddy.git
cd freebuddy

# 安装依赖
npm install

# 开发模式运行
npm run dev

# 生产构建
npm run build
npm run start
```

> **注意：** `postinstall` 会为 `better-sqlite3` 运行 `electron-rebuild`，确保原生绑定与当前 Electron 版本匹配。

---

## 社区与支持

- 💬 **Discord：** [加入我们的社区](https://discord.gg/freebuddy)
- 🐦 **X (Twitter):** [@freebuddy](https://twitter.com/freebuddy)
- 🐛 **问题反馈：** [报告 Bug 或请求新功能](https://github.com/maojindao55/freebuddy/issues)
- 📖 **Wiki：** [文档](https://github.com/maojindao55/freebuddy/wiki)
- 🔒 **隐私：** [遥测与数据收集](https://github.com/maojindao55/freebuddy/wiki/privacy)

**支持这个项目：** ⭐ [给仓库点 Star](https://github.com/maojindao55/freebuddy) 以关注每日更新！

---

## 路线图

- [ ] 移动端配套应用（类似 Orca）
- [ ] 终端分屏（内置终端）
- [ ] 设计模式（点击检查 UI 元素）
- [ ] GitHub & Linear 原生集成
- [ ] SSH 工作树（远程服务器支持）
- [ ] AI 代码差异注释
- [ ] 文件拖拽到 Agent
- [ ] FreeBuddy CLI（可编写脚本的工作流）

👉 **[查看完整路线图 →](https://github.com/maojindao55/freebuddy/projects)**

---

## 贡献

欢迎贡献！开始前请阅读我们的 [贡献指南](CONTRIBUTING.md)。

### 贡献者

<a href="https://github.com/maojindao55/freebuddy/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=maojindao55/freebuddy" />
</a>

---

## 许可证

FreeBuddy 采用 [MIT 许可证](LICENSE)。

---

<p align="center">
  用 ❤️ 制作 by <a href="https://github.com/maojindao55">maojindao55</a>
</p>
