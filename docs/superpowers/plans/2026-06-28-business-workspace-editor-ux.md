# 业务空间编辑器 UX 优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「新建/编辑业务空间」页面重构为「模板优先混合」交互（方案 C），提升结构引导、视觉专业度与细节体验。

**Architecture:** 纯前端改造。`BusinessWorkspaceEditor.tsx` 重排 JSX + 增加状态（模板选中/切换确认/名称内联校验）；端类型汉化走 `KIND_META` 映射；协作与策略合并为带项数徽标的折叠区；样式在 `styles.css` 增补专属类；所有文案经 i18n（en + zh 对齐）。不改数据模型/store/service。

**Tech Stack:** React 19 + TypeScript + zustand + i18next；测试为 `node --test` 静态源码串匹配（`tests/*.mjs` 读源文件做正则断言）；`npm run typecheck` 做类型校验。

**Baseline note:** 当前工作区在 `feat/business-workspace` 分支上已有未提交的编辑器实现（`BusinessWorkspaceEditor.tsx`、两个 locale、`styles.css`、`tests/business-ui.test.mjs`）。该状态即本计划起点。Task 1 先把这批在制工作提交为基线，后续任务在其之上做增量 UX 改造与独立提交。

**Spec:** `docs/superpowers/specs/2026-06-28-business-workspace-editor-ux-design.zh-CN.md`

---

## File Structure

- `src/locales/zh-CN.json`、`src/locales/en.json` — 新增 16 个 business key（两语言对齐）。
- `src/components/Settings/BusinessWorkspaceEditor.tsx` — 新增 `KIND_META`、`matchTemplate`；状态 `selectedTemplateId`/`nameError`；重排 JSX（模板 hero 前置、协作与策略合并折叠）；汉化徽章/下拉、目录按钮文案、主按钮文案。
- `styles.css` — 新增模板选中态、端类型徽章分色、项数徽标、字段错误态等样式。
- `tests/business-ui.test.mjs` — 更新被重构影响的断言；新增对新增行为的串匹配断言。

每个任务产出可独立提交、可通过 `node --test tests/business-ui.test.mjs tests/i18n-strings.test.mjs` 与 `npm run typecheck` 的改动。

---

## Task 1: 提交基线 + 新增 i18n key（en/zh 对齐）

**Files:**
- 已改（基线提交）: `src/components/Settings/BusinessWorkspaceEditor.tsx`, `src/locales/en.json`, `src/locales/zh-CN.json`, `styles.css`, `tests/business-ui.test.mjs`
- Modify: `src/locales/zh-CN.json`（business 块内），`src/locales/en.json`（business 块内）
- Test: `tests/business-ui.test.mjs`

- [ ] **Step 1: 提交当前在制工作为基线**

```bash
git add src/components/Settings/BusinessWorkspaceEditor.tsx src/locales/en.json src/locales/zh-CN.json styles.css tests/business-ui.test.mjs
git commit -m "feat(business): template-based workspace editor baseline"
```

- [ ] **Step 2: 写失败测试 — 在 `tests/business-ui.test.mjs` 末尾追加**

```js
test("Business workspace editor exposes UX redesign i18n keys in both locales", () => {
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  const keys = [
    "chooseDirectory", "saveFailed", "nameRequired", "switchTemplateConfirm",
    "collaborationAndPolicy", "advancedCountHint", "createWorkspace", "templateRepoCount",
    "kind_client", "kind_server", "kind_admin", "kind_shared",
    "kind_docs", "kind_test", "kind_custom"
  ];
  for (const k of keys) {
    assert.ok(en.business[k], `en missing business.${k}`);
    assert.ok(zh.business[k], `zh missing business.${k}`);
  }
  // advancedCountHint / templateRepoCount must support interpolation
  assert.match(zh.business.advancedCountHint, /\{\{count\}\}/);
  assert.match(en.business.templateRepoCount, /\{\{count\}\}/);
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `node --test tests/business-ui.test.mjs`
Expected: FAIL — `en missing business.chooseDirectory`（key 尚未存在）。

- [ ] **Step 4: 在 `src/locales/zh-CN.json` 的 business 块内，紧接 `"branchNameTemplate": "分支名模板",` 之后插入**

```
    "branchNameTemplate": "分支名模板",
    "chooseDirectory": "选择目录",
    "saveFailed": "保存失败，请重试",
    "nameRequired": "请填写名称",
    "switchTemplateConfirm": "切换模板会替换当前仓库列表，是否继续？",
    "collaborationAndPolicy": "协作与提交策略",
    "advancedCountHint": "{{count}} 项可调",
    "createWorkspace": "创建业务空间",
    "templateRepoCount": "{{count}} 仓库",
    "kind_client": "C端",
    "kind_server": "服务端",
    "kind_admin": "管理",
    "kind_shared": "共享",
    "kind_docs": "文档",
    "kind_test": "测试",
    "kind_custom": "自定义",
```

- [ ] **Step 5: 在 `src/locales/en.json` 的 business 块内，紧接 `"branchNameTemplate": "Branch name template",` 之后插入**

```
    "branchNameTemplate": "Branch name template",
    "chooseDirectory": "Choose directory",
    "saveFailed": "Save failed, please try again",
    "nameRequired": "Please enter a name",
    "switchTemplateConfirm": "Switching templates will replace the current repository list. Continue?",
    "collaborationAndPolicy": "Collaboration & commit policy",
    "advancedCountHint": "{{count}} adjustable",
    "createWorkspace": "Create workspace",
    "templateRepoCount": "{{count}} repos",
    "kind_client": "Client",
    "kind_server": "Server",
    "kind_admin": "Admin",
    "kind_shared": "Shared",
    "kind_docs": "Docs",
    "kind_test": "Test",
    "kind_custom": "Custom",
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `node --test tests/business-ui.test.mjs tests/i18n-strings.test.mjs`
Expected: PASS（新 key 两语言对齐；`i18n-strings` 仍无 CJK 泄漏到 src）。

- [ ] **Step 7: Commit**

```bash
git add src/locales/zh-CN.json src/locales/en.json tests/business-ui.test.mjs
git commit -m "feat(business): add UX redesign i18n keys (en/zh)"
```

---

## Task 2: 端类型汉化 + 图标（KIND_META 映射）

**Files:**
- Modify: `src/components/Settings/BusinessWorkspaceEditor.tsx`（新增 `KIND_META`；替换徽章与下拉）
- Modify: `styles.css`（端类型徽章分色）
- Test: `tests/business-ui.test.mjs`

- [ ] **Step 1: 写失败测试 — 在 `tests/business-ui.test.mjs` 末尾追加**

```js
test("Business workspace editor localizes surface kinds via KIND_META", () => {
  const editor = read("../src/components/Settings/BusinessWorkspaceEditor.tsx");
  assert.match(editor, /KIND_META/);
  assert.match(editor, /business\.kind_client/);
  // raw kind label in the type <select> must be gone
  assert.doesNotMatch(editor, /\{kind\}\s*<\/option>/);
  // raw kind badge must be gone
  assert.doesNotMatch(editor, /workflow-team-badge muted">\{surface\.kind\}/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test tests/business-ui.test.mjs`
Expected: FAIL — `KIND_META` 未定义。

- [ ] **Step 3: 在 `BusinessWorkspaceEditor.tsx` 中，紧接 `const CONTRACT_ROLES = ...;` 行之后新增 `KIND_META`**

```ts
const CONTRACT_ROLES: ContractRole[] = ["provider", "consumer", "both", "none"];

const KIND_META: Record<BusinessSurfaceKind, { icon: string; labelKey: string; tone: string }> = {
  client: { icon: "◐", labelKey: "business.kind_client", tone: "client" },
  server: { icon: "●", labelKey: "business.kind_server", tone: "server" },
  admin: { icon: "◑", labelKey: "business.kind_admin", tone: "admin" },
  shared: { icon: "◐", labelKey: "business.kind_shared", tone: "shared" },
  docs: { icon: "▤", labelKey: "business.kind_docs", tone: "docs" },
  test: { icon: "✓", labelKey: "business.kind_test", tone: "test" },
  custom: { icon: "⬚", labelKey: "business.kind_custom", tone: "custom" }
};
```

- [ ] **Step 4: 替换仓库行头部的裸类型徽章**

old:
```tsx
                  <span className="workflow-team-badge muted">{surface.kind}</span>
```
new:
```tsx
                  <span className={`workflow-team-badge business-kind-badge tone-${KIND_META[surface.kind].tone}`}>
                    {KIND_META[surface.kind].icon} {t(KIND_META[surface.kind].labelKey)}
                  </span>
```

- [ ] **Step 5: 替换端类型 `<select>` 的 options，使其显示汉化 + 图标**

old:
```tsx
                      {SURFACE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
```
new:
```tsx
                      {SURFACE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {KIND_META[kind].icon} {t(KIND_META[kind].labelKey)}
                        </option>
                      ))}
```

- [ ] **Step 6: 在 `styles.css` 中，紧接 `.business-workspace-template span { ... }` 规则块之后新增徽章分色**

```css
.business-kind-badge {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 600;
}
.business-kind-badge.tone-client { background: rgba(16, 185, 129, 0.14); color: #047857; }
.business-kind-badge.tone-shared { background: rgba(16, 185, 129, 0.14); color: #047857; }
.business-kind-badge.tone-server { background: rgba(59, 130, 246, 0.14); color: #1d4ed8; }
.business-kind-badge.tone-admin { background: rgba(245, 158, 11, 0.16); color: #b45309; }
.business-kind-badge.tone-docs { background: rgba(148, 163, 184, 0.18); color: #475569; }
.business-kind-badge.tone-test { background: rgba(139, 92, 246, 0.16); color: #6d28d9; }
.business-kind-badge.tone-custom { background: rgba(148, 163, 184, 0.18); color: #475569; }
```

- [ ] **Step 7: 运行测试 + 类型校验**

Run: `node --test tests/business-ui.test.mjs tests/i18n-strings.test.mjs && npm run typecheck`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add src/components/Settings/BusinessWorkspaceEditor.tsx styles.css tests/business-ui.test.mjs
git commit -m "feat(business): localize surface kinds with icons and tones"
```

---

## Task 3: 模板选中态 + 切换二次确认

**Files:**
- Modify: `src/components/Settings/BusinessWorkspaceEditor.tsx`（`matchTemplate`、`selectedTemplateId`、`applyTemplateWithConfirm`、模板卡 `is-selected`）
- Modify: `styles.css`（选中态、仓库数）
- Test: `tests/business-ui.test.mjs`

- [ ] **Step 1: 写失败测试 — 在 `tests/business-ui.test.mjs` 末尾追加**

```js
test("Business workspace editor tracks template selection with switch confirm", () => {
  const editor = read("../src/components/Settings/BusinessWorkspaceEditor.tsx");
  assert.match(editor, /matchTemplate/);
  assert.match(editor, /selectedTemplateId/);
  assert.match(editor, /applyTemplateWithConfirm/);
  assert.match(editor, /business\.switchTemplateConfirm/);
  assert.match(editor, /is-selected/);
  assert.match(editor, /business\.templateRepoCount/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test tests/business-ui.test.mjs`
Expected: FAIL — `matchTemplate` 未定义。

- [ ] **Step 3: 在 `BusinessWorkspaceEditor.tsx` 中，紧接 `joinLines` 定义之后新增 `matchTemplate`**

```ts
const joinLines = (value: string[]): string => value.join("\n");

function matchTemplate(surfaces: BusinessSurface[]): WorkspaceTemplateId | undefined {
  if (surfaces.length === 0) return undefined;
  const sig = (list: { kind: BusinessSurfaceKind }[]) => list.map((s) => s.kind).join(",");
  const sigs: Record<WorkspaceTemplateId, string> = {
    "client-server-admin": "client,server,admin",
    "client-server": "client,server",
    "single-repo": "custom",
    custom: ""
  };
  const current = sig(surfaces);
  return (Object.keys(sigs) as WorkspaceTemplateId[]).find((id) => sigs[id] === current);
}
```

- [ ] **Step 4: 在组件内（`const isNew = !workspace;` 之后）新增 `selectedTemplateId` 状态**

old:
```tsx
  const isNew = !workspace;
  const [draft, setDraft] = useState<BusinessWorkspace>(() =>
    workspace ? structuredClone(workspace) : emptyWorkspace()
  );
```
new:
```tsx
  const isNew = !workspace;
  const [draft, setDraft] = useState<BusinessWorkspace>(() =>
    workspace ? structuredClone(workspace) : emptyWorkspace()
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<WorkspaceTemplateId | undefined>(
    () => (workspace ? matchTemplate(workspace.surfaces) : undefined)
  );
```

- [ ] **Step 5: 在 `applyTemplate` 之后新增 `applyTemplateWithConfirm`**

```tsx
  const applyTemplateWithConfirm = (template: WorkspaceTemplate) => {
    if (template.id !== selectedTemplateId && draft.surfaces.length > 0) {
      if (!window.confirm(t("business.switchTemplateConfirm"))) return;
    }
    applyTemplate(template);
    setSelectedTemplateId(template.id);
  };
```

- [ ] **Step 6: 替换模板卡渲染，绑定选中态、仓库数、新 handler**

old:
```tsx
            {WORKSPACE_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className="business-workspace-template"
                onClick={() => applyTemplate(template)}
              >
                <strong>{t(template.titleKey)}</strong>
                <span>{t(template.descKey)}</span>
              </button>
            ))}
```
new:
```tsx
            {WORKSPACE_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className={`business-workspace-template${selectedTemplateId === template.id ? " is-selected" : ""}`}
                onClick={() => applyTemplateWithConfirm(template)}
              >
                <strong>{t(template.titleKey)}</strong>
                <span>{t(template.descKey)}</span>
                <span className="business-workspace-template-count">
                  {t("business.templateRepoCount", { count: template.surfaces.length })}
                </span>
              </button>
            ))}
```

- [ ] **Step 7: 在 `styles.css` 中，紧接 `.business-workspace-template:hover { ... }` 之后新增**

```css
.business-workspace-template.is-selected {
  border-color: var(--fb-brand);
  background: rgba(16, 185, 129, 0.07);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.12);
}
.business-workspace-template-count {
  color: var(--fb-muted);
  font-size: 11px;
  margin-top: 2px;
}
```

- [ ] **Step 8: 运行测试 + 类型校验**

Run: `node --test tests/business-ui.test.mjs tests/i18n-strings.test.mjs && npm run typecheck`
Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add src/components/Settings/BusinessWorkspaceEditor.tsx styles.css tests/business-ui.test.mjs
git commit -m "feat(business): template selection state with switch confirm"
```

---

## Task 4: 名称内联校验 + 保存失败可读文案

**Files:**
- Modify: `src/components/Settings/BusinessWorkspaceEditor.tsx`（`nameError` 状态、`handleSave`、name 输入）
- Modify: `styles.css`（必填星标、字段错误态）
- Test: `tests/business-ui.test.mjs`

- [ ] **Step 1: 写失败测试 — 在 `tests/business-ui.test.mjs` 末尾追加**

```js
test("Business workspace editor validates name inline and shows readable save error", () => {
  const editor = read("../src/components/Settings/BusinessWorkspaceEditor.tsx");
  assert.match(editor, /nameError/);
  assert.match(editor, /business\.nameRequired/);
  assert.match(editor, /business\.saveFailed/);
  // old patterns must be gone
  assert.doesNotMatch(editor, /setErrors\(\[t\("business\.workspaceName"\)\]\)/);
  assert.doesNotMatch(editor, /setErrors\(\["save failed"\]\)/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test tests/business-ui.test.mjs`
Expected: FAIL — `nameError` 未定义。

- [ ] **Step 3: 在组件内 `errors` 状态之后新增 `nameError` 状态**

old:
```tsx
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    setDraft(workspace ? structuredClone(workspace) : emptyWorkspace());
    setErrors([]);
  }, [workspace]);
```
new:
```tsx
  const [errors, setErrors] = useState<string[]>([]);
  const [nameError, setNameError] = useState(false);

  useEffect(() => {
    setDraft(workspace ? structuredClone(workspace) : emptyWorkspace());
    setErrors([]);
    setNameError(false);
  }, [workspace]);
```

- [ ] **Step 4: 改 `handleSave` 的校验与失败分支**

old:
```tsx
  const handleSave = async () => {
    setErrors([]);
    if (!draft.name.trim()) {
      setErrors([t("business.workspaceName")]);
      return;
    }
```
new:
```tsx
  const handleSave = async () => {
    setErrors([]);
    if (!draft.name.trim()) {
      setNameError(true);
      return;
    }
```
并把失败分支：
old:
```tsx
    if (!ok) {
      setErrors(["save failed"]);
      return;
    }
```
new:
```tsx
    if (!ok) {
      setErrors([t("business.saveFailed")]);
      return;
    }
```

- [ ] **Step 5: 替换名称字段，加入必填星标、错误态、错误文案，并在输入时清错**

old:
```tsx
        <label className="workflow-team-editor-field">
          <span>{t("business.workspaceName")}</span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={t("business.workspaceName")}
          />
        </label>
```
new:
```tsx
        <label className="workflow-team-editor-field">
          <span>
            {t("business.workspaceName")} <span className="business-required">*</span>
          </span>
          <input
            type="text"
            value={draft.name}
            className={nameError ? "business-input-error" : undefined}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
              setNameError(false);
            }}
            placeholder={t("business.workspaceName")}
          />
          {nameError && (
            <span className="business-field-error">{t("business.nameRequired")}</span>
          )}
        </label>
```

- [ ] **Step 6: 在 `styles.css` 中，紧接 `.business-kind-badge.tone-custom { ... }` 之后新增**

```css
.business-required { color: var(--fb-danger, #e11d48); margin-left: 2px; }
.business-input-error { border-color: var(--fb-danger, #e11d48) !important; }
.business-field-error { display: block; color: var(--fb-danger, #e11d48); font-size: 12px; margin-top: 4px; }
```

- [ ] **Step 7: 运行测试 + 类型校验**

Run: `node --test tests/business-ui.test.mjs tests/i18n-strings.test.mjs && npm run typecheck`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add src/components/Settings/BusinessWorkspaceEditor.tsx styles.css tests/business-ui.test.mjs
git commit -m "feat(business): inline name validation and readable save error"
```

---

## Task 5: 目录按钮文案 + 主按钮随新建/编辑切换

**Files:**
- Modify: `src/components/Settings/BusinessWorkspaceEditor.tsx`
- Test: `tests/business-ui.test.mjs`

- [ ] **Step 1: 写失败测试 — 在 `tests/business-ui.test.mjs` 末尾追加**

```js
test("Business workspace editor uses clear directory button and context-aware primary action", () => {
  const editor = read("../src/components/Settings/BusinessWorkspaceEditor.tsx");
  assert.match(editor, /business\.chooseDirectory/);
  assert.match(editor, /business\.createWorkspace/);
  // the bare ellipsis directory button must be gone
  assert.doesNotMatch(editor, />\s*\.\.\.\s*<\/button>/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test tests/business-ui.test.mjs`
Expected: FAIL — `business.chooseDirectory` 未使用。

- [ ] **Step 3: 替换目录选择按钮文案**

old:
```tsx
                      <button
                        type="button"
                        onClick={() => void pickRepoPath(index)}
                      >
                        …
                      </button>
```
new:
```tsx
                      <button
                        type="button"
                        onClick={() => void pickRepoPath(index)}
                      >
                        {t("business.chooseDirectory")}
                      </button>
```

- [ ] **Step 4: 替换头部主按钮文案（随新建/编辑切换）**

old:
```tsx
          <button type="button" className="primary" onClick={() => void handleSave()}>
            {t("common.save")}
          </button>
```
new:
```tsx
          <button type="button" className="primary" onClick={() => void handleSave()}>
            {isNew ? t("business.createWorkspace") : t("common.save")}
          </button>
```

- [ ] **Step 5: 运行测试 + 类型校验**

Run: `node --test tests/business-ui.test.mjs tests/i18n-strings.test.mjs && npm run typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/components/Settings/BusinessWorkspaceEditor.tsx tests/business-ui.test.mjs
git commit -m "feat(business): clear directory button and context-aware primary action"
```

---

## Task 6: 模板 hero 前置（重排 JSX）

**Files:**
- Modify: `src/components/Settings/BusinessWorkspaceEditor.tsx`
- Test: `tests/business-ui.test.mjs`

- [ ] **Step 1: 写失败测试 — 在 `tests/business-ui.test.mjs` 末尾追加**

```js
test("Business workspace editor leads with template hero before basics", () => {
  const editor = read("../src/components/Settings/BusinessWorkspaceEditor.tsx");
  const heroIdx = editor.indexOf("business-template-hero");
  const nameIdx = editor.indexOf('t("business.workspaceName")');
  assert.ok(heroIdx > -1, "template hero section marker missing");
  assert.ok(heroIdx < nameIdx, "template hero must appear before the name field");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test tests/business-ui.test.mjs`
Expected: FAIL — `business-template-hero` 未找到。

- [ ] **Step 3: 把原「先说明这个业务」section 拆为两段，模板在前、基础在后**

old（一整段 setupBusiness section）:
```tsx
      <section className="workflow-team-editor-section">
        <h5>{t("business.setupBusiness")}</h5>
        <label className="workflow-team-editor-field">
          <span>{t("business.workspaceName")} <span className="business-required">*</span></span>
          <input
            type="text"
            value={draft.name}
            className={nameError ? "business-input-error" : undefined}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
              setNameError(false);
            }}
            placeholder={t("business.workspaceName")}
          />
          {nameError && (
            <span className="business-field-error">{t("business.nameRequired")}</span>
          )}
        </label>
        <label className="workflow-team-editor-field">
          <span>{t("workflow.teamDescription")}</span>
          <textarea
            value={draft.description ?? ""}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            rows={2}
          />
        </label>
        <div className="business-workspace-template-picker">
          <span className="muted small">{t("business.structureTemplate")}</span>
          <div className="business-workspace-template-grid">
            {WORKSPACE_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className={`business-workspace-template${selectedTemplateId === template.id ? " is-selected" : ""}`}
                onClick={() => applyTemplateWithConfirm(template)}
              >
                <strong>{t(template.titleKey)}</strong>
                <span>{t(template.descKey)}</span>
                <span className="business-workspace-template-count">
                  {t("business.templateRepoCount", { count: template.surfaces.length })}
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
```
new（模板 hero 在前，基础在后）:
```tsx
      <section className="workflow-team-editor-section business-template-hero">
        <h5>{t("business.structureTemplate")}</h5>
        <div className="business-workspace-template-grid">
          {WORKSPACE_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className={`business-workspace-template${selectedTemplateId === template.id ? " is-selected" : ""}`}
              onClick={() => applyTemplateWithConfirm(template)}
            >
              <strong>{t(template.titleKey)}</strong>
              <span>{t(template.descKey)}</span>
              <span className="business-workspace-template-count">
                {t("business.templateRepoCount", { count: template.surfaces.length })}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="workflow-team-editor-section">
        <h5>{t("business.setupBusiness")}</h5>
        <label className="workflow-team-editor-field">
          <span>{t("business.workspaceName")} <span className="business-required">*</span></span>
          <input
            type="text"
            value={draft.name}
            className={nameError ? "business-input-error" : undefined}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
              setNameError(false);
            }}
            placeholder={t("business.workspaceName")}
          />
          {nameError && (
            <span className="business-field-error">{t("business.nameRequired")}</span>
          )}
        </label>
        <label className="workflow-team-editor-field">
          <span>{t("workflow.teamDescription")}</span>
          <textarea
            value={draft.description ?? ""}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            rows={2}
          />
        </label>
      </section>
```

> Note: `business-workspace-template-picker` 包装层随之移除；`styles.css` 中 `.business-workspace-template-picker` 规则可保留无害，无需改动。

- [ ] **Step 4: 运行测试 + 类型校验**

Run: `node --test tests/business-ui.test.mjs tests/i18n-strings.test.mjs && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/Settings/BusinessWorkspaceEditor.tsx tests/business-ui.test.mjs
git commit -m "feat(business): lead with template hero before basics"
```

---

## Task 7: 协作与提交策略合并折叠 + 项数徽标

**Files:**
- Modify: `src/components/Settings/BusinessWorkspaceEditor.tsx`（合并 collaboration section 与 advancedSettings details）
- Modify: `styles.css`（项数徽标）
- Test: `tests/business-ui.test.mjs`（更新既有断言）

- [ ] **Step 1: 更新既有「guided setup model」测试 + 新增折叠断言**

把 `tests/business-ui.test.mjs` 中现有的：
```js
  assert.match(editor, /business\.collaboration/);
  assert.match(editor, /business\.advancedSettings/);
```
替换为：
```js
  assert.match(editor, /business\.collaboration/);
  assert.match(editor, /business\.collaborationAndPolicy/);
  assert.match(editor, /business\.advancedCountHint/);
  assert.doesNotMatch(editor, /business\.advancedSettings/);
```
并在文件末尾追加：
```js
test("Business workspace editor folds collaboration and policy into one region", () => {
  const editor = read("../src/components/Settings/BusinessWorkspaceEditor.tsx");
  assert.match(editor, /business-workspace-collab-policy/);
  assert.match(editor, /business-advanced-count/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test tests/business-ui.test.mjs`
Expected: FAIL — `business.collaborationAndPolicy` 未使用；`business-workspace-collab-policy` 未找到。

- [ ] **Step 3: 把「协作」section 与「高级设置」details 合并为单个折叠区**

定位当前的协作 section（`{draft.surfaces.length > 0 && (` 起）到高级设置 details 结束的整块，替换为：
```tsx
      {(draft.surfaces.length > 0 || isNew) && (
        <details className="workflow-team-editor-section business-workspace-advanced business-workspace-collab-policy">
          <summary>
            {t("business.collaborationAndPolicy")}
            <span className="business-advanced-count">
              {t("business.advancedCountHint", {
                count: draft.surfaces.filter((s) => s.enabled).length + 3
              })}
            </span>
          </summary>
          {draft.surfaces.length > 0 && (
            <>
              <h5>{t("business.collaboration")}</h5>
              <p className="muted small">{t("business.collaborationHint")}</p>
              <div className="business-collaboration-list">
                {draft.surfaces.map((surface, index) => (
                  <label key={surface.id || index} className="workflow-team-editor-field">
                    <span>{surface.name || surface.id}</span>
                    <select
                      value={surface.contractRole}
                      onChange={(e) =>
                        setSurface(index, {
                          contractRole: e.target.value as ContractRole
                        })
                      }
                    >
                      {CONTRACT_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t(`business.contractRole_${role}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </>
          )}
          <div className="business-policy-grid">
            <label className="workflow-team-editor-toggle">
              <input
                type="checkbox"
                checked={draft.policy.requireCleanRepoBeforeRun}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    policy: {
                      ...draft.policy,
                      requireCleanRepoBeforeRun: e.target.checked
                    }
                  })
                }
              />
              <span>{t("business.requireCleanRepoBeforeRun")}</span>
            </label>
            <label className="workflow-team-editor-toggle">
              <input
                type="checkbox"
                checked={draft.policy.blockCommitOnVerificationFailure}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    policy: {
                      ...draft.policy,
                      blockCommitOnVerificationFailure: e.target.checked
                    }
                  })
                }
              />
              <span>{t("business.blockCommitOnVerificationFailure")}</span>
            </label>
            <label className="workflow-team-editor-field">
              <span>{t("business.branchNameTemplate")}</span>
              <input
                type="text"
                value={draft.policy.branchNameTemplate}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    policy: {
                      ...draft.policy,
                      branchNameTemplate: e.target.value
                    }
                  })
                }
              />
            </label>
          </div>
        </details>
      )}
```

> Note: Step 1 断言要求源码中不再出现 `business.advancedSettings`，因此折叠区内 **不**保留原 policy 小标题（policy 字段自带文案，无需小标题）。`business.collaboration` 作为协作小标题保留（既有断言仍要求其存在）。原独立的「协作」section 与「高级设置」details 均被本块整体替换；上面代码块即为最终内容，无需再删除任何行。

- [ ] **Step 4: 在 `styles.css` 中，紧接 `.business-advanced-count` 之前 / `.business-workspace-advanced summary` 规则之后新增**

```css
.business-advanced-count {
  margin-left: 8px;
  background: var(--fb-border, rgba(148, 163, 184, 0.3));
  color: var(--fb-secondary, #475569);
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
}
```

- [ ] **Step 5: 运行测试 + 类型校验**

Run: `node --test tests/business-ui.test.mjs tests/i18n-strings.test.mjs && npm run typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/components/Settings/BusinessWorkspaceEditor.tsx styles.css tests/business-ui.test.mjs
git commit -m "feat(business): fold collaboration and policy into one region with count"
```

---

## Task 8: 全量验证

**Files:** 无（仅验证）

- [ ] **Step 1: 运行完整测试套件**

Run: `npm run build:electron && node --test tests/*.mjs`
Expected: 全部 PASS（含 business-ui、i18n-strings、business-workspaces 等）。

- [ ] **Step 2: 类型校验**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 3: 手动冒烟（可选，由用户在 app 内确认）**

打开 设置 → 业务空间 → 新建业务空间，核对验收标准 1–7：模板 hero 在首屏且选中态生效；切模板在有仓库时弹确认；名称留空点创建 → 红框 + 「请填写名称」；端类型徽章/下拉为中文+图标；目录按钮为「选择目录」；主按钮「创建业务空间」；协作与策略默认折叠且带项数徽标。

---

## Self-Review 记录

- **Spec coverage：** 模板 hero 前置+选中态+切换确认（T2/T3/T6）、名称内联校验+保存失败文案（T4）、端类型汉化+图标（T2）、目录按钮文案（T5）、协作与策略合并折叠+项数（T7）、样式（各任务内）、i18n key 对齐（T1）、验收标准 1–8（T8 对应）。全部覆盖。
- **Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整代码。
- **Type 一致性：** `KIND_META`、`matchTemplate`、`selectedTemplateId`、`nameError`、`applyTemplateWithConfirm` 定义与使用处命名一致；`WorkspaceTemplateId` / `BusinessSurfaceKind` / `BusinessSurface` 类型沿用既有定义。
- **已知取舍：** 测试为静态串匹配（本项目惯例），行为校验（确认弹窗、校验门控）以源码串存在性 + 手动冒烟兜底；`matchTemplate` 用端类型序列签名做尽力匹配，符合 spec「尽力匹配」。
