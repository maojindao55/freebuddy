# FreeBuddy

<p align="center">
  <a href=""><img src="assets/app-icon.png" alt="FreeBuddy Logo" width="120"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

**面向本地编码 Agent 的桌面工作台。** ⚡

把 Codex、ClaudeCode、OpenCode、Cursor、Kimi、Qoder 和 CodeBuddy 放在一个界面里并行使用 —— 每个 Agent 在独立的工作区运行，所有任务统一追踪。支持两大模式：
* **普通模式**
![hero](assets/fbd-hero.png)

* **团队执行模式（多agent协同）**
![任务流](assets/fbd-hero2.png)

### [⬇️ 下载 FreeBuddy](https://github.com/maojindao55/freebuddy/releases/latest)

---

## 功能特性

| 功能 | 说明 | 演示 |
|---------|-------------|-------------|
| **多 Agent 支持** | 自动识别本地agent | ![多Agent](assets/FreeBuddy-multi-agents.gif) |
| **BYOK 支持** | Codex和ClaudeCode支持BYOK，可以使用三方或中转站API | ![多Agent](assets/FreeBuddy-BYOK.gif) |
| **Codex限额用量卡片** | 实时查看 Codex 用量和速率限制重置时间。热切换账号，无需重新登录。 | ![用量卡](assets/FreeBuddy-limit-card.gif) |

### 🎬 工作流团队
使用团队模板编排多 Agent 工作流。并行运行 Codex 实现、ClaudeCode 审查、Kimi 测试。

https://github.com/user-attachments/assets/9665bf24-9150-4ffa-b571-10eece2d2062

### 📰 FeedRSS卡片
等待agent执行gap过程，可实时关注资讯

https://github.com/user-attachments/assets/380965e3-d4eb-4ad1-bb0d-ded33c5272e9


### 💥 码鞭道具
心情焦躁？用力抽打agent提速x1、解压

https://github.com/user-attachments/assets/8bab605f-6f1b-4e53-a520-c3f5a6645ace


---

## 内置 Agent

FreeBuddy 兼容**所有基于 CLI 的 AI 编码工具** —— 只要它能在终端运行，就能在 FreeBuddy 里运行。

<p>
  <a href="https://www.npmjs.com/package/@agentclientprotocol/codex-acp"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp"><kbd><img src="https://www.google.com/s2/favicons?domain=anthropic.com&sz=64" alt="ClaudeCode logo" width="16" valign="middle" /> ClaudeCode</kbd></a> &nbsp;
  <a href="https://www.npmjs.com/package/opencode-ai"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://cursor.com/install"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor logo" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://code.kimi.com"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Kimi logo" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://qoder.com/install"><kbd><img src="https://www.google.com/s2/favicons?domain=qoder.com&sz=64" alt="Qoder logo" width="16" valign="middle" /> Qoder</kbd></a> &nbsp;
  <a href="https://www.npmjs.com/package/@tencent-ai/codebuddy-code"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuddy.cn&sz=64" alt="CodeBuddy logo" width="16" valign="middle" /> CodeBuddy</kbd></a> &nbsp;
  <kbd>+ any CLI agent</kbd>
</p>

<details>
<summary>安装命令</summary>

| Agent | 命令 | 安装方式 | 状态 |
|--------|---------|--------|--------|
| **Codex** | `codex-acp` | `npm install -g --force @agentclientprotocol/codex-acp` | ✅ |
| **ClaudeCode** | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp` | ✅ |
| **OpenCode** | `opencode` | `npm install -g opencode-ai` | ✅ |
| **Cursor** | `cursor-agent` | `curl https://cursor.com/install -fsS \| bash` | ✅ |
| **Kimi** | `kimi` | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` | ✅ |
| **Qoder** | `qodercli` | `curl -fsSL https://qoder.com/install \| bash` | ✅ |
| **CodeBuddy** | `codebuddy` | `npm install -g @tencent-ai/codebuddy-code` | 🆕 |

</details>

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
| **Ubuntu / Debian (x64)** | `.deb` | `sudo apt install ./FreeBuddy_Ubuntu_x64-<版本>.deb` |
| **Linux (x64)** | `.AppImage` | `chmod +x FreeBuddy_Linux_x64-<版本>.AppImage` |

AppImage 使用静态运行时，当前 Ubuntu 版本无需安装 FUSE 2 即可运行。

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

推送分支或创建 PR 前，请同时检查 GitHub CLI 的本地登录状态和实际 API 权限：

```bash
npm run github:preflight
```

该检查不会输出 Token 值，也不会创建新的 OAuth Token。检查失败时，请按提示修复后重新执行。在 Codex
沙箱中应先用系统权限复查一次，因为沙箱可能无法访问 macOS 钥匙串或网络，不要因此直接重复登录。

> **注意：** `postinstall` 会为 `better-sqlite3` 运行 `electron-rebuild`，确保原生绑定与当前 Electron 版本匹配。

---

## Star History

<a href="https://www.star-history.com/?repos=maojindao55%2Ffreebuddy&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=maojindao55/freebuddy&type=date&theme=dark&legend=top-left&sealed_token=6j7ShiBxxdf_yi8I8bKsFv8aoYrSqfInB4f8_ZVdoz5IdrRgBf9MHBjFMwEKPE_RlmbYOPOq7AL1M2M9lkWDOwXfav2mcumEbmoun_IXOGnIdMZ-dH95fg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=maojindao55/freebuddy&type=date&legend=top-left&sealed_token=6j7ShiBxxdf_yi8I8bKsFv8aoYrSqfInB4f8_ZVdoz5IdrRgBf9MHBjFMwEKPE_RlmbYOPOq7AL1M2M9lkWDOwXfav2mcumEbmoun_IXOGnIdMZ-dH95fg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=maojindao55/freebuddy&type=date&legend=top-left&sealed_token=6j7ShiBxxdf_yi8I8bKsFv8aoYrSqfInB4f8_ZVdoz5IdrRgBf9MHBjFMwEKPE_RlmbYOPOq7AL1M2M9lkWDOwXfav2mcumEbmoun_IXOGnIdMZ-dH95fg" />
 </picture>
 </a>

---

## 社区与支持

- 🐧 **QQ群：** [点击链接加入群聊](https://qm.qq.com/q/Lgu4uyIWCC)

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
