# Main Chat Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sticky model / model_config / thought_level picker beside the main chat composer, applied via ACP `session/set_config_option` before each prompt.

**Architecture:** Persist per-conversation `configOptionOverrides` in SQLite. UI reads ACP `config-options` stream metadata (stable `configOptions` only). On send, `CliRunArgs` carries overrides; `acpRuntime` applies them after session setup and before `session/prompt`. Cold start hides the picker until options exist.

**Tech Stack:** Electron IPC, React, Zustand, TypeScript, better-sqlite3, Node test runner, ACP JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-07-09-main-chat-model-picker-design.zh-CN.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `src/utils/sessionConfigOptions.ts` | Filter picker options; merge display values with overrides; prune invalid keys |
| `electron/cli/acp.ts` | `buildSessionSetConfigOptionRequest` |
| `electron/cli/acpRuntime.ts` | Apply overrides before prompt |
| `electron/cli/runtimeShared.ts` + `src/services/cli/types.ts` | `configOptionOverrides` on `CliRunArgs` / `Conversation` |
| `electron/cli/db.ts` + `conversations.ts` | Column + CRUD |
| `electron/cli/ipc.ts` + `preload.ts` + `client.ts` + `freebuddy.d.ts` | IPC surface |
| `src/store/conversationStore.ts` | Sticky setter + pass overrides on send |
| `src/components/CLI/SessionConfigPicker.tsx` | Composer UI |
| `src/components/CLI/ChatView.tsx` | Mount picker |
| `src/locales/en.json` + `zh-CN.json` | Strings |
| `tests/session-config-options.test.mjs` + `tests/acp.test.mjs` | Unit tests |

---

### Task 1: Session config option helpers

**Files:**
- Create: `src/utils/sessionConfigOptions.ts`
- Test: `tests/session-config-options.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/session-config-options.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadModule() {
  const source = fs.readFileSync(
    new URL("../src/utils/sessionConfigOptions.ts", import.meta.url),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
}

const sample = [
  {
    id: "mode",
    category: "mode",
    currentValue: "ask",
    values: [{ id: "ask", name: "Ask" }]
  },
  {
    id: "model",
    category: "model",
    currentValue: "m1",
    currentLabel: "Model 1",
    values: [
      { id: "m1", name: "Model 1" },
      { id: "m2", name: "Model 2" }
    ]
  },
  {
    id: "effort",
    category: "model_config",
    currentValue: "low",
    values: [
      { id: "low", name: "Low" },
      { id: "high", name: "High" }
    ]
  },
  {
    id: "think",
    category: "thought_level",
    currentValue: "medium",
    values: [{ id: "medium", name: "Medium" }]
  },
  {
    id: "model",
    currentValue: "legacy-id-only",
    values: [{ id: "legacy-id-only", name: "Legacy" }]
  }
];

test("filters picker categories and id===model fallback", async () => {
  const { filterSessionConfigPickerOptions } = await loadModule();
  const filtered = filterSessionConfigPickerOptions(sample);
  assert.deepEqual(
    filtered.map((o) => `${o.id}:${o.category ?? ""}`),
    ["model:model", "effort:model_config", "think:thought_level", "model:"]
  );
});

test("display value prefers override", async () => {
  const { displayConfigOptionValue } = await loadModule();
  const model = sample[1];
  assert.equal(displayConfigOptionValue(model, {}), "m1");
  assert.equal(displayConfigOptionValue(model, { model: "m2" }), "m2");
});

test("prunes overrides to available option ids", async () => {
  const { pruneConfigOptionOverrides } = await loadModule();
  const pruned = pruneConfigOptionOverrides(
    { model: "m2", gone: "x", effort: "high" },
    sample
  );
  assert.deepEqual(pruned, { model: "m2", effort: "high" });
});

test("clears overrides that match current agent values", async () => {
  const { reconcileConfigOptionOverrides } = await loadModule();
  assert.deepEqual(
    reconcileConfigOptionOverrides({ model: "m1", effort: "high" }, sample),
    { effort: "high" }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/session-config-options.test.mjs`

Expected: FAIL (module missing)

- [ ] **Step 3: Implement helpers**

Create `src/utils/sessionConfigOptions.ts`:

```ts
export type SessionConfigOptionLike = {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  currentLabel?: string;
  description?: string;
  values?: { id: string; name?: string }[];
};

const PICKER_CATEGORIES = new Set(["model", "model_config", "thought_level"]);

export function isSessionConfigPickerOption(
  option: SessionConfigOptionLike
): boolean {
  if (option.category && PICKER_CATEGORIES.has(option.category)) return true;
  return option.id === "model";
}

export function filterSessionConfigPickerOptions(
  options: SessionConfigOptionLike[]
): SessionConfigOptionLike[] {
  return options.filter(isSessionConfigPickerOption);
}

export function displayConfigOptionValue(
  option: SessionConfigOptionLike,
  overrides: Record<string, string> | undefined
): string | undefined {
  const override = overrides?.[option.id];
  if (override != null && override !== "") return override;
  return option.currentValue;
}

export function displayConfigOptionLabel(
  option: SessionConfigOptionLike,
  overrides: Record<string, string> | undefined
): string | undefined {
  const value = displayConfigOptionValue(option, overrides);
  if (!value) return option.currentLabel ?? option.name;
  const match = option.values?.find((v) => v.id === value);
  return match?.name ?? (value === option.currentValue ? option.currentLabel : undefined) ?? value;
}

export function pruneConfigOptionOverrides(
  overrides: Record<string, string> | undefined,
  options: SessionConfigOptionLike[]
): Record<string, string> {
  if (!overrides) return {};
  const allowed = new Set(options.map((o) => o.id));
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(overrides)) {
    if (allowed.has(id) && value != null && value !== "") out[id] = value;
  }
  return out;
}

export function reconcileConfigOptionOverrides(
  overrides: Record<string, string> | undefined,
  options: SessionConfigOptionLike[]
): Record<string, string> {
  if (!overrides) return {};
  const currentById = new Map(
    options.map((o) => [o.id, o.currentValue] as const)
  );
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(overrides)) {
    if (value == null || value === "") continue;
    if (currentById.get(id) === value) continue;
    out[id] = value;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/session-config-options.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/sessionConfigOptions.ts tests/session-config-options.test.mjs
git commit -m "feat: add session config option helpers for model picker"
```

---

### Task 2: ACP `session/set_config_option` request builder

**Files:**
- Modify: `electron/cli/acp.ts`
- Test: `tests/acp.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `tests/acp.test.mjs` (import `buildSessionSetConfigOptionRequest` from the existing acp import list):

```js
test("buildSessionSetConfigOptionRequest shapes stable ACP params", () => {
  assert.deepEqual(buildSessionSetConfigOptionRequest(7, "sess-1", "model", "m2"), {
    jsonrpc: "2.0",
    id: 7,
    method: "session/set_config_option",
    params: {
      sessionId: "sess-1",
      configId: "model",
      value: "m2"
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:electron && node --test tests/acp.test.mjs --test-name-pattern "buildSessionSetConfigOptionRequest"`

Expected: FAIL (export missing)

- [ ] **Step 3: Implement builder**

In `electron/cli/acp.ts`, next to other `buildSession*` helpers:

```ts
export function buildSessionSetConfigOptionRequest(
  id: AcpRequestId,
  sessionId: string,
  configId: string,
  value: string
): AcpMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/set_config_option",
    params: {
      sessionId,
      configId,
      value
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:electron && node --test tests/acp.test.mjs --test-name-pattern "buildSessionSetConfigOptionRequest"`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/cli/acp.ts tests/acp.test.mjs
git commit -m "feat: add ACP session/set_config_option request builder"
```

---

### Task 3: Persist conversation config overrides

**Files:**
- Modify: `electron/cli/db.ts`
- Modify: `electron/cli/conversations.ts`
- Modify: `electron/cli/runtimeShared.ts`
- Modify: `src/services/cli/types.ts`
- Modify: `electron/cli/ipc.ts`
- Modify: `electron/preload.ts`
- Modify: `src/services/cli/client.ts`
- Modify: `src/types/freebuddy.d.ts`

- [ ] **Step 1: Add DB column migration**

In `electron/cli/db.ts` `migrate()`, after the `approval_mode` conversation column check:

```ts
if (!conversationCols.some((c) => c.name === "config_option_overrides")) {
  db.exec("ALTER TABLE conversations ADD COLUMN config_option_overrides TEXT");
}
```

Also add `config_option_overrides TEXT` to the `CREATE TABLE IF NOT EXISTS conversations` definition for fresh DBs.

- [ ] **Step 2: Wire conversations CRUD**

In `electron/cli/conversations.ts`:

1. Add `configOptionOverrides?: Record<string, string>` to `Conversation`.
2. In `rowToConversation`, parse JSON from `r.config_option_overrides` into an object of string→string (invalid JSON → undefined).
3. Add:

```ts
export function setConversationConfigOptionOverrides(
  id: string,
  overrides: Record<string, string> | null
): void {
  const now = new Date().toISOString();
  const value =
    overrides && Object.keys(overrides).length > 0
      ? JSON.stringify(overrides)
      : null;
  getDb()
    .prepare(
      `UPDATE conversations SET config_option_overrides = ?, updated_at = ? WHERE id = ?`
    )
    .run(value, now, id);
}
```

- [ ] **Step 3: Types + IPC + client**

1. Add `configOptionOverrides?: Record<string, string>` to:
   - `electron/cli/runtimeShared.ts` `CliRunArgs`
   - `src/services/cli/types.ts` `CliRunArgs` and `Conversation`
2. IPC handler `cli:setConversationConfigOptionOverrides` calling the new setter and returning `getConversation(id)`.
3. preload + `cliClient` + `freebuddy.d.ts` mirror `setConversationApprovalMode` pattern:

```ts
setConversationConfigOptionOverrides(
  id: string,
  overrides: Record<string, string> | null
): Promise<Conversation | void>
```

Prefer returning the updated conversation from IPC so the store can sync, or return void and patch locally like approval mode.

- [ ] **Step 4: Typecheck electron**

Run: `npm run build:electron`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/cli/db.ts electron/cli/conversations.ts electron/cli/runtimeShared.ts \
  electron/cli/ipc.ts electron/preload.ts src/services/cli/types.ts \
  src/services/cli/client.ts src/types/freebuddy.d.ts
git commit -m "feat: persist conversation config option overrides"
```

---

### Task 4: Apply overrides in ACP runtime before prompt

**Files:**
- Modify: `electron/cli/acpRuntime.ts`
- Modify: `electron/cli/acp.ts` (reuse `normalizeConfigOptions` / emit items — export a small helper if needed)

- [ ] **Step 1: Apply overrides after establishSession**

In `acpRuntime.ts`, import `buildSessionSetConfigOptionRequest` and `acpSessionSetupToItems` (already imported) / or emit config-options from set_config_option result.

Between successful `establishSession` and `runPromptOnSession()`:

```ts
const applyConfigOptionOverrides = async () => {
  const overrides = args.configOptionOverrides;
  if (!overrides || !activeAcpSessionId) return;
  for (const [configId, value] of Object.entries(overrides)) {
    if (!configId || value == null || value === "") continue;
    try {
      const result = await request(
        buildSessionSetConfigOptionRequest(
          nextId(),
          activeAcpSessionId,
          configId,
          value
        )
      );
      const items = acpSessionSetupToItems(activeAcpSessionId, {
        sessionId: activeAcpSessionId,
        ...(result && typeof result === "object" ? result : {})
      }).filter((item) => item.kind === "config-options");
      if (items.length) emit({ type: "items", items });
    } catch (err) {
      appendLog(
        logStream,
        "system",
        `set_config_option failed id=${configId}: ${(err as Error)?.message || String(err)}`
      );
      emit({
        type: "stderr",
        content: `Failed to set config option ${configId}: ${(err as Error)?.message || String(err)}`
      });
      // do not block prompt
    }
  }
};

await applyConfigOptionOverrides();
await runPromptOnSession();
```

Note: prune invalid keys in the renderer before send (Task 5). Runtime may still receive stale keys; failures are non-fatal.

- [ ] **Step 2: Build electron**

Run: `npm run build:electron`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add electron/cli/acpRuntime.ts
git commit -m "feat: apply config option overrides before ACP prompt"
```

---

### Task 5: Store wiring on send + sticky setter

**Files:**
- Modify: `src/store/conversationStore.ts`

- [ ] **Step 1: Add store action**

```ts
setConversationConfigOptionOverrides(
  id: string,
  overrides: Record<string, string>
): Promise<void>;
```

Implementation mirrors `setConversationApprovalMode`: call `cliClient.setConversationConfigOptionOverrides`, then patch `conversations` in state.

- [ ] **Step 2: Pass overrides in sendMessage**

When building `CliRunArgs`, after resolving messages/live config options:

```ts
import {
  pruneConfigOptionOverrides,
  filterSessionConfigPickerOptions
} from "@/utils/sessionConfigOptions";
import { mergeSessionMetaItems } from "./sessionMetaUtils";

// inside sendMessage, before cliClient.run:
const messageItems = /* parse assistant contents or use existing helpers */;
const { configOptions } = mergeSessionMetaItems(
  /* latest message items */,
  get().live[conversationId]?.items
);
const pickerOptions = filterSessionConfigPickerOptions(configOptions);
const configOptionOverrides = pruneConfigOptionOverrides(
  conv.configOptionOverrides,
  pickerOptions.length ? pickerOptions : configOptions
);

// include in run args when non-empty:
...(Object.keys(configOptionOverrides).length
  ? { configOptionOverrides }
  : {})
```

If there are no known options yet (first turn), still pass raw `conv.configOptionOverrides` only if non-empty — runtime will best-effort apply; failures non-fatal. Prefer: if no options known, still pass overrides as stored (user may have set them after a previous turn that had options).

Also optionally reconcile after stream updates when config-options arrive matching overrides (can be a follow-up in ChatView/store listener; YAGNI for v1 if sticky display already prefers overrides).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`

Expected: PASS (or only pre-existing errors)

- [ ] **Step 4: Commit**

```bash
git add src/store/conversationStore.ts
git commit -m "feat: wire sticky config overrides into sendMessage"
```

---

### Task 6: Composer SessionConfigPicker UI

**Files:**
- Create: `src/components/CLI/SessionConfigPicker.tsx`
- Modify: `src/components/CLI/ChatView.tsx`
- Modify: `src/locales/en.json`
- Modify: `src/locales/zh-CN.json`
- Modify CSS if composer styles live in a global stylesheet (search `composer-permission`)

- [ ] **Step 1: Add i18n keys**

In both locale files under `chat`:

```json
"model": "Model",
"modelPicker": "Model",
"modelPickerHint": "Model and related options for this conversation",
"modelConfig": "Model config",
"thoughtLevel": "Thinking"
```

zh-CN:

```json
"model": "模型",
"modelPicker": "模型",
"modelPickerHint": "本会话的模型及相关选项",
"modelConfig": "模型参数",
"thoughtLevel": "思考强度"
```

- [ ] **Step 2: Implement SessionConfigPicker**

Create a compact control next to permission select:

- Props: `options`, `overrides`, `disabled`, `onChange(configId, value)`
- Hide when `filterSessionConfigPickerOptions(options).length === 0`
- Show primary chip/label from model option display label
- Popover/panel lists each filtered option as a `<select>` (or nested selects), ordered as given
- On change: compute next overrides map (set key; if value equals `option.currentValue`, delete key) and call `onChange` / parent persists full map

- [ ] **Step 3: Mount in ChatView**

In `chat-composer-actions` / `composer-tools`, after permission label:

```tsx
<SessionConfigPicker
  options={sessionConfigOptions}
  overrides={conv?.configOptionOverrides}
  disabled={sending}
  onChange={(next) => {
    if (conv?.id) void setConfigOptionOverrides(conv.id, next);
  }}
/>
```

Derive `sessionConfigOptions` via `mergeSessionMetaItems` from messages + live items (same pattern as WorkspacePanel / slash commands if present).

- [ ] **Step 4: Manual sanity / typecheck**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/CLI/SessionConfigPicker.tsx src/components/CLI/ChatView.tsx \
  src/locales/en.json src/locales/zh-CN.json src/**/*.css
git commit -m "feat: add main chat session config picker UI"
```

---

### Task 7: Verification

- [ ] **Step 1: Run unit tests**

Run: `npm test`

Expected: all tests PASS (including new ones)

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS

- [ ] **Step 3: Final commit if any fixups**

Only if fixes were needed.

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Sticky per-conversation overrides | 3, 5, 6 |
| ACP configOptions list only (no legacy models path) | 1, 6 |
| Cold start hide picker | 6 |
| `session/set_config_option` before prompt | 2, 4 |
| model + model_config + thought_level | 1, 6 |
| Non-fatal set failures | 4 |
| Persist across restart | 3 |
| Tests for builder / filter / prune | 1, 2, 7 |
