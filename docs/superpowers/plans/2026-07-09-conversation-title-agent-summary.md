# Conversation Title Agent Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefer ACP `session.title` for conversation titles after the first turn, using a `titleSource` state machine so prompt-truncated titles can be upgraded once and then lock.

**Architecture:** Persist `title_source` on conversations. First send marks `prompt`. ACP session title may upgrade `default|prompt` → `agent` once. Manual rename marks `user`. Legacy rows without the column infer `default` vs `prompt` from the current title.

**Tech Stack:** TypeScript, Zustand, better-sqlite3, Electron IPC, Node test runner.

**Spec:** `docs/superpowers/specs/2026-07-09-conversation-title-agent-summary-design.zh-CN.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `src/store/conversationUtils.ts` | `ConversationTitleSource`, infer source, rewrite `shouldApplyAgentSessionTitle` |
| `electron/cli/db.ts` | `title_source` column + migration |
| `electron/cli/conversations.ts` | Read/write source; rename accepts source |
| `src/services/cli/types.ts` + IPC/client/preload/d.ts | Types + API surface |
| `src/store/conversationHandlers.ts` | Apply agent title + set `titleSource=agent` |
| `src/store/conversationStore.ts` | First-send `prompt`; rename → `user`; loadMessages paths |
| `tests/conversation-utils.test.mjs` | State machine tests |

---

### Task 1: Title source helpers + shouldApply rewrite

**Files:**
- Modify: `src/store/conversationUtils.ts`
- Test: `tests/conversation-utils.test.mjs`

- [ ] **Step 1: Update / add failing tests**

Replace/extend the agent-title tests in `tests/conversation-utils.test.mjs`:

```js
test("shouldApplyAgentSessionTitle respects titleSource state machine", async () => {
  const {
    shouldApplyAgentSessionTitle,
    inferConversationTitleSource
  } = await loadConversationUtils();

  assert.equal(
    shouldApplyAgentSessionTitle(
      { title: "Codex · project", agentName: "Codex", cwd: "/tmp/project", titleSource: "default" },
      [],
      "Fix login bug"
    ),
    true
  );
  assert.equal(
    shouldApplyAgentSessionTitle(
      { title: "please fix the login bug for me today", titleSource: "prompt" },
      [],
      "Fix login bug"
    ),
    true
  );
  assert.equal(
    shouldApplyAgentSessionTitle(
      { title: "Fix login bug", titleSource: "agent" },
      [],
      "Another title"
    ),
    false
  );
  assert.equal(
    shouldApplyAgentSessionTitle(
      { title: "My custom name", titleSource: "user" },
      [],
      "Agent title"
    ),
    false
  );
  assert.equal(
    shouldApplyAgentSessionTitle(
      { title: "排查图片预览失败", titleSource: "prompt" },
      [{ role: "assistant", workflowRunId: "workflow-1" }],
      "Agent generated title"
    ),
    false
  );

  assert.equal(
    inferConversationTitleSource({
      title: "Kimi · project",
      agentName: "Kimi",
      cwd: "/Users/me/project"
    }),
    "default"
  );
  assert.equal(
    inferConversationTitleSource({
      title: "please implement auth",
      agentName: "Kimi",
      cwd: "/Users/me/project"
    }),
    "prompt"
  );
});
```

Keep workflow exclusion. Update the old "custom conversation titles" test so explicit `titleSource: "user"` blocks override; legacy inferred `prompt` may still allow one agent upgrade (per spec).

- [ ] **Step 2: Run tests — expect FAIL**

Run: `node --test tests/conversation-utils.test.mjs --test-name-pattern "titleSource|inferConversation"`

- [ ] **Step 3: Implement**

In `conversationUtils.ts`:

```ts
export type ConversationTitleSource = "default" | "prompt" | "agent" | "user";

export function inferConversationTitleSource(
  conversation: Pick<Conversation, "title"> &
    Partial<Pick<Conversation, "agentName" | "cwd" | "titleSource">>
): ConversationTitleSource {
  if (conversation.titleSource) return conversation.titleSource;
  if (!conversation.agentName) return "prompt";
  const defaultTitle = defaultTitleForConversation({
    agentName: conversation.agentName,
    cwd: conversation.cwd
  });
  return conversation.title === defaultTitle ? "default" : "prompt";
}

export function shouldApplyAgentSessionTitle(
  conversation: Pick<Conversation, "title"> &
    Partial<Pick<Conversation, "agentName" | "cwd" | "titleSource">>,
  messagesOrTitle:
    | Pick<ConversationMessage, "workflowRunId">[]
    | string
    | undefined,
  maybeTitle?: string
): boolean {
  const messages = Array.isArray(messagesOrTitle) ? messagesOrTitle : [];
  const title = normalizeTitleText(
    Array.isArray(messagesOrTitle) ? maybeTitle : messagesOrTitle
  );
  if (!title || conversation.title === title) return false;
  if (messages.some((message) => Boolean(message.workflowRunId))) return false;
  const source = inferConversationTitleSource(conversation);
  return source === "default" || source === "prompt";
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/store/conversationUtils.ts tests/conversation-utils.test.mjs
git commit -m "feat: gate agent titles with titleSource state machine"
```

---

### Task 2: Persist title_source

**Files:**
- Modify: `electron/cli/db.ts`
- Modify: `electron/cli/conversations.ts`
- Modify: `src/services/cli/types.ts`
- Modify: `electron/cli/ipc.ts`, `electron/preload.ts`, `src/services/cli/client.ts`, `src/types/freebuddy.d.ts`

- [ ] **Step 1: DB**

Add `title_source TEXT` to `CREATE TABLE conversations` and migrate:

```ts
if (!conversationCols.some((c) => c.name === "title_source")) {
  db.exec("ALTER TABLE conversations ADD COLUMN title_source TEXT");
}
```

- [ ] **Step 2: conversations.ts**

1. Add `titleSource?: ConversationTitleSource` to `Conversation`
2. Parse `r.title_source` in `rowToConversation` (validate enum)
3. `createConversation`: accept optional `titleSource`, default `"default"`
4. Change rename:

```ts
export function renameConversation(
  id: string,
  title: string,
  titleSource?: ConversationTitleSource | null
): void {
  const now = new Date().toISOString();
  if (titleSource) {
    getDb()
      .prepare(
        `UPDATE conversations SET title = ?, title_source = ?, updated_at = ? WHERE id = ?`
      )
      .run(title, titleSource, now, id);
  } else {
    getDb()
      .prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, now, id);
  }
}
```

Also add `setConversationTitleSource` if useful, or always pass source through rename.

Prefer: all automatic/manual title updates go through `renameConversation(id, title, source)`.

- [ ] **Step 3: Types + IPC**

- Add `titleSource` to renderer `Conversation` / `CreateConversationInput`
- `renameConversation(id, title, titleSource?)` through preload/client/d.ts/ipc

- [ ] **Step 4: `npm run build:electron`**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: persist conversation titleSource"
```

---

### Task 3: Wire store + handlers

**Files:**
- Modify: `src/store/conversationHandlers.ts`
- Modify: `src/store/conversationStore.ts`
- Possibly `ChatView.tsx` only if it renames directly (prefer store)

- [ ] **Step 1: applyConversationTitle**

When applying agent title:

```ts
void cliClient.renameConversation(conversationId, title, "agent");
return conversations.map((entry) =>
  entry.id === conversationId
    ? { ...entry, title, titleSource: "agent" }
    : entry
);
```

- [ ] **Step 2: First-send prompt title**

Where `buildConversationTitle` / rename happens on first send (ChatView + conversationStore paths that set title from prompt): also pass `titleSource: "prompt"` when current source is missing/`default`.

Helper pattern in store:

```ts
async setConversationTitle(
  id: string,
  title: string,
  titleSource: ConversationTitleSource
) {
  await cliClient.renameConversation(id, title, titleSource);
  set((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === id ? { ...c, title, titleSource } : c
    )
  }));
}
```

- Manual `renameConversation(id, title)` → source `"user"`
- `newConversation` → `titleSource: "default"` (or `"prompt"` if caller passes a custom title from prompt — if ChatView creates with `buildConversationTitle`, use `"prompt"`)

Check ChatView create paths: if title is already built from prompt at create time, set `titleSource: "prompt"` in `createConversation` input.

- [ ] **Step 3: loadMessages agent/feed paths**

When applying agent title: rename with `"agent"`.  
When replacing with feed article title: rename with `"user"` (lock; prevents later ACP overwrite of article title).

- [ ] **Step 4: typecheck**

`npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: apply titleSource on send, stream, and rename"
```

---

### Task 4: Verification

- [ ] **Step 1:** `npm test`
- [ ] **Step 2:** `npm run typecheck`
- [ ] **Step 3:** Fix any regressions in conversation-utils / workflow-ui source assertions if they match rename signatures

---

## Spec coverage

| Requirement | Task |
|-------------|------|
| titleSource state machine | 1 |
| Persist column | 2 |
| First send → prompt | 3 |
| ACP title → agent once | 1, 3 |
| Manual rename → user | 3 |
| Legacy infer default/prompt | 1 |
| No hidden summarize prompt | (non-goal) |
| Workflow / preserve paths | 1, 3 |
