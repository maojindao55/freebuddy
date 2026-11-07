# 会话消息队列集成 — 设计 QA

final result: passed

## 比较目标与证据

- Source visual truth：`artifacts/product-design/message-queue-integration/selected-direction.png`，用户选中的第三个方向。
- 原图 1672 × 941 px，等比归一到 1280 × 720 px：`artifacts/product-design/message-queue-integration/reference-1280.png`。
- Implementation：`http://127.0.0.1:5185/tests/fixtures/message-queue-preview.html`，使用真实 ChatView、队列 store、runner 和队列组件；仅原生传输和 Agent 在测试页中模拟。
- 桌面 CSS viewport 1280 × 720，devicePixelRatio 1，截图 1280 × 720 px：`artifacts/product-design/message-queue-integration/desktop-light.png`。
- 对齐状态：浅色、当前答复运行中、待发 2 条、浮层展开、输入框中保留独立草稿。
- 完整同图比较：`artifacts/product-design/message-queue-integration/comparison-full.png`。参考与实现按相同像素尺寸并排。
- 细节同图比较：`artifacts/product-design/message-queue-integration/comparison-detail.png`。保留各自原始 CSS 像素，展示浮层、序号、编辑/移除、提示与发送控件。
- 额外证据（均在同一 integration 目录）：`desktop-dark.png`、`english-dark.png`（1280 × 720）；`narrow-light.png`、`narrow-english-dark.png`（390 × 844）；`paused-light.png`（1280 × 800）；`edit-holds-dispatch.png`、`drained.png`（1280 × 720）。
- 360 × 640 CSS viewport 额外检查了 DOM 边界：document.scrollWidth 为 360，输入框 left 14 / right 346 / bottom 626，浮层 left 25 / right 345 / top 77.4 / bottom 309.8。`narrow-360-dark.png` 实际导出 296 × 640 px，与设置宽度不一致，因此不作为 1:1 保真证据；窄屏视觉判断使用两张完整 390px 截图。

## Findings

最终同图比较无待处理的 P0/P1/P2 问题。

这是把选定的队列方向融入已有产品，而非重做整个聊天界面：保留既有侧栏、会话气泡、820px 内容宽度、13px 级别 UI 字体与圆形发送/停止按钮。相对概念稿更紧凑的密度、运行中锁定的模型配置、每条消息的配置摘要，以及浮层不带气泡尖角，均按现有组件约束处理。队列入口仍是输入框上方的一条紧凑栏，点击展开后能看到顺序与操作。

## 五项保真检查

- **字体与排版**：沿用 FreeBuddy 的 Plus Jakarta Sans / 系统中文回退栈。标题、正文、配置摘要和辅助说明有明确层级；与概念稿较大的字体存在有意密度差异。中英文、长英文提示与窄屏换行均可读，无文字覆盖按钮。
- **间距与布局**：条形入口和输入框左右对齐，浮层锚定其上方，行分隔与编辑动作一致。修复后输入框四角闭合，窄屏工具栏换行，主要发送和停止按钮保持可见。390px 展开浮层完整位于视口内。
- **颜色与 tokens**：复用现有 surface、border、text 和 muted tokens；浅色为白色/浅灰表面，深色为既有蓝黑表面。运行状态绿色、停止按钮红色沿用产品语义。浮层边界与文字在两种主题均可区分。
- **图像与图标**：既有 Agent 品牌图标与图标库提供的列表、暂停、编辑、移除、停止/发送图标保持一致；未引入新的装饰插画或手工近似品牌资源。队列行图标边缘清晰、无拉伸。
- **文案与内容**：“待发送”“当前回复后依次发送”“加入队列”等只描述产品行为。编辑、暂停/继续、失败状态使用明确文案。测试页顶部的调试按钮仅属于 fixture，未进入正式会话界面。

## 比较迭代记录

1. **P2 / blocked：输入框下角变方。** 为容纳浮层而开放 overflow 后，旧的内部圆角依赖失效。修复 `.chat-composer:has(.message-queue-control)` 的 context/actions 圆角；最终 `desktop-light.png`、`desktop-dark.png` 显示完整圆角。
2. **P2 / blocked：窄屏输入框被旧网格拉高，浮层被挤出视口。** 将启用队列的窄屏输入框置于 grid-row 3、align-self end，单独预留队列条空间；工具栏允许换行，窄屏隐藏快捷键提示。修复后重新检查 390 × 844 与 360 × 640，前述边界测量及 `narrow-light.png` / `narrow-english-dark.png` 证实控件可见，无横向溢出。初始问题未保留截图，不将最终截图冒充修复前证据。
3. **最终 / passed：** 完整和细节比较均已查看，保留已有产品外壳的适配差异，无剩余 P0/P1/P2。

## 浏览器交互检查

- 运行中点击或 Enter 入队，计数更新，清空已接受草稿，当前任务继续。
- Shift+Enter 换行；Escape 关闭浮层；独立编辑不覆盖输入框草稿。
- 修改第一条、移除第二条，队列顺序与计数正确。
- 编辑期间完成当前回复，下一条仍等待；保存后继续派发。
- 停止后保留消息并暂停；点击继续后从队首开始。
- 连续两条模拟任务依次完成，队列入口消失，恢复普通发送，独立草稿仍保留（`drained.png`）。
- 浅/深色、中/英文以及窄屏布局检查完成；浏览器 warn/error 日志为空。

## 实现与回归验证

- `npm run typecheck`：通过。
- `npm run build:renderer`：通过，保留项目已有的包体积提醒。
- `npm test`：2349 通过、0 失败、339 按平台/环境跳过（共 2688 项）；其中新增 16 项真实 SQLite / IPC 队列测试。
- `git diff --check`：通过。
- 数据库和 IPC 测试验证真实服务与处理函数，CLI 执行边界模拟；浏览器测试不操作用户数据。

## Open Questions / 验证边界

- 首版仅桌面端普通单 Agent 会话支持队列；WebUI、团队与工作流不显示入口。
- 未调用真实云端 Agent，也未打包发布安装包。实际模型/CLI 进程的完整一轮仍需在开发版中试用。
- 系统文件选择器、真实输入法候选确认及跨显示器字号缩放未进行人工端到端测试；IME 提交保护已接入现有输入处理。

## Implementation Checklist

- [x] 接入持久化队列、共享发送锁、答复保存确认与重启暂停恢复。
- [x] 复用真实发送链路与附件、技能、引用快照。
- [x] 交付紧凑入口、独立编辑、移除与暂停/继续。
- [x] 查看参考与实现的完整/局部同图比较。
- [x] 修复桌面圆角与窄屏布局并重新捕获。
- [x] 检查主要交互、语言、主题、控制台与完整回归。

## Follow-up Polish

- P3：在真实 Electron 字体渲染及系统缩放设置下补充最终观感检查。


---

## 2026-11-07：弱化“待发送”标题

final result: passed

- 用户反馈与 source visual truth：`artifacts/product-design/message-queue-integration/feedback-title.png`（1152 × 842 px 截图片段，原始 CSS 缩放未知）。该图用于定位标题过强的问题，不进行整屏像素匹配。
- 同状态浏览器证据：`artifacts/product-design/message-queue-integration/title-before.png` 与 `title-after.png`，均为 1280 × 720 CSS / screenshot px，DPR 1，浅色、当前回复运行中、队列 2 条并展开；没有密度缩放。
- 完整同图比较：`artifacts/product-design/message-queue-integration/title-comparison-full.png`；局部同图比较：`title-comparison-detail.png`。两者均已查看。
- Finding / P2：浮层标题 18px、600、主文字颜色，与辅助功能的层级不符，抢占消息内容的注意力。修复为 13px、500、`--fb-text-secondary`，行高 1.5；仅修改 `.message-queue-popover h3`。
- 字体/排版：沿用现有字体栈，标题尺寸与消息正文接近，颜色和字重弱化；保留语义 heading。
- 间距/布局：沿用现有浮层间距，标题缩小使面板略矮；序号、正文与操作保持对齐。
- 颜色：浅色实测 `rgb(71, 85, 105)`，深色 `rgb(203, 213, 225)`；均来自既有主题 token。深色证据：`title-after-dark.png`。
- 图像质量：本次未更换任何图像或图标；浏览器文字与已有图标边缘清晰。
- 文案：保留原文案与数量，最新用户要求覆盖原概念稿的大标题风格。
- 比较历史：调整前标题过强 → 更新一条 CSS 规则 → 同视口重新捕获并比较；无剩余 P0/P1/P2。
- 验证：浏览器计算样式与目标一致，展开/主题切换正常，warn/error 为空；`npm run build:renderer` 与 `git diff --check` 通过。纯视觉改动未重复运行完整业务测试。
- Checklist：已缩小字号、减轻字重、采用次级色、检查浅/深色、完成同图比较。


---

## 2026-11-07：移除弹框内两句常驻说明

final result: passed

- Source visual truth：用户标注图 `artifacts/product-design/message-queue-integration/feedback-simplify.png`，1018 × 482 px 局部截图，原始 CSS 缩放未知；用于确认顶部和底部两句需移除的文案。
- 同状态实现截图：`artifacts/product-design/message-queue-integration/copy-before.png`、`copy-after.png`；1280 × 720 CSS / screenshot px，DPR 1，无密度缩放；浅色、运行中、队列 2 条、浮层展开。
- 完整同图比较 `copy-comparison-full.png`、细节同图比较 `copy-comparison-detail.png` 均已查看，文件位于同一 integration 目录。
- Findings：移除顶部“当前回复完成后依次发送”和底部“可在发送前编辑或移除消息”，同时移除底部说明区域及其分隔线。标题与暂停按钮居中对齐。无需操作时不显示额外说明；暂停、编辑、失败等必要状态仍按需出现。
- 五项检查：字体保持 13px / 500 次级色标题；布局因移除两处说明更紧凑（最终浮层 194.19 CSS px 高）；颜色与主题 token 沿用现状；图像/图标未替换且保持清晰；两处文案从普通状态的弹框 DOM 中消失，消息内容与外部队列栏保留。
- 比较历史：按用户新的简化要求移除两处说明 → 同视口重新截图 → 完整及局部同图检查通过；无剩余 P0/P1/P2。
- 操作验证：浏览器暂停后显示必要状态及标题栏继续按钮，点击继续恢复普通简洁布局；编辑和移除按钮仍保留。暂停截图 `copy-paused.png`；浏览器 warn/error 为空。原生传输及 Agent 为 fixture 模拟。
- 验证：`npm run typecheck`、`npm run build:renderer`、`git diff --check` 通过。仅修改渲染与样式，未新增镜像式测试。
- Checklist：已删除两句常驻说明、移除空 footer、保留必要状态、核对暂停/继续、完成视觉比较及构建。


---

## 2026-11-07：继续压缩标题区域

final result: passed

- Source visual truth：沿用用户队列截图及最新“压缩 header”要求；同状态基线 `artifacts/product-design/message-queue-integration/header-before.png`，实现 `header-after.png`，均 1280 × 720 CSS / screenshot px、DPR 1、浅色、运行中、队列 2 条展开，无缩放。
- 完整同图比较 `header-comparison-full.png` 与局部同图比较 `header-comparison-detail.png`（同一目录）均已查看。
- 修改与迭代：顶部留白 16 → 8px，header 下留白 14 → 6px；普通状态标题区总占位 58 → 42px，面板总高 194.19 → 178.19px。窄屏顶部留白也降至 8px；暂停按钮保持 28 × 28px。
- 五项检查：13px / 500 字体及层级保留；上下留白按要求压缩且标题与按钮对齐；主题颜色未改；图标清晰、未替换资源；文案未变。最终无剩余 P0/P1/P2。
- 验证：浏览器实测尺寸符合预期，warn/error 为空；`npm run build:renderer`、`git diff --check` 通过。
- Checklist：收紧顶部与下方留白、保留点击区域、同图核对、构建通过。


---

## 2026-11-07：收紧弹框底部留白

final result: passed

- Source visual truth：用户“底部留白还是有点大”的最新反馈与同状态基线 `artifacts/product-design/message-queue-integration/header-after.png`；实现 `bottom-after.png`。两张均 1280 × 720 CSS / screenshot px、DPR 1、浅色、运行中、队列 2 条展开，无缩放。
- 完整同图比较 `bottom-comparison-full.png`、局部同图比较 `bottom-comparison-detail.png`（同一目录）均已查看。
- 修改与迭代：底部 padding 16 → 8px，末条消息额外下 padding 10 → 0px；窄屏底部同样为 8px。面板高度 178.19 → 160.19px，避免两层间距叠加。
- 五项检查：字体、颜色、图标、文案保持原样；布局底部更贴近最后一条消息且无裁切。无剩余 P0/P1/P2。
- 验证：浏览器实测 padding 为 8px / 0px，warn/error 为空；`npm run build:renderer`、`git diff --check` 通过。
- Checklist：合并底部留白、桌面/窄屏统一、完成同图比较与构建。
