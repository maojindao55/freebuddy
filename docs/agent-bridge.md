# Agent Bridge — FreeBuddy ↔ Agent 双向通道

FreeBuddy 与所运行的 coding agent 之间,有一套**不依赖 MCP/ACP 工具注入、零 agent 端适配**的双向交互层。它只借助 agent 自带的两个通用能力:**读取 workspace 指令文件** + **执行命令**。

## 总览

| 方向 | 机制 | 载体 |
| --- | --- | --- |
| FreeBuddy → agent(注入提示词/上下文) | workspace 指令文件 | `AGENTS.md` / `CLAUDE.md` / `.cursorrules` |
| agent → FreeBuddy(调用能力) | 本地 loopback HTTP | `http://127.0.0.1:<port>/freebuddy/<action>` |

## 1. 注入方向(FreeBuddy → agent)

新建带 `cwd` 的会话时,`ensureAgentGuides`(主进程)在 workspace 根目录写入指令文件:

- `AGENTS.md`(codex / opencode 读取)
- `CLAUDE.md`(claude 读取)
- `.cursorrules`(cursor 读取)

内容含:环境说明、产出规范(可预览 web 产物)、以及**从 action 注册表自动生成的能力清单**(见下)。agent 启动时自动读进上下文,等价于注入了 system 提示词,绕过了「FreeBuddy 无 systemPrompt 注入入口」的限制。

更新策略:
- 含 `auto-created by FreeBuddy` 标记的文件会被自动更新(随端口/能力变化保持最新)。
- 用户自己编辑过(无标记)的文件永不覆盖。
- FreeBuddy 重启后端口变化,下次写指令文件时自动更新为新端口。

## 2. 回调方向(agent → FreeBuddy)

FreeBuddy 在 app ready 时启动一个仅监听 `127.0.0.1` 的本地 HTTP server(`previewServer.ts`),端口由 OS 动态分配。agent 用它的 execute 工具执行 `curl` 即可调用:

```
curl -s "http://127.0.0.1:<port>/freebuddy/<action>?<params>"
```

请求经 `parseBridgeRequest` 解析,通过 IPC `freebuddy://bridge` 转发到 renderer,由 `AgentBridgeListener` 按 `action` 分发到对应 store。

> 端口写入指令文件(具体端口号),agent 直接照抄 curl 命令即可,无需自行发现端口。

### 当前 actions

单一事实来源:`BRIDGE_ACTIONS`(`electron/agentBridge.ts`)。它同时驱动 HTTP 路由校验与指令文件的能力清单生成。

| action | 作用 | 参数 |
| --- | --- | --- |
| `preview` | 切到 Draft web 预览面板 | — |
| `navigate` | 预览跳转到指定 workspace 相对路径 | `to`(必填) |
| `notify` | 在 FreeBuddy 弹一条 toast 提示 | `text`(必填) |

示例:
```sh
curl -s "http://127.0.0.1:<port>/freebuddy/preview"
curl -s "http://127.0.0.1:<port>/freebuddy/navigate?to=about.html"
curl -s "http://127.0.0.1:<port>/freebuddy/notify?text=done"
```

(向后兼容:旧的 `/preview` 仍被识别为 `preview`。)

## 3. 扩展一个新 action

只需三步,HTTP 路由与指令清单会自动跟进:

1. 在 `electron/agentGuides... agentBridge.ts` 的 `BRIDGE_ACTIONS` 加一项:`{ name, summary, description, params? }`。
2. 在 `previewServer.ts` 的请求处理里无需改动(已用 `isKnownBridgeAction` 自动放行);IPC 载荷 `{ action, params }` 透传。
3. 在 `src/components/AgentBridge/AgentBridgeListener.tsx` 的分发 switch 里加一个 `case`,调用相应 store。

指令文件会在下次 `ensureAgentGuides` 时把新 action 的 curl 示例与参数说明自动写进能力清单。

## 4. OS scheme(可选,仅打包)

`main.ts` 还注册了 `freebuddy://` scheme(`app.isPackaged` 守卫,仅打包生效):打包后 `open "freebuddy://preview"` 也会经同一 `onBridge` 入口触发。dev 模式不注册(避免 LaunchServices 报错),改由本地 HTTP 承担。

## 设计要点

- **零 agent 适配**:只用 agent 通用的「读指令文件」+「执行命令」,不要求 agent 支持 MCP/自定义工具。
- **单一事实来源**:`BRIDGE_ACTIONS` 一处定义,路由 + 文档 + 注入清单都从它派生。
- **本地 loopback**:HTTP 只绑 `127.0.0.1`,不暴露网络;端口动态,避免冲突。
- **非破坏**:指令文件可编辑/可删,scheme 仅打包,HTTP 失败不影响手动操作预览。
