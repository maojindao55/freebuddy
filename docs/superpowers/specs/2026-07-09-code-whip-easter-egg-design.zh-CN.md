# 码鞭（Code Whip）彩蛋设计

## 目标

在会话主页面为正在执行的 Agent 增加一个隐蔽彩蛋：用户点击该助手消息头像时，播放夸张喜剧风的「码鞭」抽打特效。

用户心智：

> Agent 还在跑的时候，点一下它的头像，会甩出一鞭、头像晃一下，还冒个「啪」。好玩，但不影响它干活。

## 非目标

- 不影响 Agent 执行、停止、权限、ACP 协议或任何后端逻辑。
- 不写入消息、不落库、不做埋点统计。
- 本版不做音效（可后续加）。
- 不做连击计数、催促语义、聊天吐槽气泡。
- 不同步侧栏 `WorkspacePanel` 头像。
- 不在 composer 工具栏增加显式「道具」按钮。

## 已确认决策

| 决策 | 选择 |
|------|------|
| 性质 | 纯彩蛋特效，不影响执行 |
| 入口 | 仅点击会话主列表中正在执行的助手消息头像 |
| 特效风格 | 夸张喜剧（甩鞭弧线 + 大晃 +「啪」字样，约 0.8s） |
| 音效 | 本版不做，后续可选 |
| 可用时机 | 仅 `running` / `starting` |
| 实现路径 | CSS 特效挂在 `MessageBubble` 本地状态 |

## 背景

现有会话主页结构：

- `ChatView` 渲染消息列表与底部 composer
- 助手消息在 `MessageBubble` 中通过 `AgentAvatar` 显示头像（`.msg-avatar.agent-avatar`）
- 执行中助手消息 `status` 为 `running` 或 `starting`，内容随 `conversationHandlers` 流式更新
- 已有 CSS 动画先例（`msgSlideIn`、`dots-pulse`、头像 hover `scale(1.05)`），无现成彩蛋/音效基础设施

## 交互

### 触发

1. 仅当助手消息 `status ∈ {running, starting}` 时，其头像可点击。
2. 单击触发一次抽打特效。
3. 执行中头像使用 `cursor: pointer`，hover 比默认略明显，暗示可点但不做显式文案引导。

### 冷却

- 特效时长约 **0.8s**。
- 播放中再次点击**忽略**，避免动画叠加。
- 播放结束后可立即再次触发。

### 空闲 / 其他目标

以下情况点击无特效、无 toast、无控制台噪音：

- 非执行中的助手消息头像
- 历史消息头像
- 用户头像
- 侧栏头像
- Replay 切片中非 live 状态的消息

## 视觉

挂在被点击头像的定位容器上，不遮挡消息正文阅读。

### 时间线（约 0.8s）

| 阶段 | 时间 | 表现 |
|------|------|------|
| 甩鞭 | 0–0.15s | 短鞭影从右上甩向头像（弧线 + 细尾迹） |
| 命中 | 0.15–0.45s | 头像大幅左右晃动 + 轻微旋转；「啪」字样漫画感弹出后淡出 |
| 收尾 | 0.45–0.8s | 头像回正；2–3 个星点/火花散开后消失 |

### 实现要点

- 用临时 class（如 `whip-hit`）+ `whipNonce` 重触发同一套 CSS keyframes。
- 鞭影、「啪」、星点：伪元素或头像旁绝对定位的短生命周期节点；动画结束移除或靠 class 摘除。
- 「啪」为本版固定视觉字样（非 i18n 文案依赖）；若需要可访问名称，可为可点击头像增加 `aria-label`（如「码鞭」）。

### 无障碍

尊重 `prefers-reduced-motion: reduce`：

- 去掉甩鞭弧线与「啪」大字
- 改为短促微抖或轻微闪一下（明显短于 0.8s）

## 架构

### 状态

全部放在 `MessageBubble`（或头像包装层）的**组件本地 state**：

- `whipping: boolean` — 是否正在播放
- `whipNonce: number` — 每次成功触发递增，用于强制重启 CSS 动画

不引入 Zustand store、不改 `conversationStore` / IPC / DB。

### 数据流

```
用户点击执行中助手头像
  → MessageBubble 判断 status ∈ {running, starting} 且 !whipping
  → whipping=true, whipNonce++
  → 头像容器加上 whip-hit（及 nonce 相关 key）
  → CSS 播放约 0.8s
  → animationend / timeout → whipping=false
```

### 代码落点

| 文件 | 变更 |
|------|------|
| `src/components/CLI/MessageBubble.tsx` | 执行中头像 onClick；本地 whip 状态；特效节点 |
| `styles.css` | `whip-hit`、鞭影、「啪」、星点 keyframes；reduced-motion |
| `src/components/CLI/AgentAvatar.tsx` | 仅当现有 props 不足以透传 `onClick` / `className` 时做最小扩展 |
| `src/locales/*.json` | 可选：可点击头像的 `aria-label` 文案 |

### 明确不改

- `conversationStore` / `conversationHandlers`
- Electron IPC / SQLite
- composer `.composer-tools`
- `WorkspacePanel` 侧栏头像

## 边界情况

| 场景 | 行为 |
|------|------|
| 执行中连点 | 第一次播放；播放中忽略 |
| 特效播放中 Agent 结束（status → done） | 当前动画可播完；结束后头像不再可点 |
| 消息列表重渲染 / 流式更新 | 本地 state 保留在该 bubble 实例上；不因 content 更新取消动画 |
| 滚动离开视口 | 动画可在后台播完；不要求追焦 |
| Replay 模式 | 非 live running/starting 不可抽 |
| reduced-motion | 减弱特效 |

## 验收标准

1. Agent 执行中点击该条助手头像 → 约 0.8s 夸张喜剧特效（甩鞭 + 晃动 +「啪」）。
2. 空闲或历史头像点击 → 无可见反馈。
3. 连点不叠加多套动画。
4. 抽打不改变 Agent 运行状态，不产生消息或 DB 写入。
5. `prefers-reduced-motion` 下特效明显减弱且仍可完成一次反馈。

## 测试计划

1. 组件/样式级：执行中头像可点；非执行中不可触发（可用 DOM/class 断言或轻量行为测试）。
2. 手动：跑一轮真实 Agent，点头像看特效与停止按钮仍可用。
3. 手动：系统开启减少动态效果时确认减弱路径。

## 后续可选（不在本版）

- 短「啪」音效（用户手势触发，可关）
- 侧栏头像同步晃动
- 连击彩蛋文案
- composer 显式道具入口
