# FreeBuddy

<p align="center">
  <img src="assets/app-icon.png" alt="FreeBuddy Logo" width="120">
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

**面向本地编码 Agent 的桌面工作台：统一任务、跨 Agent 交接、团队协作。** ⚡

把 Codex、ClaudeCode、OpenCode 等本地编码工具放在一个界面里使用。为会话选择 Agent 和项目目录，同时跟踪多个项目的任务；需要协作时，组织不同 Agent 完成实现、评审和验证。

支持两种工作方式：

### 普通模式

选择一个 Agent 开始任务，在任务面板中查看多个会话的进展，需要时将会话转接给另一个 Agent。

![hero](assets/fbd-hero.png)

### 团队执行模式（多 Agent 协作）

使用工作流模板安排步骤，或由入口 Agent 按角色能力自主委派子任务。

![任务流](assets/fbd-hero2.png)

### [⬇️ 下载 FreeBuddy](https://github.com/maojindao55/freebuddy/releases/latest)

---

## 快速开始

1. [下载安装 FreeBuddy](https://github.com/maojindao55/freebuddy/releases/latest)，打开 **设置 → CLI Agent**，检查或安装需要的 Agent，并完成登录或 API Key 配置。
2. 新建会话，选择本地项目目录和 Agent，在 **普通模式** 中描述任务并发送。
3. 需要实现与评审分工时，切到 **团队执行模式** 并选择团队；在 **设置 → 工作流团队** 中调整角色、Agent 和执行策略。

多个任务同时进行时，可将会话列表切换到 **任务面板**，按项目、执行状态或未读筛选，并全屏查看。

需要换 Agent 接着做时，等待本轮结束或先停止运行，再打开会话顶部的 **分享或转接**，选择 **交给其他 Agent 接管**。预览交接摘要后，新 Agent 会在新会话中继续处理任务。

---

## 功能特性

| 功能 | 说明 | 演示 |
|---------|-------------|-------------|
| **任务面板** | 集中查看跨项目会话的状态、近期活动、失败和待确认事项；支持筛选、搜索和全屏 | — |
| **跨 Agent 会话转接** | 将任务目标、近期指令、回复摘要和文件改动整理成交接上下文，交给其他 Agent 继续 | — |
| **团队编排** | 配置规划、实现、评审和验证角色；支持工作流模板、评审修复循环和自组织委派 | — |
| **多 Agent 支持** | 自动识别已安装的本地 Agent 与适配器 | ![多Agent](assets/FreeBuddy-multi-agents.gif) |
| **BYOK 支持** | Codex、ClaudeCode、DeepSeek Harness 和 Pi 可配置自己的 API Key、服务地址和模型 | ![BYOK](assets/FreeBuddy-BYOK.gif) |
| **Codex 限额用量卡片** | 查看 Codex 用量和速率限制重置时间，切换已保存的账号 | ![用量卡](assets/FreeBuddy-limit-card.gif) |

### 🎬 工作流团队

- **工作流团队**：按配置的步骤执行规划、实现、评审和验证。内置交付工作流可根据评审或验证反馈进入修复循环，并设置审批节点和循环次数。
- **自组织委派团队**：入口 Agent 根据任务需要，将子任务交给花名册中的角色；结果回传后继续处理。可配置角色写权限、写前审批、委派深度和超时。

例如由 Codex 实现、ClaudeCode 评审，再由另一个 Agent 验证。有依赖的步骤依次执行；无依赖的步骤是否并行取决于工作流配置和运行策略。

https://github.com/user-attachments/assets/9665bf24-9150-4ffa-b571-10eece2d2062

### 📰 FeedRSS 卡片

等待 Agent 执行时，浏览订阅的资讯。

https://github.com/user-attachments/assets/380965e3-d4eb-4ad1-bb0d-ded33c5272e9


### 💥 码鞭道具

等待时点击执行中的 Agent 头像，播放码鞭彩蛋特效，轻松解压。

https://github.com/user-attachments/assets/8bab605f-6f1b-4e53-a520-c3f5a6645ace


---

## 支持的 Agent

FreeBuddy 为下列工具提供内置集成，通过 ACP（Agent Client Protocol）适配器连接本地 Agent。部分工具需要额外安装适配器；仅能在终端运行并不保证可直接接入。模型、登录方式和工具能力取决于对应的 Agent 与适配器。

<p>
  <a href="https://www.npmjs.com/package/@agentclientprotocol/codex-acp"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp"><kbd><img src="https://www.google.com/s2/favicons?domain=anthropic.com&sz=64" alt="ClaudeCode logo" width="16" valign="middle" /> ClaudeCode</kbd></a> &nbsp;
  <a href="https://www.npmjs.com/package/opencode-ai"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://cursor.com/install"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor logo" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://code.kimi.com"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Kimi logo" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://qoder.com/install"><kbd><img src="https://www.google.com/s2/favicons?domain=qoder.com&sz=64" alt="Qoder logo" width="16" valign="middle" /> Qoder</kbd></a> &nbsp;
  <a href="https://www.npmjs.com/package/@tencent-ai/codebuddy-code"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuddy.cn&sz=64" alt="CodeBuddy logo" width="16" valign="middle" /> CodeBuddy</kbd></a> &nbsp;
  <a href="https://github.com/deepseek-ai/deepseek-harness"><kbd><img src="https://www.google.com/s2/favicons?domain=deepseek.com&sz=64" alt="DeepSeek logo" width="16" valign="middle" /> DeepSeek</kbd></a> &nbsp;
  <kbd>Grok</kbd> &nbsp;
  <kbd>Antigravity</kbd> &nbsp;
  <kbd>ZCode</kbd> &nbsp;
  <kbd>Cline</kbd> &nbsp;
  <kbd>Devin</kbd> &nbsp;
  <kbd>Pi</kbd>
</p>

<details>
<summary>运行命令与安装方式</summary>

推荐通过 **设置 → CLI Agent → 安装** 使用当前平台的安装方式。下列 shell 安装命令适用于 macOS / Linux；Windows 用户请使用设置中的安装入口。

| Agent | 命令 | 安装方式 |
|--------|---------|--------|
| **Codex** | `codex-acp` | `npm install -g --force @agentclientprotocol/codex-acp` |
| **ClaudeCode** | `claude-agent-acp` | `npm install -g --include=optional @agentclientprotocol/claude-agent-acp` |
| **OpenCode** | `opencode` | `npm install -g opencode-ai` |
| **Cursor** | `cursor-agent` | `curl https://cursor.com/install -fsS \| bash` |
| **Kimi** | `kimi` | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` |
| **Qoder** | `qodercli` | `curl -fsSL https://qoder.com/install \| bash` |
| **CodeBuddy** | `codebuddy` | `npm install -g @tencent-ai/codebuddy-code` |
| **Grok** | `grok` | 设置 → CLI Agent → **安装** |
| **Antigravity** | `agy-acp` | `npm install -g agy-acp-bridge`；需可用的 Antigravity CLI |
| **DeepSeek Harness** | `deepseek-harness-acp` | 设置 → CLI Agent → **安装**（`deepseek-harness-acp`） |
| **ZCode** | `zcode-acp-server` | `npm install -g zcode-acp-server` |
| **Cline** | `cline` | `npm install -g cline` |
| **Devin** | `devin` | 设置 → CLI Agent → **安装** |
| **Pi** | `pi-acp` | 随 FreeBuddy 内置，无需单独安装；也用于内置引导助手 GuideBuddy |

在 DeepSeek Harness 配置中填写 API Key，或设置 `DEEPSEEK_API_KEY` 环境变量。现代独立运行时使用自身的默认配置；本地调试和旧版兼容细节见 [DeepSeek ACP 集成说明](docs/dsh-standalone-local-testing.md)。

</details>

打开 **设置 → CLI Agent** 可以：

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
| **Ubuntu / Debian (x64)** | `.deb` | `sudo apt install ./FreeBuddy_Ubuntu_x64-<版本>.deb` |
| **Linux (x64)** | `.AppImage` | `chmod +x FreeBuddy_Linux_x64-<版本>.AppImage` |

AppImage 使用静态运行时，当前 Ubuntu 版本无需安装 FUSE 2 即可运行。

### 从源码构建

前置要求：Node.js 22.22+，npm 9+。

```bash
# 克隆仓库
git clone https://github.com/maojindao55/freebuddy.git
cd freebuddy

# 安装依赖
npm install

# 开发模式运行
npm run dev

# 生产构建
npm run start
```

推送分支或创建 PR 前，请同时检查 GitHub CLI 的本地登录状态和实际 API 权限：

```bash
npm run github:preflight
```

该检查不会输出 Token 值，也不会创建新的 OAuth Token。检查失败时，请按提示修复后重新执行。在 Codex
沙箱中应先用系统权限复查一次，因为沙箱可能无法访问 macOS 钥匙串或网络，不要因此直接重复登录。

> **注意：** `npm run start` 会先构建再启动。`postinstall` 会为 `better-sqlite3` 和 `node-pty` 运行 `electron-rebuild`，确保原生绑定与当前 Electron 版本匹配。

---

## Star History

<a href="https://www.star-history.com/?repos=maojindao55%2Ffreebuddy&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=maojindao55/freebuddy&type=date&theme=dark&legend=top-left&sealed_token=_vBp2Ba6BbtTnwG5RXtVyOwRKsvfS1B4qKjYHT1ZQBN7CXun63Yd81CGPV3LIDB3BafxDPgNcLDDdd-tinwwl6cAZp_S3ZYXHT91BJdw2jckP_G3Z0B1ig" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=maojindao55/freebuddy&type=date&legend=top-left&sealed_token=_vBp2Ba6BbtTnwG5RXtVyOwRKsvfS1B4qKjYHT1ZQBN7CXun63Yd81CGPV3LIDB3BafxDPgNcLDDdd-tinwwl6cAZp_S3ZYXHT91BJdw2jckP_G3Z0B1ig" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=maojindao55/freebuddy&type=date&legend=top-left&sealed_token=_vBp2Ba6BbtTnwG5RXtVyOwRKsvfS1B4qKjYHT1ZQBN7CXun63Yd81CGPV3LIDB3BafxDPgNcLDDdd-tinwwl6cAZp_S3ZYXHT91BJdw2jckP_G3Z0B1ig" />
 </picture>
 </a>

---

## 社区与支持

- 🐧 **QQ群：** [点击链接加入群聊](https://qm.qq.com/q/Lgu4uyIWCC)

---

## 贡献

欢迎通过 [Issues](https://github.com/maojindao55/freebuddy/issues) 反馈问题或建议，也欢迎提交 Pull Request。推送分支或创建 PR 前请运行上面的 `npm run github:preflight`。

### 贡献者

<a href="https://github.com/maojindao55/freebuddy/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=maojindao55/freebuddy" />
</a>

---

## 许可证

FreeBuddy 采用 MIT 许可证。

---

<p align="center">
  用 ❤️ 制作 by <a href="https://github.com/maojindao55">maojindao55</a>
</p>
