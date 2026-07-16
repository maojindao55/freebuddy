# 思考强度补 `none`（方案 A）设计

相关 Issue：[#59](https://github.com/maojindao55/freebuddy/issues/59)

> **决策更新（2026-07-16）：** 原 BYOK catalog / Settings「支持思考」方案（B）因配置模型列表会触发 Codex BYOK wrapper（`CODEX_PATH`）且本机常找不到 `codex` 二进制，改为 **方案 A**：在主对话选择器对 `thought_level` 硬补 `none`。下文保留 B 的背景供对照；实现以本节「已确认决策」与「方案 A」为准。

## 目标

在聊天模型选择器的「思考强度」中始终提供 `none`（关闭），让用户可以关掉思考，而不依赖 BYOK catalog 改造。

用户心智：

> 思考强度列表里永远有「关闭」。我选关闭后，下次发送会按 `none` 去 `set_config_option`。

## 非目标

- 不在 `SessionConfigPicker` 里硬塞与 ACP 无关的 `none` 选项。
- 不做 Claude BYOK 的同等能力（除非后续单独需求）。
- 不做上游代理的「思考模式 / 思考等级」双开关完整页（评论截图中的 cc 配置属于代理层）。
- 首版不暴露 `minimal` / `xhigh` 作为 Settings 可选项（Catalog 若模板带有可忽略；UI 默认档位集合为 `none/low/medium/high`）。
- 不改变官方非 BYOK Codex 模型的选项来源（仍完全由 Agent ACP 回流决定）。

## 背景与根因

主对话思考强度来自 ACP `configOptions`（`category: "thought_level"`），经 `session/set_config_option` 生效。Freebuddy UI 本身透传，不编造档位。

但 Codex BYOK 路径会生成 `model_catalog.json`。当前 `createCodexByokModelCatalog` 对**所有**自定义模型套用同一模板，其中包括：

```ts
supported_reasoning_levels: [
  { effort: "low", ... },
  { effort: "medium", ... },
  { effort: "high", ... }
]
```

因此不支持 reasoning 的 BYOK 模型也会在聊天选择器里出现思考强度，且缺少关闭档位。

Codex 配置侧 `model_reasoning_effort` 常见值为 `minimal|low|medium|high|xhigh`；本设计在 BYOK catalog 中显式声明 `none`，使支持思考的模型可关闭思考。实现时需验证当前 Codex 版本对 catalog 中 `effort: "none"` 的接受情况；若不接受，回退为「不支持思考时省略 levels」+「支持时用 `minimal` 作为最轻档」并在 spec 修订中记录。

## 已确认决策（方案 A）

| 决策 | 选择 |
|------|------|
| 实现路径 | UI 对 `category === "thought_level"` 硬补 `none`（若不存在） |
| Settings / BYOK catalog | 不改；不增加「支持思考」开关 |
| 生效方式 | 仍走既有 sticky override → `session/set_config_option` |
| `none` 展示文案 | 中「关闭」/ 英 `Off` |
| 已知风险 | Agent/Codex 若不认 `none`，设置可能失败或被忽略 |

## 方案 A 实现要点

- `ensureThoughtLevelNoneOption`：在 `filterSessionConfigPickerOptions` 之后注入 `{ id: "none" }` 到 `thought_level.values` 首位（已存在则不重复）。
- `SessionConfigPicker` / `configOptionChoiceLabel`：无友好名时把 `none` 显示为「关闭」/ `Off`。
- 不改 `electron/cli/store.ts` catalog 与 wrapper。

## 数据模型

```ts
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface CLIByokModel {
  id: string;
  name?: string;
  /** 默认 false：不声明 reasoning levels，聊天不出现思考强度 */
  supportsReasoning?: boolean;
  /** 仅 supportsReasoning=true 时生效 */
  reasoningLevels?: ReasoningEffort[];
  defaultReasoningLevel?: ReasoningEffort;
}
```

类型需同步：

- `electron/cli/store.ts`
- `src/services/cli/types.ts`（及任何镜像定义）

### 规范化规则（`normalizeByokModels`）

1. 缺省 / 旧数据：`supportsReasoning` 视为 `false`；存盘时可省略 `reasoningLevels` / `defaultReasoningLevel`。
2. `supportsReasoning === true`：
   - `reasoningLevels` 缺省 → `["none", "low", "medium", "high"]`
   - 过滤非法值、去重；若存在思考支持则**确保包含 `none`**
   - `defaultReasoningLevel` 必须 ∈ levels；否则回落 `none`，再否则 levels[0]
3. `supportsReasoning === false`：忽略 levels / default（不写入 catalog 的 reasoning 字段）

## Catalog 生成

`createCodexByokModelCatalog(models)`：

- `supportsReasoning !== true`：
  - **不写** `supported_reasoning_levels`（并从模板展开结果中删除该字段，避免模板污染）
  - 视 Codex 行为决定是否同时关闭 `supports_reasoning_summaries`；优先最小改动：只去掉 levels。若实测仍暴露 thought_level，再在实现中收紧。
- `supportsReasoning === true`：
  - 写入 `supported_reasoning_levels: levels.map(effort => ({ effort, description }))`
  - 写入 `default_reasoning_level: defaultReasoningLevel`
- Catalog 文件签名必须纳入 `supportsReasoning`、levels、default，避免改配置仍命中旧 json。

## Settings UI

位置：Settings → Coding Agents → Codex BYOK → 模型列表。

每个模型行：

1. 现有：`id` | `显示名` | 删除
2. 新增附属行（仅 Codex）：
   - Checkbox：**支持思考** / Support thinking
   - 勾选后：
     - 档位多选：`none` / `low` / `medium` / `high`
     - 默认档位：单选，选项 ⊆ 已选档位
3. 取消勾选「支持思考」：UI 收起档位控件；存盘省略 reasoning 字段
4. 去掉某档位导致默认失效：自动回落（优先 `none`）

文案键（`en.json` / `zh-CN.json`）：

- `settings.cli.byok.supportsReasoning`
- `settings.cli.byok.reasoningLevels`
- `settings.cli.byok.defaultReasoningLevel`
- 聊天侧对 value `none` 的标签：`chat.thoughtLevelNone` → 关闭 / Off  
  （若 ACP 已给 name 则优先用 ACP name；仅当 value 为 `none` 且无友好名时用该键）

## 聊天侧行为

- `SessionConfigPicker` 过滤与透传逻辑保持不变（`model` / `model_config` / `thought_level`）。
- 换模型或 Agent 回流后，继续用现有 `pruneConfigOptionOverrides` / `reconcileConfigOptionOverrides` 清理非法 override。
- 不对非 BYOK 会话做特殊分支。

## 测试计划

### 单元测试

1. `normalizeByokModels`
   - 旧 `{ id, name }` → 无 reasoning 字段语义（supportsReasoning false）
   - `supportsReasoning: true` 无 levels → 补齐默认 levels，含 `none`，默认 `none`
   - 非法档位过滤；默认不在列表内时回落
2. `createCodexByokModelCatalog`
   - 不支持思考 → entry 无 `supported_reasoning_levels`
   - 支持思考 → 写入 levels + default
   - 修改 reasoning 配置 → catalog 内容/签名变化
3. （可选）`none` 标签 helper

### 手动验收

1. 旧 BYOK 配置升级后：聊天默认不再出现思考强度
2. 勾选支持思考并保存：新会话可选 `none/low/medium/high`，选 `none` 可发送
3. 关闭支持思考：选择器不再出现思考强度；旧 override 被 prune
4. Claude BYOK 不受影响

## 验收标准（对应 #59）

- BYOK 用户可为不支持思考的模型关闭思考强度入口
- 对支持思考的模型，可选择 `none`（关闭）

## 实现顺序建议

1. 扩展类型 + `normalizeByokModels` + catalog 生成 + 单测
2. Settings UI + i18n
3. 聊天 `none` 文案（如需要）
4. 手动验收 BYOK 端到端；若 Codex 拒收 `none`，按「背景」中的回退策略修订并补测
