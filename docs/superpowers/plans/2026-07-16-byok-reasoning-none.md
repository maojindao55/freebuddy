# BYOK Reasoning None Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Codex BYOK models opt into thinking per model, with a `none` level when enabled, fixing issue #59.

**Architecture:** Extract pure BYOK reasoning helpers used by `createCodexByokModelCatalog`. Settings persist `supportsReasoning` / levels / default on each model. Chat picker stays ACP-passthrough; only add `none` label fallback.

**Tech Stack:** TypeScript, Electron store, React Settings UI, Node test runner + ts.transpileModule.

**Spec:** `docs/superpowers/specs/2026-07-16-byok-reasoning-none-design.zh-CN.md`

## Global Constraints

- Scope: Codex BYOK only; Claude BYOK unchanged.
- Old configs default `supportsReasoning: false`.
- When enabled, default levels `none,low,medium,high`; default level `none`.
- Do not forge thought_level options in SessionConfigPicker.
- Settings UI first-wave levels: `none|low|medium|high` only.

## File map

| File | Responsibility |
|------|----------------|
| `electron/cli/byokReasoning.ts` | Pure normalize + catalog entry builders |
| `electron/cli/store.ts` | Types + use helpers in catalog generation |
| `src/services/cli/types.ts` | Mirror `CLIByokModel` fields |
| `src/components/Settings/CLIAdaptersTab.tsx` | Per-model thinking controls |
| `src/utils/sessionConfigOptions.ts` | Optional `none` display label helper |
| `src/components/CLI/SessionConfigPicker.tsx` | Use none label when name missing |
| `src/locales/en.json` + `zh-CN.json` | Strings |
| `tests/byok-reasoning.test.mjs` | Unit tests |
| `tests/settings-ui.test.mjs` | Settings key presence |

---

### Task 1: Pure helpers + store catalog wiring

**Files:**
- Create: `electron/cli/byokReasoning.ts`
- Modify: `electron/cli/store.ts`
- Modify: `src/services/cli/types.ts`
- Test: `tests/byok-reasoning.test.mjs`

- [x] **Step 1: Write failing tests** for normalize + catalog entry build
- [x] **Step 2: Implement `byokReasoning.ts` and wire store**
- [x] **Step 3: Tests pass**

### Task 2: Settings UI + i18n

**Files:**
- Modify: `src/components/Settings/CLIAdaptersTab.tsx`
- Modify: locales + `tests/settings-ui.test.mjs`

- [x] **Step 1: Add locale keys + settings-ui assertions**
- [x] **Step 2: Per-model checkbox / levels / default**
- [x] **Step 3: Tests pass**

### Task 3: Chat `none` label

**Files:**
- Modify: `src/utils/sessionConfigOptions.ts` + picker + locales + test

- [x] **Step 1: Label fallback for value `none`**
- [x] **Step 2: Tests pass**

### Task 4: Verify

- [x] Run `node --test tests/byok-reasoning.test.mjs tests/settings-ui.test.mjs tests/session-config-options.test.mjs`
