# Code Whip Easter Egg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users click a running/starting assistant avatar in the main chat to play a ~0.8s comedy “码鞭” hit effect, with no impact on agent execution.

**Architecture:** Local React state in `MessageBubble` (`whipping` + `whipNonce`) toggles a `whip-hit` CSS class and short-lived effect nodes on the avatar wrapper. Pure frontend; no store/IPC/DB/audio.

**Tech Stack:** React, CSS keyframes in `styles.css`, Node test runner (source-assert tests).

**Spec:** `docs/superpowers/specs/2026-07-09-code-whip-easter-egg-design.zh-CN.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `src/components/CLI/MessageBubble.tsx` | Click gate, local whip state, effect DOM |
| `styles.css` | Whip keyframes, pointer/hover, reduced-motion |
| `src/locales/en.json` + `zh-CN.json` | Optional `aria-label` for whipable avatar |
| `tests/code-whip.test.mjs` | Source/contract assertions for trigger + CSS |

---

### Task 1: Failing contract tests

**Files:**
- Create: `tests/code-whip.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("MessageBubble gates code whip to running/starting assistant avatars", () => {
  const src = read("../src/components/CLI/MessageBubble.tsx");
  assert.match(src, /whipNonce/);
  assert.match(src, /whipping/);
  assert.match(src, /whip-hit/);
  assert.match(src, /status === "running" \|\| message\.status === "starting"/);
  assert.match(src, /onClick=\{.*whip|handleWhip|onWhip/s);
});

test("styles define whip-hit comedy effect and reduced-motion fallback", () => {
  const css = read("../styles.css");
  assert.match(css, /\.whip-hit/);
  assert.match(css, /@keyframes whip/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /啪|whip-pop|whip-crack/);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --test tests/code-whip.test.mjs`

- [ ] **Step 3: Commit tests**

```bash
git add tests/code-whip.test.mjs
git commit -m "test: add code whip contract tests"
```

---

### Task 2: MessageBubble whip trigger

**Files:**
- Modify: `src/components/CLI/MessageBubble.tsx`
- Modify: `src/locales/en.json`, `src/locales/zh-CN.json` (aria-label)

- [ ] **Step 1: Add i18n keys**

In both locale files under `message`:

```json
"whipAvatar": "Code whip"
```

zh-CN:

```json
"whipAvatar": "码鞭"
```

- [ ] **Step 2: Wire avatar click + effect nodes in assistant branch**

Near the assistant `AgentAvatar` render (~line 912):

1. Import `useCallback`, `useEffect`, `useRef` if needed (already has `useState`).
2. Inside the memo component (before returns that need it, or only in assistant path via hooks at top level):

```tsx
const [whipping, setWhipping] = useState(false);
const [whipNonce, setWhipNonce] = useState(0);
const whipTimerRef = useRef<number | null>(null);

const canWhip =
  message.role === "assistant" &&
  (message.status === "running" || message.status === "starting");

const handleWhip = useCallback(() => {
  if (!canWhip || whipping) return;
  setWhipping(true);
  setWhipNonce((n) => n + 1);
  if (whipTimerRef.current != null) window.clearTimeout(whipTimerRef.current);
  whipTimerRef.current = window.setTimeout(() => {
    setWhipping(false);
    whipTimerRef.current = null;
  }, 800);
}, [canWhip, whipping]);

useEffect(() => {
  return () => {
    if (whipTimerRef.current != null) window.clearTimeout(whipTimerRef.current);
  };
}, []);
```

3. Wrap avatar:

```tsx
<button
  type="button"
  className={`msg-avatar-whip-target${whipping ? " whip-hit" : ""}${canWhip ? " whipable" : ""}`}
  onClick={canWhip ? handleWhip : undefined}
  disabled={!canWhip}
  aria-label={canWhip ? t("message.whipAvatar") : undefined}
  tabIndex={canWhip ? 0 : -1}
>
  <AgentAvatar
    key={whipNonce}
    adapter={message.adapter ?? adapter}
    agentId={message.agentId}
    iconKey={agentIconKey}
    className="msg-avatar agent-avatar"
    fallback={<span>✦</span>}
  />
  {whipping && (
    <>
      <span className="whip-arc" aria-hidden="true" />
      <span className="whip-crack" aria-hidden="true">
        啪
      </span>
      <span className="whip-spark whip-spark-1" aria-hidden="true" />
      <span className="whip-spark whip-spark-2" aria-hidden="true" />
      <span className="whip-spark whip-spark-3" aria-hidden="true" />
    </>
  )}
</button>
```

Notes:
- Hooks must stay at top level of the component (not inside role branches).
- Prefer `<button>` for a11y; style it to look like the bare avatar (reset border/background/padding).
- When `!canWhip`, keep layout identical but non-interactive (`disabled` / no pointer).

- [ ] **Step 3: Run contract test — expect MessageBubble assertions PASS (CSS still FAIL)**

- [ ] **Step 4: Commit**

```bash
git add src/components/CLI/MessageBubble.tsx src/locales/en.json src/locales/zh-CN.json
git commit -m "feat: trigger code whip on running assistant avatar click"
```

---

### Task 3: CSS comedy effect

**Files:**
- Modify: `styles.css` (near `.msg-avatar` / `.msg-assistant .msg-avatar`)

- [ ] **Step 1: Add styles**

```css
.msg-avatar-whip-target {
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: default;
}

.msg-avatar-whip-target.whipable {
  cursor: pointer;
}

.msg-avatar-whip-target.whipable:hover .msg-avatar {
  transform: scale(1.12);
}

.msg-avatar-whip-target:disabled {
  cursor: default;
}

.msg-avatar-whip-target .msg-avatar {
  /* avatar fills the button; keep existing look */
}

.whip-hit .msg-avatar {
  animation: whip-shake 0.45s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}

.whip-arc {
  position: absolute;
  inset: -10px -14px auto auto;
  width: 28px;
  height: 28px;
  border: 2px solid transparent;
  border-top-color: #f59e0b;
  border-right-color: #f59e0b;
  border-radius: 50%;
  transform-origin: 20% 80%;
  animation: whip-arc-swing 0.15s ease-out both;
  pointer-events: none;
}

.whip-crack {
  position: absolute;
  left: 100%;
  top: -6px;
  margin-left: 4px;
  font-size: 14px;
  font-weight: 800;
  color: #ef4444;
  text-shadow: 0 1px 0 #fff, 1px 1px 0 rgba(0, 0, 0, 0.15);
  animation: whip-crack-pop 0.45s ease-out both;
  pointer-events: none;
  white-space: nowrap;
}

.whip-spark {
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #fbbf24;
  pointer-events: none;
  animation: whip-spark-fly 0.5s ease-out both;
}

.whip-spark-1 { top: 2px; right: -2px; animation-delay: 0.15s; }
.whip-spark-2 { top: 12px; right: -8px; animation-delay: 0.18s; background: #f97316; }
.whip-spark-3 { top: -2px; right: 8px; animation-delay: 0.2s; background: #fde68a; }

@keyframes whip-arc-swing {
  from { transform: rotate(-40deg) scale(0.6); opacity: 0; }
  to { transform: rotate(25deg) scale(1); opacity: 1; }
}

@keyframes whip-shake {
  0%, 100% { transform: translate(0, 0) rotate(0); }
  15% { transform: translate(-3px, 1px) rotate(-8deg); }
  30% { transform: translate(4px, -1px) rotate(7deg); }
  45% { transform: translate(-3px, 1px) rotate(-6deg); }
  60% { transform: translate(2px, 0) rotate(4deg); }
  75% { transform: translate(-1px, 0) rotate(-2deg); }
}

@keyframes whip-crack-pop {
  0% { transform: scale(0.4); opacity: 0; }
  30% { transform: scale(1.35); opacity: 1; }
  100% { transform: scale(1) translateY(-6px); opacity: 0; }
}

@keyframes whip-spark-fly {
  0% { transform: translate(0, 0) scale(1); opacity: 1; }
  100% { transform: translate(10px, -12px) scale(0); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .whip-arc,
  .whip-crack,
  .whip-spark {
    display: none !important;
  }
  .whip-hit .msg-avatar {
    animation: whip-shake-reduced 0.2s ease-out both;
  }
}

@keyframes whip-shake-reduced {
  0%, 100% { transform: translate(0, 0); }
  50% { transform: translate(2px, 0); }
}
```

Adjust so existing `.msg:hover .msg-avatar` does not fight `whipable` hover; scoping under `.msg-avatar-whip-target` is enough.

- [ ] **Step 2: Run `node --test tests/code-whip.test.mjs` — expect PASS**

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "feat: add code whip CSS comedy effect"
```

---

### Task 4: Verification

- [ ] **Step 1:** `npm test`
- [ ] **Step 2:** `npx tsc --noEmit`
- [ ] **Step 3:** Push branch; open/update PR

---

## Spec coverage

| Requirement | Task |
|-------------|------|
| Click running/starting avatar | 2 |
| Comedy 0.8s effect | 3 |
| Ignore clicks while playing | 2 (`whipping` gate) |
| No store/IPC/audio | (non-goal) |
| reduced-motion | 3 |
| Idle/history no-op | 2 (`canWhip`) |
