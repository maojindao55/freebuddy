# Design QA

Source visual truth path:
- `/var/folders/_l/t1lk7m411953763qdprx0qn00000gp/T/codex-clipboard-6463c2c9-2167-40d2-91c7-147d0601d5ed.png`
- `/var/folders/_l/t1lk7m411953763qdprx0qn00000gp/T/codex-clipboard-45fc3f39-57b1-400e-9a05-29713979783e.png`

Implementation screenshot path:
- blocked: browser preview has no Electron CLI bridge, so it loads the empty new-task state rather than an existing conversation with assistant output.

Viewport:
- intended desktop comparison, WorkBuddy-style chat thread.

State:
- active conversation with user prompt, assistant process stream, markdown text, and markdown table.

Full-view comparison evidence:
- Source screenshots show a continuous assistant response flow: avatar/name/status at top, lightweight tool/process rows, plain prose, ordered lists, inline code, and bordered markdown table. Assistant output is not wrapped in a large bordered card.

Focused region comparison evidence:
- blocked: no rendered active conversation state could be captured in browser preview. A data-url fixture attempt was blocked by browser security policy, and no workaround was attempted.

Findings:
- [P2] Visual QA capture blocked for active chat output.
  Location: browser preview verification.
  Evidence: the preview opens the new-task state because `window.freebuddy.cli` is unavailable outside Electron.
  Impact: code-level checks pass, but screenshot-level fidelity still needs one Electron run with existing conversation data.
  Fix: verify in the Electron app, or add a first-class local demo fixture route/state for chat rendering QA.

Patches made since previous QA pass:
- Converted assistant messages from large bordered bubbles into a transparent flowing response layout.
- Added lightweight WorkBuddy-like tool/process rows.
- Added markdown-style rendering for paragraphs, lists, inline code, bold text, fenced code, and tables.
- Added Codex `item.updated` handling for incremental text/thinking deltas.
- Added final-message replacement/deduping so streamed deltas and completed full text do not duplicate.

Checks completed:
- `npm run typecheck` passed.
- `npm run build` passed.

final result: blocked
