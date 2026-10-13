# 文件变化体验检查

日期：2026-10-13。使用 Product Design 的 audit 工作流，检查当前分支的真实 React 组件验证页。浏览器为 Codex 内置浏览器；数据为本地模拟记录，不启动 Agent，不修改真实会话。另使用用户提供的真实 Qoder 截图。

初始结论：保留卡片与侧栏结构，优先调整状态说明、稳定列表和历史版本含义。第一阶段现已实现，验证记录补充在下方。

## 检查步骤

| 步骤 | 页面与行为 | 状态 | 发现与方案 |
|---|---|---|---|
| 1 | 模拟运行中 | 可验证 | 文件卡片隐藏，用户无法从此组件确认文件记录的进展。保留轻量运行状态，不展示未冻结整体差异。 |
| 2 | 结束本轮，显示文件列表 | 正常，有信息边界 | 文件名、目录和打开入口明确；尚未显示行数。保留按需计算，未知行数不显示为 0。 |
| 3 | 打开 Login.tsx | 正常 | 列表回填 +3/−2，侧栏显示完整净差异。复用现有全宽、折叠和切换操作。 |
| 4 | 选择改后恢复的 reverted.ts | 存在一致性问题 | 聊天卡片的剩余数量由 3 变 2；阅读器仍为 6/6 并保留该文件。新版本在索引发布前按摘要与存在性统一排除无净变化文件。 |
| 5 | 用户提供的 Qoder 片段阅读截图 | 记录展示正确，说明可改进 | +3/−3 正确；两个提示重复说明无法预览全文，Markdown 预览禁用。合并提示，明确“操作记录”的范围；有可靠版本对后提供完整预览。 |

### 1. 运行中

![运行中隐藏卡片](C:/Users/Morefine/www/freebuddy/artifacts/product-design/turn-file-diff-baseline/01-running.jpg)

### 2. 文件列表

![结束后的文件列表](C:/Users/Morefine/www/freebuddy/artifacts/product-design/turn-file-diff-baseline/02-file-list.jpg)

### 3. 打开完整净差异

![完整差异阅读与净统计](C:/Users/Morefine/www/freebuddy/artifacts/product-design/turn-file-diff-baseline/03-net-diff.jpg)

### 4. 改后恢复

![无净变化文件的列表与选择器差异](C:/Users/Morefine/www/freebuddy/artifacts/product-design/turn-file-diff-baseline/04-no-net-change.jpg)

### 5. 真实 Qoder 截图

![用户提供的 Qoder 局部记录](C:/Users/Morefine/www/freebuddy/artifacts/product-design/turn-file-diff-baseline/05-qoder-fragments.png)

## 调整优先级

1. 发布结果时稳定文件列表；卡片与选择器使用相同索引。
2. 区分“本轮差异”“操作记录”“无法确认”，合并重复说明。
3. 修改前/后明确绑定本轮保存版本；打开磁盘文件标注“打开当前文件”。

## 无障碍与证据边界

界面已有可识别的文件按钮、快捷键标题及聚焦边框。计划中的状态必须有文字，不能仅靠颜色；禁用预览的原因应保持可见，并适用于键盘用户。后续需要实测键盘焦点、屏幕阅读器状态宣告和颜色对比度。

这里检查的是组件验证页和用户截图，没有验证真实 Electron 全流程、全部 Agent、读写权限或新快照服务。截图中的验证页按钮不是产品 UI，不对其视觉作产品结论。所有截图已保存并逐一打开确认。

完整技术和交互方案：[每轮文件版本与差异方案](C:/Users/Morefine/www/freebuddy/docs/superpowers/specs/2026-10-13-turn-file-snapshots-design.md)。

## 第一阶段实现后的检查

使用本分支的真实 FileChangesCard / FileDiffPanel / fileDiffStore 组件验证页，在内置浏览器中操作并保存截图。采集和历史存储由独立数据库测试验证，浏览器页面使用内存 API 数据。验证期间视口有 1280×720 和 880×900 两种尺寸；不作像素级前后对齐结论。

| 状态 | 验证结果 | 证据 |
|---|---|---|
| 执行中 | 显示轻量进度，不发布文件索引 | [截图](06-snapshot-running.png) |
| 完整差异 | 三处修改为第 3/5/7 行，+3/−3；reverted.md 不出现在卡片和选择器 | [截图](07-snapshot-net-diff.png) |
| Markdown | 可切换本轮起点与结束版本，完整显示文档 | [截图](08-snapshot-markdown.png) |
| 360px 侧栏 | 工具栏换行，前后版本按钮与文档可读 | [截图](09-snapshot-narrow-before.png) |
| 全宽与键盘 | 全宽保持当前版本，Esc 返回原控件；Alt+↓ 切换到 empty.md | [截图](10-snapshot-full-width.png) |
| 局部回退 | Markdown 禁用，一条可见说明解释片段行号和预览边界 | [截图](11-snapshot-partial.png) |
| 无净变化 | 紧凑状态，无幽灵文件条目 | [截图](12-snapshot-zero.png) |
| 并行任务 | 卡片与阅读器都有可能包含其他任务修改的提示 | [截图](13-snapshot-overlap.png) |
| 封存中 | 显示整理进度，完成后自动发布稳定索引 | [截图](14-snapshot-finalizing.png) |

沿用原有字体、颜色、间距、图标和卡片 / 阅读器样式；新增内容为文字状态和版本标签，没有新增图像资产。未发现隐藏阅读控件或阻止文件切换的布局问题。未做完整屏幕阅读器或对比度审计。

验证结果：相关 Node 测试 231 项和数据库测试 50 项通过，各有 1 项符号链接测试受环境限制跳过。真实 Qoder / Qwen3.8-Flash opt-in 测试已通过：发送 prompt 前已有基线，三次独立编辑生成完整第 3/5/7 行差异；随后改变磁盘文件并重开快照数据库，历史版本仍正确。具体结果见 [qoder-live-result.json](qoder-live-result.json)。真实测试中的桌面服务被替换，ACP 运行时、Qoder、存储与读取使用实际实现；截图仍为组件验证页数据。

用户后续截图对应任务的数据库没有快照采集记录，属于旧记录回退。新增 `npm run dev:snapshots` 作为明确的开发试点入口，避免普通启动时误以为已开启文件版本采集；该入口只改变启动子进程的环境变量。
