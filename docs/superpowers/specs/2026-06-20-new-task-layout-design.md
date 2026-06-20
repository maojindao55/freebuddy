# New Task Page Layout Simplification Design

## Goal

Make the "new conversation" (new-task) home page more concise, and fix a bug that prevents the attach button from working on that page.

## Background

The new-task home (`NewTaskHome` in `src/components/CLI/ChatView.tsx`) currently renders, top to bottom:

1. A large gradient hero heading "FreeBuddy" + a subtitle paragraph.
2. Three quick-prompt chips (Analyze / Modify / Review).
3. A rounded composer box containing:
   - `AttachmentTray` (only when attachments exist),
   - the prompt textarea,
   - a toolbar row (`Agent` select / `Permission` select / `Send`),
   - a separate workspace-picker row (`Attach` / `Workspace` / cwd input).

The brand name already appears in the sidebar, so the hero duplicates it. The two bottom rows split controls that belong together, adding visual weight.

## Bug: Attach Button No Response on New-Task Page

`ChatView` computes:

```ts
const sending =
  running ||
  (submitPreview?.conversationId === conv?.id);
```

On the new-task page there is no active conversation: `conv` is `undefined`, and `submitPreview` starts as `null`. Both `submitPreview?.conversationId` and `conv?.id` evaluate to `undefined`, so `undefined === undefined` is `true`, making `sending` always `true`.

`handleSelectAttachments` begins with `if (sending) return;`, so on the new-task page the attach button silently does nothing.

## Design

### Layout

Keep the prompt textarea untouched. Around it:

- **Remove** the hero heading ("FreeBuddy"), the subtitle paragraph, and the three quick-prompt chips. (The active-conversation empty state keeps its own starter prompts; the sidebar already shows the brand.)
- **Merge** the two bottom rows into a single toolbar row inside the composer:
  - Left: `[Attach]` button, `[Workspace]` button with the cwd input inline.
  - Right: `[Agent]` select, `[Permission]` select, `[Send]` button.
- `AttachmentTray` remains directly above the textarea, unchanged.

Result: the page is a single centered composer (textarea + one toolbar row), with the attach button reachable and functional.

### Bug Fix

Change the `sending` computation so a missing conversation/preview cannot make it `true`:

```ts
const sending =
  running ||
  (submitPreview !== null && submitPreview.conversationId === conv?.id);
```

This keeps the existing submit-preview behavior for active conversations and stops the new-task page from being permanently in the "sending" state.

## Files Affected

- `src/components/CLI/ChatView.tsx`
  - Fix the `sending` expression.
  - Rewrite `NewTaskHome` JSX: drop the hero/subtitle/chips, merge `new-task-toolbar` and `workspace-picker` into one row.
- `styles.css`
  - Remove now-unused rules for `.new-task-hero h1`, `.new-task-hero h1 span`, `.new-task-subtitle`, `.new-task-chips` (and their hover/focus/responsive variants where they only served the removed elements).
  - Adjust `.new-task-toolbar` to host the workspace tools + cwd input inline, and drop or repurpose `.workspace-picker` / `.new-task-tools` layout rules.

## Out of Scope

- No changes to the active-conversation composer.
- No changes to attachment validation, IPC, or message storage.
- No i18n key removals (keys stay for other usages; the removed elements simply are not rendered).
- No drag-and-drop or paste support.
