# ButlerBuddy floating pet and mini-chat design QA

- Source visual truth: `/Users/hongbin9/.codex/generated_images/019fd6fd-bfec-7bf2-8ce7-848bf0ae24c9/exec-f3883e82-cf3a-48b0-b64f-68418dad8910.png`
- Browser-rendered implementation screenshot: `/Users/hongbin9/.codex/visualizations/2026/08/06/019fd6fd-bfec-7bf2-8ce7-848bf0ae24c9/butlerbuddy/chat-browser.jpg`
- Normalized chat-window crop: `/Users/hongbin9/.codex/visualizations/2026/08/06/019fd6fd-bfec-7bf2-8ce7-848bf0ae24c9/butlerbuddy/chat-crop.png`
- Floating-pet capture: `/Users/hongbin9/.codex/visualizations/2026/08/06/019fd6fd-bfec-7bf2-8ce7-848bf0ae24c9/butlerbuddy/pet-browser.png`
- Combined focused comparison: `/Users/hongbin9/.codex/visualizations/2026/08/06/019fd6fd-bfec-7bf2-8ce7-848bf0ae24c9/butlerbuddy/comparison.png`
- Viewport: browser capture 1280 x 720 px; production chat window 360 x 420 CSS px; normalized component crop 360 x 420 px; pet window 128 x 128 CSS px
- Density normalization: source 1487 x 1058 px at 1x; implementation browser capture 1280 x 720 px at 1x; both component regions are shown without density scaling in the combined comparison
- State: light theme, ButlerBuddy mini-chat open, one user message and one assistant reply, composer idle

## Full-view comparison evidence

The source establishes a very small white chat surface attached to a floating green pet, with only a title bar, conversation, and composer. The browser-rendered implementation preserves that hierarchy and keeps the production dimensions fixed even inside a larger browser viewport. The pet is delivered as a transparent raster asset in its own always-on-top 128 px Electron window; the chat is a separate 360 x 420 window positioned beside it.

## Focused region comparison evidence

`comparison.png` places the source crop on the left and the final implementation crop on the right. Both use the same compact title row, green online status, right-aligned pale-green user bubble, left-aligned neutral assistant bubble with pet avatar, generous empty conversation space, and one bottom composer. The implementation is intentionally slightly narrower than the generated mock because the approved feedback asked for a lighter surface; the prompt target specified an approximately 340 px panel and the implementation content width is 344 px.

## Required fidelity surfaces

- Fonts and typography: FreeBuddy's existing Plus Jakarta Sans / system Chinese font stack is retained. Header is 13 px / 700; messages are 13 px with 1.55 line height; placeholder is 12.5 px. Text stays on the same lines as the source crop without clipping.
- Spacing and layout rhythm: 48 px header, 16-18 px conversation padding, 14 px message gaps, 11 px bubble radii, 14 px composer radius, and 8 px outer breathing room preserve the approved lightweight rhythm.
- Colors and visual tokens: white and `#f8fafc`-family surfaces, slate text, `#10b981` online/send accents, pale-green user message, and subtle gray borders map to the existing FreeBuddy token system.
- Image quality and asset fidelity: the pet is a dedicated generated 512 x 512 RGBA raster asset at `public/butlerbuddy-pet.png`, not CSS art or an emoji. Its alpha edge was contracted and visually checked on white; transparent padding was tightened after the first comparison so the 24 px avatars match the source scale.
- Copy and content: the final surface contains only `ButlerBuddy`, the user/assistant messages, and `发消息给 ButlerBuddy…`. Diagnostics, quick actions, metrics, update cards, and settings shortcuts from the earlier concept are absent.

## Findings

No actionable P0, P1, or P2 differences remain for the approved lightweight chat direction.

## Primary interactions tested

- Entered `测试一下` in the browser-rendered composer and submitted it.
- Confirmed the user message appeared, the temporary replying state resolved, and an assistant reply rendered.
- Confirmed the empty composer disables the send button.
- Confirmed the clean chat and pet tabs report no browser console warnings or errors.
- Automated contracts cover the Electron toggle/hide IPC, separate always-on-top transparent windows, pet-to-chat positioning, persisted ButlerBuddy conversation id, real conversation creation, message loading, and real `sendMessage` dispatch.

## Comparison history

1. The first browser render exposed an unstable empty-array Zustand selector and React stopped the chat surface with a maximum-update-depth error.
2. The selector now reuses one stable empty array; a clean reload renders with no console errors.
3. The first focused comparison showed the pet avatars smaller than the mock because the generated RGBA asset retained excessive transparent padding.
4. The asset was cropped to its visible alpha bounds with controlled padding; the revised comparison confirms source-like avatar scale and clean edges.

## Follow-up polish

- P3: A future motion pass could add a restrained hover/idle animation to the pet, but motion was intentionally excluded from this lightweight implementation.

final result: passed

---

# New-task composer workspace context design QA

- Source visual truth: `C:\Users\Morefine\AppData\Local\Temp\codex-clipboard-c0fb57e4-e27a-4a7b-9d11-d91d2b81577b.png`
- Placement reference: `C:\Users\Morefine\AppData\Local\Temp\codex-clipboard-829f3fe9-7c01-4cb5-81e0-73d6210848e7.png`
- Browser-rendered implementation screenshot: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\implementation-full.jpg`
- Focused implementation crop: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\implementation-context-crop.png`
- Combined comparison: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\comparison.png`
- Viewport: 1280 x 720 CSS px and screenshot pixels at 1x; composer stack 760 x 343 CSS px
- Source and implementation pixels: source 1124 x 474 px; implementation 1280 x 720 px; focused source crop 1000 x 314 px; focused implementation crop 760 x 235 px
- Density normalization: the focused implementation crop was proportionally normalized to 314 px high beside the 314 px-high source crop; no browser or device chrome is included in the focused comparison
- State: light theme, new-task page, normal mode, `freebuddy` selected, Local mode selected, `codex/performance-p0` selected

## Full-view comparison evidence

The implementation preserves FreeBuddy's existing title, mode tabs, composer proportions, toolbar, and send action. The workspace context is removed from the crowded inner toolbar and attached below the composer as a narrower soft panel, following the reference control order while applying the user's requested bottom placement.

## Focused region comparison evidence

`comparison.png` places the supplied top-context reference on the left and the final bottom-context implementation on the right at the same visual height. Project, execution mode, and Git branch retain the reference's left-to-right scan order, compact icon scale, quiet neutral surface, and single-line labels. The deliberate difference is vertical placement: the implementation bar is attached below the composer rather than above it.

## Required fidelity surfaces

- Fonts and typography: existing FreeBuddy interface fonts and 12 px compact-control scale are retained; project and branch names stay on one line with ellipsis protection.
- Spacing and layout rhythm: the bar is inset 20 px from both composer edges, 44 px tall, and uses 16 px group spacing. It shares the composer's centerline and reads as one attached control surface without adding toolbar crowding.
- Colors and visual tokens: the bar uses the existing soft-panel, border, hover, text, and focus tokens; no unrelated accent palette was introduced.
- Image quality and asset fidelity: no raster assets are required. Folder, computer, branch, and remove affordances use the project's installed Lucide icon system.
- Copy and content: directory basename, Local/Worktree choice, and the selected Git branch are localized and match the requested context fields.

## Findings

No actionable P0, P1, or P2 visual, responsive, or interaction mismatch remains for the requested bottom workspace context treatment.

## Primary interactions tested

- Selected Worktree and switched the branch from `codex/performance-p0` to `main` in the browser-rendered composer, then restored Local and the original branch.
- Confirmed the selected workspace exposes a remove action and the no-workspace state collapses to one working-directory button.
- Confirmed a clean Git workspace can switch local branches and a dirty workspace is protected from an implicit switch.
- Confirmed Worktree creates a detached isolated checkout from the selected branch and returns that checkout as the task execution directory.
- Checked a fresh browser-rendered selected-workspace state for console warnings and errors: none.

## Comparison history

1. The original composer kept its workspace control inside the main toolbar and had no branch or Worktree selection.
2. The workspace context moved into a dedicated attached lower bar; Local/Worktree and branch selectors were wired to the task creation path.
3. The first focused comparison found the bar proportions, control order, typography, and neutral hierarchy aligned with the reference, with bottom placement intentionally matching the user's direction. No P0/P1/P2 visual fix was required.

## Follow-up polish

- P3: extremely long branch names are capped at 230 px and truncated by the native select text field to protect the composer width.

## Follow-up iteration — adaptive dropdown spacing

- User-reported source state: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\implementation-context-crop.png`
- Revised browser-rendered implementation: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\implementation-spacing-refined.png`
- Focused revised crop: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\implementation-spacing-focused.png`
- Before/after comparison input: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\spacing-comparison.png`
- State and viewport: light theme, 1280 x 720 CSS px at 1x, Local and `codex/performance-p0` selected; the same controls were also tested with Worktree and `main` selected.
- Finding: P2 spacing drift — the native select arrow stayed at the far edge of a flexed field, leaving a visibly excessive gap after short labels.
- Fix: removed the native arrow, added the existing Lucide chevron as a separate trailing icon, and sized the select to its selected content with a 230 px cap.
- Post-fix evidence: the measured text-field-to-chevron gap remains 4 px for Local, Worktree, `main`, and `codex/performance-p0`; control widths shrink from 193 px for the long branch state to 80 px for `main` without disturbing the lower bar layout.
- Fidelity surfaces: typography, neutral color tokens, icon scale, copy, 44 px bar height, and responsive wrapping remain unchanged. No image asset changes were required.
- Result: no actionable P0, P1, or P2 mismatch remains after the second comparison.

## Follow-up iteration — custom dropdown and control order

- Closed-state implementation: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\implementation-custom-dropdown-closed.png`
- Open-state implementation: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\implementation-custom-dropdown-open.png`
- User finding: the native dropdown treatment still felt visually rough, and branch needed to precede execution location.
- Fix: replaced both native selects with compact accessible popovers using the existing FreeBuddy panel, hover, border, focus, shadow, and brand tokens. The selected item receives a checkmark and the trigger chevron rotates while open.
- Ordering evidence: the final lower bar reads working directory → Git branch → Local/Worktree.
- Interaction evidence: opened both menus, changed branch to `main`, changed execution location to Worktree, restored the original values, verified outside-click/Escape handling in code, and confirmed branch menu scrolling plus Arrow/Home/End focus support.
- Result: the open menu remains clear of clipping and retains the existing 44 px collapsed bar height; no actionable P0, P1, or P2 visual issue remains.

## Follow-up iteration — branch search and create/checkout

- Source visual truth: `C:\Users\Morefine\AppData\Local\Temp\codex-clipboard-d6f928de-4888-4312-a661-b662c3210f7c.png`
- Open-state implementation: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\implementation-branch-menu-open.png`
- Search-state implementation: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\implementation-branch-search.png`
- Create-state implementation: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\implementation-branch-create.png`
- Side-by-side comparison: `C:\Users\Morefine\www\freebuddy\artifacts\product-design\new-task-composer\branch-search-create-comparison.png`
- Viewport and pixels: implementation 1280 x 720 CSS px and screenshot pixels at 1x; source 725 x 493 px; light theme, branch popover open above the bottom context bar.
- Full-view comparison evidence: the reference and implementation were inspected together. Both use a fixed search/header/footer shell, a vertically scrollable branch list, branch icons, a selected-state checkmark, and a visually separated bottom create action. FreeBuddy keeps the user-requested lower context-bar order of directory → branch → Local/Worktree.
- Focused interaction evidence: typing `runtime` reduced ten branches to the three matching names without closing the popover. Activating the footer replaced it with an inline branch-name field plus cancel and confirm controls; `feature/branch-search-flow` remained fully visible.
- Functional evidence: the Electron path validates names with Git, rejects duplicates, creates from the selected start branch, checks out the new branch, refreshes the branch list, and preserves untracked workspace changes. The real Git integration test covered successful creation plus duplicate and invalid-name failures.
- Fidelity surfaces: existing FreeBuddy typography, neutral surface/border/shadow tokens, Lucide search/branch/plus/check icons, compact row rhythm, focus treatment, localized copy, and upward popover placement are retained. No raster asset substitution is required.
- Findings: no actionable P0, P1, or P2 visual, overflow, search, creation, or checkout mismatch remains.

final result: passed

---

# ButlerBuddy 狂热突袭 design QA

- Source visual truth: `/Users/hongbin9/.codex/generated_images/019fe968-4981-7e03-9bbd-1200b3295f6f/exec-74e103b8-e3de-4471-ad42-9ba759b51b65.png`
- Browser-rendered implementation screenshot: `/tmp/freebuddy-arcade-implementation.png`
- Combined comparison: `/tmp/freebuddy-arcade-design-qa.png`
- Viewport: 360 x 300 CSS px and 360 x 300 screenshot pixels at 1x
- Density normalization: the 1374 x 1145 source was normalized to the production window's 360 x 300 aspect and density before comparison
- State: light theme, entertainment enabled, ten-second Boss climax, active first weak point

## Full-view comparison evidence

The source and implementation were inspected together at the same 360 x 300 frame. The implementation preserves the reference hierarchy: score at upper left, fever meter in the center, countdown and close action at upper right, boss name and health immediately below, a large violet boss in the playfield, colored glass targets around it, and the pet-centered ultimate meter at the bottom.

## Focused region comparison evidence

The combined comparison places the normalized source on the left and the live implementation on the right. The final render matches the source's soft translucent shell, mint-green progress language, orange-red boss health, violet boss palette, luminous cyan/pink/gold targets, and compact HUD rhythm. Live ball positions intentionally differ because they are physics-driven; the same spatial density and readable separation are retained.

## Required fidelity surfaces

- Fonts and typography: the existing FreeBuddy font stack is retained; compact numeric HUD labels, centered boss title, and bold combo/result copy remain legible in the 360 px window.
- Spacing and layout rhythm: the 8 px top HUD, 6 px inter-control gaps, centered boss region, and pet-aligned ultimate meter leave the moving target field unobstructed.
- Colors and visual tokens: existing neutral surface and mint brand tokens are combined with the approved violet boss, cyan/pink targets, gold rare-target accent, and orange-red danger bar.
- Image quality and asset fidelity: the boss and orb are dedicated transparent raster assets at `public/butlerbuddy/arcade/boss.png` and `public/butlerbuddy/arcade/orb.png`; no CSS-drawn substitute or placeholder is used.
- Copy and content: score, fever/combo, countdown, boss name, chain feedback, ultimate charge, victory/timeout, final score, and replay are localized in Simplified Chinese and English.

## Findings

No actionable P0, P1, or P2 visual or interaction difference remains for the approved combined direction.

## Primary interactions tested

- Sampled every live ball's bounds twice across 500 ms and confirmed positions changed independently instead of remaining stacked on the pet.
- Hit a gold target and confirmed the score changed from 0 to 120.
- Triggered a three-target same-color chain and confirmed `+20`, `+40`, `+80`, and `3 连锁!` feedback.
- Filled fever early, entered the Boss phase, hit all four rotating weak points, reached the 100% ultimate state, clicked the pet, and confirmed `故障清除!` with a 1144-point result.
- Replayed after timeout and victory; the round state reset correctly.
- Checked the full browser journey for warnings and errors: none.
- Automated tests cover physics, scoring, chains, fever/timed Boss entry, weak points, ultimate victory, thirty-second timeout, preference persistence, and Electron window resizing.

## Comparison history

1. The original implementation inherited a global `transition: all`, causing updated ball coordinates to restart every frame and visually stack near the pet.
2. Motion was restricted to the intended filter transition; runtime position samples now show large independent changes over 500 ms.
3. The single-ball loop was expanded into the approved combined hunt, chain, boss, weak-point, ultimate, victory, timeout, and replay flow.
4. A final side-by-side comparison found the hierarchy and visual language aligned; victory now clears residual balls so the result card stays quiet.

## Follow-up polish

- P3: sound and haptic-style audio cues could add another layer of game feel, but were excluded from this visual and interaction pass.

final result: passed

---

# Agent self-check export design QA

- Source visual truth: `C:\Users\Morefine\.codex\generated_images\019fd22c-698f-7d93-991a-6f7c065756dc\exec-f5fc3830-031d-4bd6-bc03-1da984d4dfb5.png`
- Implementation screenshot: unavailable
- Viewport: Codex in-app browser default desktop viewport; exact CSS and pixel dimensions unavailable
- Density normalization: unavailable because no implementation screenshot could be captured
- State: light theme, conversation-scoped debug-log dialog, Agent self-check intended as the first/default option

## Full-view comparison evidence

The implementation rendered successfully in the local app preview and the DOM snapshot confirmed the three modes in the intended order, the conversation scope text, the log preview, and the footer actions. The in-app browser then blocked the local QA URL before a screenshot could be captured. Without both visible artifacts in one comparison input, no visual-fidelity judgment is valid.

## Focused region comparison evidence

Unavailable. The radio group and footer were present in the rendered DOM, but typography, spacing, color, checked state, and button appearance cannot be accepted from markup or code inspection alone.

## Findings

- [P1] Final visual comparison is unavailable.
  - Location: debug log export modal.
  - Evidence: the source mock is available, but the browser URL policy blocked the local implementation page before screenshot capture.
  - Impact: the required typography, spacing, color, and selected-state fidelity cannot be verified against the approved mock.
  - Fix: open the desktop build, enter a conversation, open Export debug logs, and capture the default Agent self-check state at the same crop as the source.

## Required fidelity surfaces

- Fonts and typography: blocked pending a rendered screenshot.
- Spacing and layout rhythm: blocked pending a rendered screenshot.
- Colors and visual tokens: implementation reuses existing FreeBuddy tokens, but visual parity is blocked pending a rendered screenshot.
- Image quality and asset fidelity: no new image or icon assets are used by this modal.
- Copy and content: DOM evidence confirms Agent self-check is listed before Standard and Full, with the approved explanatory copy; visual wrapping remains unverified.

## Primary interactions tested

- Local rendering reached the conversation-scoped dialog with all three modes and diagnostic preview content.
- Automated tests confirm Agent self-check is first/default for conversation entry points.
- Automated tests confirm clicking self-check opens the new-conversation page, pre-fills the full-log directory prompt, and leaves Agent selection to the user.
- The final visual selected state and screenshot comparison were not completed because the browser rejected further access to the local QA URL.

## Comparison history

1. Initial build exposed two CSS declarations outside their selector; the production build warning identified the issue.
2. The declarations were moved into `.debug-logs-mode small`, and the production build passed.
3. The local preview rendered the complete modal and DOM structure.
4. Screenshot capture and side-by-side comparison were blocked by the in-app browser URL policy.

## Implementation checklist

- Capture the desktop modal in its default Agent self-check state.
- Compare the source and implementation in one input at equal crop and scale.
- Resolve any P0/P1/P2 visual mismatch before changing this result to passed.

final result: blocked

---

# Design QA

- Source visual truth: `C:\Users\Morefine\AppData\Local\Temp\codex-clipboard-464aa908-a44f-45ef-be9b-89f2e3f150d1.png`
- Previous implementation screenshot: `C:\Users\Morefine\AppData\Local\Temp\codex-clipboard-5b3d381a-c03a-498f-a84e-1544bc938403.png`
- Revised implementation screenshot: unavailable after the section-title fix
- Viewport: expanded desktop sidebar; latest implementation crop 316 x 300 px
- State: light theme, Teams and Conversations section headers visible

## Full-view comparison evidence

The supplied implementation screenshot shows the Teams header in primary black text while the Conversations header uses tertiary gray. They represent the same section-heading level but render as different hierarchy levels because Teams inherited an active state. The code now removes that active state and gives both headings the same typography tokens. A post-fix screenshot is unavailable, so final visual comparison remains blocked.

## Focused region comparison evidence

The focused sidebar crop makes the mismatch explicit: Teams is darker and optically stronger than Conversations. Both now use 11 px font size, weight 600, 16 px line height, 0.02 em letter spacing, and the tertiary text token. Teams changes to primary text only while hovered.

## Findings

- [P1] Post-fix section-heading parity is not visually confirmed.
  - Location: Teams and Conversations section headers.
  - Evidence: the supplied screenshot shows different color and optical weight; the selectors are now normalized, but no revised screenshot is available.
  - Impact: the requested hierarchy correction cannot be accepted from code inspection alone.
  - Fix: capture the refreshed sidebar and compare the two headings in the same state.

## Required fidelity surfaces

- Fonts and typography: both headings now share 11 px, weight 600, 16 px line height, and 0.02 em letter spacing; post-fix rendering is not visually verified.
- Spacing and layout rhythm: existing section-header containers remain unchanged; only type styling and state behavior changed.
- Colors and visual tokens: both headings now use the tertiary token at rest; Teams no longer stays primary-colored on the Teams page.
- Image and icon fidelity: no image assets changed; existing Lucide add and search icons remain in their original slots.
- Copy and content: Teams / 团队 and Conversations / 对话 remain unchanged.

## Implementation checklist

- Capture the refreshed expanded sidebar in light theme.
- Confirm that Teams and Conversations have matching resting color, size, weight, and baseline treatment.
- Correct any remaining P0/P1/P2 mismatch before marking the result passed.

## Comparison history

- Earlier refinement: team rows and All teams were aligned successfully.
- Latest screenshot: exposed a remaining section-header mismatch caused by the Teams active state.
- Fix applied: removed the persistent active class and matched the exact Conversations heading typography.
- Post-fix visual evidence: blocked because the revised Electron screenshot is unavailable.

final result: blocked

---

# Sidebar primary navigation design QA

- Source visual truth: `/var/folders/_l/t1lk7m411953763qdprx0qn00000gp/T/codex-clipboard-20bf6399-75cd-42dc-9a39-86866cb37cac.png`
- Implementation screenshot: `/tmp/freebuddy-sidebar-final.png`
- Combined comparison: `/tmp/freebuddy-sidebar-comparison-final.png`
- Viewport: 1280 x 720
- State: light theme, new-task page, `新会话` selected

## Full-view comparison evidence

The implementation screenshot confirms that the sidebar remains integrated with the existing FreeBuddy shell and that the updated navigation does not disturb the composer, team section, conversation section, or footer.

## Focused region comparison evidence

The combined comparison normalizes the reference and implementation to the same sidebar width. The implementation now follows the reference structure: a transparent outer navigation area, flat icon-and-label rows, and a single soft rounded background applied only to the selected row.

## Required fidelity surfaces

- Fonts and typography: Existing FreeBuddy font stack is retained; navigation labels use 14px text, 520 default weight, and 600 selected weight. The resulting hierarchy is comparable to the reference without introducing a foreign font.
- Spacing and layout rhythm: Rows use a consistent 42px height, 10px horizontal padding, 2px vertical gap, and 10px selected radius. The outer card padding, border, divider, and shadow from the earlier implementation are removed.
- Colors and visual tokens: The reference's lavender palette is intentionally mapped to FreeBuddy's existing sidebar and soft-panel tokens. Selection remains neutral rather than introducing a new accent color.
- Image quality and asset fidelity: No new raster assets are required. The existing FreeBuddy brand asset is preserved, and navigation icons continue to use the installed Lucide icon system.
- Copy and content: Existing FreeBuddy labels (`新会话`, `定时任务`) are unchanged.

## Findings

No actionable P0, P1, or P2 differences remain for the requested navigation treatment.

## Comparison history

1. Earlier implementation used a bordered, filled navigation card with an inset selected card. User feedback identified this as the wrong visual model.
2. The outer card, border, divider, and shadow were removed; row rhythm and icon sizing were normalized; selection was changed to one soft full-row background.
3. Post-fix evidence in `/tmp/freebuddy-sidebar-comparison-final.png` confirms the navigation now matches the reference's flat-list model.

## Primary interactions tested

- Opened the local new-task page and confirmed `新会话` is the selected navigation item.
- Activated `定时任务` and confirmed current-page semantics moved to that item and its page rendered.
- Checked browser console errors: none.

## Follow-up polish

- P3: The FreeBuddy brand header is slightly taller than the Codex reference. This is an existing brand-layout choice outside the requested navigation rows.

final result: passed

---

# Conversation running, unread, and delete-state design QA

- Source visual truth: `/var/folders/_l/t1lk7m411953763qdprx0qn00000gp/T/codex-clipboard-e164b6d7-02dd-479a-9dd4-155f397754f3.png`
- Implementation screenshot: `/Users/hongbin9/.codex/visualizations/2026/07/17/019f6ec6-1c9d-7f43-9ee9-936f85421c19/conversation-running-row.png`
- Combined comparison: `/Users/hongbin9/.codex/visualizations/2026/07/17/019f6ec6-1c9d-7f43-9ee9-936f85421c19/conversation-running-comparison.png`
- Viewport: 1280 x 720 browser capture; focused implementation row 338 x 42 px
- State: light theme, selected conversation running, adjacent unread conversation available in the same rendered preview

## Full-view comparison evidence

The rendered sidebar keeps the existing FreeBuddy list density, avatar identity, and neutral selected-row surface. The former leading green status dot is gone, so running and non-running titles retain one stable left baseline. Running state occupies the same fixed 24 px trailing slot previously used by delete.

## Focused region comparison evidence

The side-by-side crop shows the reference on the left and the rendered implementation on the right. Both use a quiet neutral selected surface and a gray open-circle loading glyph at the far-right edge. FreeBuddy intentionally retains its existing agent avatar and 38 px compact row height because the requested change concerns the trailing state slot rather than the list's established identity and density.

## Required fidelity surfaces

- Fonts and typography: The existing FreeBuddy 13 px conversation-title treatment is retained. The title remains vertically centered, truncates safely, and no longer changes to green when selected.
- Spacing and layout rhythm: The tail slot is fixed at 24 x 24 px. Loading, unread, and delete states occupy exactly the same coordinates, preventing title movement between states.
- Colors and visual tokens: Loading uses the existing tertiary text token, unread uses the existing brand-green token, and selection uses the existing neutral hover surface. The loading state no longer competes with the title.
- Image quality and asset fidelity: The loading and delete controls use the installed Lucide icon system. No raster replacement, handcrafted SVG, CSS icon drawing, or placeholder asset is used.
- Copy and content: Existing conversation titles and localization are unchanged. New accessible labels are localized as `未读会话` / `Unread conversation`; running labels reuse the established Agent and workflow strings.

## Findings

No actionable P0, P1, or P2 mismatch remains for the requested trailing-state behavior.

## Comparison history

1. The original implementation placed a glowing green indicator before the avatar, shifting every running title and leaving delete available in a separate trailing region.
2. The leading indicator was removed and replaced by one stable trailing state slot.
3. The first focused comparison showed the correct glyph placement but used an unselected white row. The QA preview was revised to the selected running state from the reference.
4. The final combined comparison confirms the neutral selected surface, right-edge loading glyph, stable title alignment, and retained FreeBuddy avatar treatment.

## Primary interactions tested

- Running row rendered one loading status and zero delete buttons; browser console errors: none.
- Unread row rendered one brand-green status dot.
- Opening the unread row removed the green dot and made that conversation active.
- Keyboard focus revealed the same delete control used by hover. Hover replacement selectors are covered by the automated UI contract test.
- Reduced-motion users receive a static loading glyph instead of continuous rotation.

## Follow-up polish

- P3: The live spinner's visible gap naturally rotates, so a still screenshot may show a different gap angle than the reference while preserving the same open-circle form.

final result: passed

---

# Skills management split-view and ZIP import design QA

- Source visual truth: `/Users/hongbin9/.codex/generated_images/019f659f-9780-73f0-ad93-8f4707ffdf1f/exec-0baa74a1-b75c-40e0-a6c0-75d8e6d004cf.png`
- Implementation screenshot: `/private/tmp/freebuddy-skills-settings-final.png`
- Full-view comparison evidence: `/private/tmp/freebuddy-design-qa/compare.html`
- Focused comparison evidence: `/private/tmp/freebuddy-design-qa/focus.html`
- Viewport: 1584 x 1128
- State: light theme, Skills settings, import menu open; browser preview uses the Electron-unavailable empty state while the source shows populated Skills

## Full-view comparison evidence

The combined comparison confirms the selected option's defining composition in the rendered app: the existing Settings shell is preserved, search and status filtering form one compact toolbar, the import action opens a two-choice popover, and the management surface uses a stable list/detail split. The implementation intentionally shows the real browser-preview empty state because the local Skill catalog is exposed only by the Electron preload bridge.

## Focused region comparison evidence

The focused comparison checks the header, toolbar, import controls, table header, split-pane boundary, radii, borders, and vertical rhythm at the same viewport. It also exposed an initial toolbar defect: the generic Settings label rule forced the search field into a column and made it 55 px high. The search field now overrides that rule explicitly and renders as a 36 px horizontal control, matching the selected design's compact density.

## Required fidelity surfaces

- Fonts and typography: The existing FreeBuddy font stack and optical weights are retained. The page title, row names, metadata, tabs, and rendered SKILL.md use distinct 16/12/11/10 px hierarchy levels comparable to the source.
- Spacing and layout rhythm: Header, 36 px toolbar controls, 64 px list rows, 34/66% split pane, 10 px surface radius, and compact popover spacing match the source's dense settings treatment without reintroducing oversized controls.
- Colors and visual tokens: Brand green, soft selected-row tint, borders, panel surfaces, text hierarchy, warning, and danger states map exclusively to existing FreeBuddy tokens.
- Image quality and asset fidelity: This screen needs no raster imagery. Folder, archive, search, chevron, toggle-adjacent, overflow, reveal, and delete affordances use the installed Lucide icon system.
- Copy and content: Folder and `.zip` import are clearly distinguished, with concise format hints. Status, source, metadata, empty state, and action labels are localized in Chinese and English.

## Findings

No actionable P0, P1, or P2 visual, layout, accessibility, or interaction differences remain for the available browser-rendered state.

## Comparison history

1. Initial browser capture showed the search label inheriting `flex-direction: column`, producing a 55 px control with the icon above its text.
2. The Skills-specific selector now forces a horizontal row and removes inherited input padding; the revised measurement is 320 x 36 px.
3. The final full-view and focused comparisons confirm the compact toolbar, import popover, and split-pane proportions remain aligned after the fix.

## Primary interactions tested

- Opened Skills from Settings.
- Opened the Import Skill menu and confirmed both folder and `.zip` choices are visible with distinct icons and hints.
- Entered a search query and changed the status filter, then returned both controls to their default state.
- Confirmed the empty list/detail state stays within the viewport without clipping persistent Settings controls.
- Checked browser console warnings and errors: none.
- ZIP extraction is covered by automated normal-package and path-traversal rejection tests; native folder/file dialogs remain Electron-only and cannot open in the browser preview.

## Follow-up polish

- P3: The populated detail state cannot be captured from the browser preview because it has no Electron Skill bridge. The desktop path, markdown preview, metadata, enable toggles, reveal action, and delete action are covered by the typed bridge and automated contracts.

final result: passed

---

# Composer attachment and Skill menu design QA

- Source visual truth: `/var/folders/_l/t1lk7m411953763qdprx0qn00000gp/T/codex-clipboard-e41c0bd9-ed42-490c-adf8-50bcbd768ae8.png`
- User sizing feedback: `/var/folders/_l/t1lk7m411953763qdprx0qn00000gp/T/codex-clipboard-dc4710c0-5a28-43b5-982e-557ffc0c5bbf.png`
- Implementation screenshot: `/tmp/freebuddy-composer-menu-qa.png`
- Combined comparison: `/tmp/freebuddy-composer-menu-comparison.png`
- Viewport: 1560 x 1065
- State: light theme, new-task page, add menu and Skill submenu open, no enabled Skills in browser preview

## Full-view comparison evidence

The combined comparison shows that FreeBuddy now follows the reference interaction model without copying unrelated product chrome: one compact add trigger sits at the left edge of the composer toolbar, the first panel contains file and Skill actions, and the Skill choices open in an adjacent second panel. The surrounding FreeBuddy agent, permission, workspace, mode, and send controls remain in their established positions.

## Focused region comparison evidence

The composer region confirms the post-feedback trigger is 30 x 30 px with a 16 px icon, matching the visual height of the adjacent toolbar pills. The initial 34 px version was optically dominant; the revised trigger now reads as a peer control. The 224 px primary menu and 292 px Skill panel retain clear hierarchy and do not clip the composer or send action.

## Required fidelity surfaces

- Fonts and typography: Existing FreeBuddy font tokens are retained. Menu rows and Skill labels use 14 px medium text; the Skill panel heading uses the existing compact 12 px UI scale.
- Spacing and layout rhythm: The trigger matches the 30 px toolbar controls. Menu rows are 44 px high, panels use 6 px internal padding and an 8 px inter-panel gap, and both panels share a 12 px radius.
- Colors and visual tokens: Surfaces, borders, hover states, shadows, focus rings, and disabled states use existing FreeBuddy theme tokens. Light and dark themes were both checked.
- Image quality and asset fidelity: No raster assets are required. Add, upload, Skill, and chevron affordances use the project's installed Lucide icon system.
- Copy and content: The primary actions are localized as `添加文件` and `技能（已选/总数）`; English equivalents are present. The Skill panel preserves the existing localized empty state.

## Findings

No actionable P0, P1, or P2 differences remain for the requested attachment and Skill consolidation.

## Comparison history

1. The original composer exposed attachment and Skill as two separate toolbar chips.
2. They were consolidated behind one add trigger with a two-panel interaction matching the reference structure.
3. User feedback identified the initial 34 px trigger as visually oversized relative to adjacent controls.
4. The trigger was reduced to 30 px and its icon to 16 px. The revised 1560 x 1065 capture confirms the toolbar hierarchy is balanced.

## Primary interactions tested

- Opened and closed the add menu.
- Opened the Skill submenu from the primary menu.
- Closed the complete menu stack with Escape and returned focus to the trigger.
- Confirmed the menu remains readable and interactive in dark theme.
- Checked browser console errors: none.
- Native attachment selection remains wired to the existing Electron handler and is covered by the integration suite; the browser preview cannot open the Electron file dialog.

## Follow-up polish

- P3: The browser preview has no enabled Skills, so the populated-list visual state was not available for screenshot comparison. Checkbox selection, selected/total counts, and independent disabled states are covered by the component contract tests.

final result: passed

---

# Scheduled-task list density design QA

- Source visual truth: `/var/folders/_l/t1lk7m411953763qdprx0qn00000gp/T/codex-clipboard-9db1085d-57dc-4d9d-948c-ef933ca25176.png`
- Implementation screenshot: `/tmp/freebuddy-scheduled-tasks-compact-1992x1208.png`
- Viewport: 1992 x 1208
- State: light theme, scheduled-task list, one enabled completed daily task

## Full-view comparison evidence

The implementation keeps the existing FreeBuddy shell and scheduled-task controls while removing the duplicate in-page title and full-width operational banner. The operational note and create action now share one quiet toolbar row.

## Focused region comparison evidence

The reference task content was replayed in a temporary local QA state and removed after capture. The task card now presents one clear scan path: title and status, schedule and next run, muted execution settings, then actions. When the prompt matches the title, the duplicate prompt panel is omitted.

## Required fidelity surfaces

- Fonts and typography: Existing FreeBuddy font and text tokens are retained. Task title remains the strongest card text; status and metadata are reduced to secondary and tertiary weights.
- Spacing and layout rhythm: Card padding is 12 x 14 px, internal gaps are 6–8 px, and the action footer is 26 px high. The same reference task now occupies substantially less vertical space without reducing the primary hit targets below the existing compact control scale.
- Colors and visual tokens: All colors use existing brand, panel, border, text, and danger tokens. No new accent or surface treatment is introduced.
- Icon fidelity: Existing Lucide icons are preserved for schedule, agent, conversation mode, workspace, actions, status, and toggle affordances.
- Copy and content: The running note is shortened. The full workspace path remains available as a title while only its basename is visible in the card.

## Findings

No actionable P0, P1, or P2 density, hierarchy, overflow, or interaction issues remain for the requested list state.

## Comparison history

1. The original card repeated the task title as a prompt block and rendered schedule, agent, execution mode, workspace, and next run as five equal-weight chips.
2. The page header and operational banner were merged; schedule and next run became the primary metadata row; configuration details became quiet inline metadata.
3. A 1992 x 1208 capture with the same task content confirmed the card, toolbar, toggle, and action groups remain within bounds. Browser console errors: none.

## Primary interactions checked

- Prompt preview is omitted only when its trimmed text equals the trimmed title; differing prompts remain expandable with `aria-expanded` state.
- Enable toggle, run now, open result, history, edit, and delete controls remain present and accessible.
- Long workspace paths truncate to the last directory name and retain the complete path on hover.

final result: passed

---

# New-task workspace chip design QA

- Source visual truth: `/var/folders/_l/t1lk7m411953763qdprx0qn00000gp/T/codex-clipboard-cc0b7677-ea6e-45eb-b75d-bfabfba31e6a.png`
- Implementation screenshot: `/tmp/freebuddy-workspace-chip-selected.png`
- Combined comparison: `/tmp/freebuddy-workspace-chip-comparison.png`
- Viewport: 1280 x 720
- State: light theme, new-task page, selected workspace `/Users/hongbin9/Documents/freebuddy`

## Full-view comparison evidence

The implementation screenshot shows the selected project chip in the existing composer toolbar position, between the attachment action and send-side controls. The textarea height, toolbar alignment, and surrounding controls remain stable.

## Focused region comparison evidence

The normalized side-by-side crop compares the selected project chip directly. Both use a soft neutral capsule, a filled circular remove action, and a single project-name label without exposing the absolute path.

## Required fidelity surfaces

- Fonts and typography: The project name uses the existing FreeBuddy font stack at 14px and weight 500, matching the reference's restrained label hierarchy.
- Spacing and layout rhythm: The chip is 32px high with a 22px circular remove action and compact horizontal padding. It remains in the original toolbar slot as requested.
- Colors and visual tokens: Reference grays are mapped to `--fb-panel-soft`, `--fb-text-secondary`, and `--fb-panel-bg`; no new accent color is introduced.
- Image quality and asset fidelity: No raster asset is required. The remove action uses the installed Lucide `X` icon rather than a text glyph or handcrafted icon.
- Copy and content: Only the basename (`freebuddy`) is visible. The full path remains available as a title, and the change/remove actions use localized labels.

## Findings

No actionable P0, P1, or P2 differences remain for the selected-workspace control.

## Comparison history

1. The earlier implementation displayed a folder button beside an editable absolute-path field, which created excessive toolbar density.
2. The selected state was replaced with a compact removable project chip while keeping the control in its original toolbar position.
3. The focused comparison confirms equivalent capsule proportions, remove affordance, project-name emphasis, and path omission.

## Primary interactions tested

- Confirmed the selected path renders as `freebuddy` rather than the absolute path.
- Activated the remove action and confirmed the chip returns to the `工作目录` picker button.
- Checked browser console errors: none.

## Follow-up polish

- P3: FreeBuddy's existing slate-neutral token is slightly cooler than the reference gray; this is an intentional design-system mapping.

final result: passed

---

# Plugin marketplace filter design QA

- Source visual truth: `/var/folders/_l/t1lk7m411953763qdprx0qn00000gp/T/codex-clipboard-6cd7d4ef-867d-4147-a779-287774fe96dd.png`
- Implementation screenshot: `/Users/hongbin9/.codex/visualizations/2026/07/22/019f8929-c5ad-73d3-9f20-fc5474e699e8/plugin-marketplace-filter-all.png`
- Initial selected-market screenshot: `/Users/hongbin9/.codex/visualizations/2026/07/22/019f8929-c5ad-73d3-9f20-fc5474e699e8/plugin-marketplace-filter-selected-before-polish.png`
- Responsive screenshot: `/Users/hongbin9/.codex/visualizations/2026/07/22/019f8929-c5ad-73d3-9f20-fc5474e699e8/plugin-marketplace-filter-narrow.png`
- Source pixels: 2048 × 1343 (Retina-density desktop capture, normalized to approximately 1024 × 672 CSS px)
- Implementation pixels and viewport: 1024 × 672 at device scale factor 1
- Responsive viewport: 820 × 700 at device scale factor 1
- State: light theme, Codex, installed plugins, all marketplaces selected; focused checks also covered `openai-curated` and `chatgpt-global` selected states

## Full-view comparison evidence

The source and implementation were inspected together after normalizing the source's Retina density. The page frame, two-column workspace, toolbar, cards, typography scale, border radii, and neutral/green token usage remain consistent with the existing screen. The intentional differences are the new “All marketplaces” row, per-source counts, selected-state treatment, and the system-managed `chatgpt-global` source.

## Focused region comparison evidence

The marketplace rail and catalog toolbar were checked at the normalized desktop viewport. Selecting `openai-curated` changed the view counts to 3 installed and 0 available and showed only its three plugins. Selecting `chatgpt-global` changed the counts to 1 installed and 0 available and isolated Product Design v0.1.47. Search and installed/available remain downstream filters over the selected marketplace.

## Required fidelity surfaces

- Fonts and typography: inherited existing FreeBuddy type tokens, weights, sizes, truncation, and two-line marketplace hierarchy.
- Spacing and layout rhythm: retained the existing workspace proportions and card spacing; the market rows gained a compact 42px target and responsive stacked layout.
- Colors and visual tokens: selected, hover, focus, border, surface, and count states use existing `--fb-*` tokens.
- Image quality and assets: production plugin artwork still uses the existing manifest icons and fallback icon path; the QA fixture intentionally exercised the existing fallback.
- Copy and content: added localized labels for all marketplaces, managed sources, and the marketplace filter group in English and Simplified Chinese.

## Interaction and accessibility checks

- Marketplace filters are native buttons with `aria-pressed` state and a labelled group.
- Focus-visible treatment is present and selection is communicated by border, inset marker, surface, and pressed state rather than color alone.
- Configured-market update/remove controls remain separate from the filter button; managed-only sources do not expose invalid destructive actions.
- Browser console warnings/errors checked: none.

## Comparison history

1. Initial selected-market capture showed the destructive marketplace action persistently beside the selected filter (P2 distraction and misclick risk).
2. Fixed by hiding marketplace actions until hover or keyboard focus while keeping the filter count visible.
3. Post-fix all-market and responsive captures show the destructive controls removed from the resting state with no layout regression.

## Remaining polish

- P3: long marketplace names can truncate at the 1024px desktop viewport; the leading unique text and full source tooltip remain available, while the stacked responsive layout exposes more width.

final result: passed
---

# ButlerBuddy header controls design QA

- Source visual truth: `C:\Users\Morefine\.codex\visualizations\2026\08\06\019fd7a2-e8bc-7e13-bc5c-b112b2aaf36d\butler-header\reference.png`
- Browser-rendered implementation screenshot: `C:\Users\Morefine\.codex\visualizations\2026\08\06\019fd7a2-e8bc-7e13-bc5c-b112b2aaf36d\butler-header\implementation.png`
- Viewport: implementation captured at 360 x 420 px; production chat surface is 360 x 420 CSS px
- Density normalization: source is 433 x 525 px from a Windows 125% desktop capture, approximately 346 x 420 CSS px; implementation is 360 x 420 px at 1x. The focused header regions were compared at their equivalent CSS scale.
- State: light theme, ButlerBuddy chat open. The source is an empty conversation; the browser preview contains two sample messages. Conversation content differs intentionally and is outside this header-only change.

## Full-view comparison evidence

Both artifacts preserve the same compact white floating surface, 48 px header rhythm, left brand identity, right model control, new-conversation action, close action, and bottom composer. The implementation keeps all body and composer styling unchanged while restructuring only the header controls requested by the user.

## Focused region comparison evidence

The source and implementation were opened together in one comparison input. Post-fix browser measurements show the brand image, title, online dot, model control, new-conversation button, divider, and close button all share an exact vertical center at 32.4 px. Model text is constrained to a 104 px control with ellipsis, and both icon buttons use 30 x 30 px hit areas. The new-conversation glyph is the installed Lucide `MessageCirclePlus` icon.

## Required fidelity surfaces

- Fonts and typography: existing FreeBuddy font stack is preserved; ButlerBuddy remains 13 px / 700, while the model label stays at the compact 11.5 px UI scale with single-line truncation.
- Spacing and layout rhythm: brand and actions are now explicit flex groups; controls share one baseline, 4 px tool gaps, a quiet 18 px divider, and consistent 30 px control height.
- Colors and visual tokens: existing primary, secondary, tertiary, hover, border, and brand-green tokens remain unchanged.
- Image quality and asset fidelity: the supplied ButlerBuddy raster asset is unchanged; the requested new-conversation affordance uses the project's installed Lucide icon library rather than a custom drawing.
- Copy and content: `ButlerBuddy`, the selected model label, `新会话`, and close semantics are unchanged. Long model labels truncate instead of pushing adjacent actions.

## Findings

No actionable P0, P1, or P2 header mismatch remains.

## Comparison history

1. The supplied source exposed a P2 hierarchy problem: brand, model, new-conversation, and close elements were independent siblings with mixed 26/30 px heights and no separation between creation and dismissal actions.
2. The header was split into stable brand and control groups; model and action heights were normalized; model width was bounded; a light divider was added before close; `SquarePen` was replaced by `MessageCirclePlus`.
3. Post-fix evidence confirms every visible header element shares the same 32.4 px centerline and the right-side tools remain inside the 360 px viewport without overlap.

## Primary interactions tested

- Confirmed the new-conversation and close actions remain native buttons with accessible names and 30 x 30 px hit areas.
- Confirmed long model content is constrained by the fixed-width picker and ellipsis rules.
- Checked the browser-rendered surface for console warnings and errors: none.
- Type checking and the ButlerBuddy contract suite cover the retained new-conversation handler and model picker wiring.

## Follow-up polish

- P3: The model picker is a non-interactive fallback in the browser preview because live options come from the Electron adapter bridge; the production desktop picker retains its existing interaction.

final result: passed

---

# ButlerBuddy arcade compact-hierarchy correction design QA

- User-reported implementation screenshot: `/Users/hongbin9/Documents/freebuddy/artifacts/product-design/butlerbuddy-arcade-audit/01-before.png`
- Revised stable Boss screenshot: `/Users/hongbin9/Documents/freebuddy/artifacts/product-design/butlerbuddy-arcade-audit/04-boss-stable-after.png`
- Combined same-size comparison: `/Users/hongbin9/Documents/freebuddy/artifacts/product-design/butlerbuddy-arcade-audit/05-before-after.png`
- Viewport: 360 x 300 CSS px; the 720 x 600 Retina source was normalized to 360 x 300 before comparison
- State: light theme, Boss phase, weak points and moving balls visible

## Comparison evidence

The user screenshot and revised implementation were inspected together at the same aspect ratio and scale. The earlier composition placed the saturated fever fill, oversized Boss, foreground balls, oversized ultimate ring, and pet on one vertical axis. The revised composition uses a quiet white fever capsule with a thin progress edge, a smaller elevated Boss, balls behind the Boss, and a smaller bottom-anchored pet/ultimate unit with visible separation between the two characters.

## Required fidelity surfaces

- Typography and HUD: score, fever, countdown, boss label, and health remain legible while using less height and lower saturation.
- Layout rhythm: the Boss ends above the pet/ultimate region instead of intersecting it; the playfield regains negative space.
- Layering: moving balls no longer cover the Boss face or obscure weak-point state.
- Background treatment: increased opacity and blur suppress underlying desktop text and dividers without making the surface fully opaque.
- Asset fidelity: the existing generated transparent Boss and orb assets are retained without distortion.

## Findings

No actionable P0, P1, or P2 crowding, overlap, or hierarchy issue remains in the revised Boss state.

## Interaction checks

- Hunt and Boss phases rendered at the production 360 x 300 CSS viewport.
- Ball movement, chain feedback, weak points, ultimate region, countdown, and close control remained present after the layout change.
- Browser console warnings/errors: none.
- Automated physics and interaction contracts remain green.

## Comparison history

1. User capture identified the oversized, center-stacked composition as visually uncomfortable.
2. HUD, Boss, moving targets, pet, ultimate ring, and backdrop were compacted as one hierarchy pass.
3. The final same-size comparison confirms the characters no longer collide and moving targets no longer obscure the Boss face.

final result: passed

---

# 会话任务面板视觉与交互验收

日期：2026-10-05

final result: passed

当前没有未解决的 P0 / P1 / P2 视觉或核心交互问题。残余差异为既有产品约束和 P3 样式细节，列于下文。

## 比较目标与证据

- 原始需求参考：`/var/folders/5t/jv509wn1335b48c6gfk67f4w0000gn/T/codex-clipboard-e41af522-3e5f-4d1d-837f-9f1fa55e3221.png`。采用用户修正后的范围：一张卡片对应一个会话，支持列表切换与全屏。
- 选定视觉目标：`artifacts/product-design/multi-agent-activity-view/conversation-task-panel-fullscreen.png`。
- 最终实现截图：`artifacts/product-design/multi-agent-activity-view/implementation-final.jpg`。
- 全屏合并比较：`artifacts/product-design/multi-agent-activity-view/comparison-final.jpg`。源图与最终实现放在同一张图中比较，左侧为参考，右侧为实现。
- 首张卡片合并比较：`artifacts/product-design/multi-agent-activity-view/comparison-card-final.jpg`。检查标题、身份行、状态、活动与页脚的字号、位置和清晰度。
- 交互预览：<http://127.0.0.1:5173/artifacts/product-design/multi-agent-activity-view/preview.html>。预览导入实际 App 和生产组件；桥接层使用内存演示数据，不启动真实 Agent，不写真实会话数据库。

源图像素为 1487 × 1058，最终实现为 1488 × 1056。比较图将源图轻微缩放到 1488 × 1056，未裁切内容；两侧各加 36px 标题区，合并图为 2976 × 1092。浏览器 CSS 视口为 1488 × 1056，density / deviceScaleFactor 为 1。以上像素归一化不会改变布局判断。

比较状态：浅色、任务面板全屏、全部项目、空搜索、全部筛选、六个会话、两个执行中、一个需关注、两个未读。参考以示意文案表达状态，实现使用真实状态语义；例如正在执行的未读消息显示“未读”，本轮结束显示“本轮完成”。

## 五项视觉检查

| 检查面 | 观察与结论 |
| --- | --- |
| 字体与层级 | 沿用现有 `--fb-font` 字体栈。最终桌面标题 26px / 750，活动 18px / 1.5，身份 16px，模型与项目 14px，状态 13px，页脚 14px。较参考约 28px / 20px 略小、较轻，标题仍优先于身份与活动，中文行高清楚。长标题最多两行、活动单行省略，模型与项目不会挤占状态。残余字重差异记为 P3。 |
| 间距与布局 | 24px 页面与卡片留白、16px 网格间距、16px 圆角。桌面三列，身份行右侧显示状态；窄卡将状态换至下一行。卡片统一最小高度 426px，参考第二行约 389px；统一高度使页脚位置稳定，内容区可纵向滚动，全部操作可达。800px 两列、390px 一列，没有横向溢出或工具栏遮挡。 |
| 颜色与变量 | 复用 FreeBuddy 品牌绿、背景、文字、边框和语义色。运行蓝、待确认黄、完成绿、未读红，状态同时包含图标和文字。实际主题的颜色比示意图更柔和，遵循现有产品变量，深色截图中卡片背景为 rgb(17, 27, 45)。 |
| 图像与图标 | 复用现有 FreeBuddy、Codex、Claude、Kimi 品牌图像和 AgentAvatar，无占位头像或手绘品牌替代。图像比例、裁切与边缘清楚。通用操作和状态使用项目现有图标库；轮廓状态图标与参考实心图标有 P3 差异。 |
| 文案与内容 | 会话标题为首要信息，Agent / 实际模型 / 项目为身份信息。保留生产适配器名称 ClaudeCode、Kimi；无证据时不伪造模型。完成为“本轮完成”，避免暗示整个会话永久结束。活动取结构化工具记录；没有工具活动则显示最后回复摘要。待确认提供“查看请求”，文件编辑可进入真实 Diff。 |

## 比较与修正历史

1. 首轮 `comparison-01.jpg` 暴露卡片正文与身份文字偏小、状态独立占行的问题。该实现截图只有 1488 × 931，不作为完整全屏验收证据；另一次 `implementation-fullpage-01.jpg` 捕获到了恢复侧栏状态，也不作为全屏证据。修正截图方法后取得 `implementation-fullscreen-02.jpg`。
2. 第二轮修正标题、活动、身份、状态和页脚字号，将桌面状态移至身份行右侧，调整卡片高度为 426px，统一筛选控件高度和内容间距。修正后的完整证据为 `implementation-fullscreen-03.jpg`、`comparison-03.jpg`、`comparison-card-03.jpg`，前述 P2 层级和布局差异消除。
3. 最终浏览器验收确认列表返回、消息定位和 Diff 跳转；补齐演示桥接层需要的设置接口。重新采集 `implementation-final.jpg`，将其与源图并排查看，并检查 `comparison-card-final.jpg` 的细节。最终没有需要继续修正的 P0 / P1 / P2。

## 交互与状态验证

- 点击“列表”：退出面板全屏，恢复原侧边栏及上次 README 会话；只清除进入正文的会话未读，其他未读保留。
- 侧栏再次进入面板；卡片打开会话后返回，README 搜索条件保留。项目筛选得到三条 freebuddy 会话，执行中筛选得到两条。
- 卡片重命名保存后标题更新；正在执行和待处理会话的归档 / 删除禁用。
- Escape 先关闭卡片菜单，再退出面板全屏，恢复侧栏。全屏保存和恢复进入前状态，异步进入 / 退出竞争由原生控制器测试覆盖。
- 点击读取活动 `site/main.js` 定位并聚焦来源消息 `release-reply`；点击编辑活动 `electron-builder.yml` 打开实际 FileDiff，展示 +1 变更。
- 新会话入口打开原有新会话编辑器。
- `implementation-list-return.jpg`、`implementation-file-diff.jpg` 保存上述关键返回和文件操作状态。
- `implementation-800.jpg`：800 × 900，两列；`implementation-390.jpg`：390 × 844，一列。390px 工具栏控件右边界均在视口内，无横向滚动。
- `implementation-dark.jpg` 验证深色变量与状态可辨识。
- 控件使用语义按钮 / 输入 / 选择框、可见焦点样式；动画遵循 reduced-motion。源码和组件测试覆盖加载、未知、失败后重试、无工具活动、批量摘要和事件更新。没有对这些所有状态逐一截图，亦未执行完整屏幕阅读器审计。

最后一次干净浏览器检查从 `2026-10-05T13:25:00.935Z` 开始，记录见 `artifacts/product-design/multi-agent-activity-view/browser-qa.json`：0 个控制台错误、0 个警告。

## 工程验证与边界

- `npm run typecheck`：通过。
- `npm run build:renderer`：通过，保留既有大 chunk 提示。
- `npm test`：通过。Node 1492 条、Electron 数据库 173 条、文件编辑数据库 9 条，共 1674 条通过、175 条条件跳过、0 条失败。跳过包括 Node 原生 ABI 与平台限制；Electron 单独执行了数据库用例。
- 42 条面板、导航、未读、窗口存在状态等定向检查通过；原生全屏队列包含 6 条事件与竞态测试。
- `git diff --check`：通过。
- 真实 Electron/macOS 全屏动画没有人工界面验收。浏览器使用模拟原生桥接验证 App 流程，原生事件、恢复队列、超时和迟到事件以测试覆盖。真实 Agent 执行未在演示预览中启动；摘要权限、数据库和远程入口由测试验证。

## P3 后续细节

- `.ctp-status` 与活动图标可进一步接近参考的实心光学重量；目前沿用现有图标族，保持跨页面一致。
- `.ctp-card-title`、活动与页脚可按用户偏好增加 1–2px 或略加字重；当前大小已保持清晰层级和窄屏可用性。
- 空闲卡片摘要保持一个回复区，卡片高度统一；若希望增加首屏密度，可另行调整空闲卡片留白。

## 实施核对

- [x] 一张卡片对应一个会话，共享现有标题、可见性与操作规则。
- [x] 列表 / 面板切换，返回原侧边栏与上次对话。
- [x] 全屏、Escape 层级、进入前窗口状态恢复。
- [x] 搜索、项目 / 状态 / 未读筛选及返回状态保持。
- [x] 轻量概览、实际模型、真实活动和问题入口。
- [x] 面板浏览保留未读，正文阅读才按原规则处理。
- [x] 文件 Diff 与来源消息定位。
- [x] 桌面 / 窄屏 / 深色及控制台检查。
- [x] 修正后完整与局部视觉比较通过。

---

# 会话任务面板：按 ChatView 对齐字体

日期：2026-10-05。此补充依据用户最新反馈，替代上一轮以生成示意图的大字号为目标的排版与字号 P3 建议；其余功能和既有验收记录保留。

final result: passed

## 本轮问题与修正

- [P2，已修复] 面板正文与 ChatView 字体体系不一致。原桌面活动为 18px、窄卡 16px，标题为 26px、窄卡 23px / 750；用户要求采用现有 ChatView 的日常阅读尺度。活动、回复摘要、待确认文案和空状态现采用 `--fb-chat-font / 14px / 22px / 400`，与实际 ChatView 的 `.markdown-body`、`.stream-text` 浏览器计算样式完全一致。
- [P2，已修复] 缩小字号后需要同步修正空间比例。卡片标题采用 15px / 600 / 22px，主标题 16px / 600；身份与控件 13px，模型、项目、状态和页脚 12px。卡片留白改为 18px / 20px，活动间距 8px，最小高度 310px。品牌名称与现有侧栏一致，为 Outfit / 18px / 700 / 22px；头像缩为 28px，品牌图标缩为 36px。操作保留 32–36px 点击区域。
- [P2，已修复] 原字体 reset 的选择器优先级会覆盖标题的显式行高。改为 `.conversation-task-panel :where(button, input, select)`，标题的 22px 行高现正常生效；窄卡和窄窗口不再额外放大文字。

仅修改 `src/components/CLI/ConversationTaskPanel.css` 中的字体、配套间距、图像显示尺寸和控件尺寸。

## 视觉目标与比较证据

- 本轮字体真值：现有 `styles.css` 中 ChatView `.markdown-body` / `.stream-text`、标题栏与侧栏品牌字体；实际截图 `artifacts/product-design/multi-agent-activity-view/typography-chatview-reference.jpg`，计算样式 `typography-chatview-styles.json`。
- 改前截图：`artifacts/product-design/multi-agent-activity-view/typography-before.jpg`。
- 改后截图：`artifacts/product-design/multi-agent-activity-view/typography-after.jpg`。普通模式截图 `typography-inline-panel.jpg` 为恢复默认视口后的 980 × 823 像素，展示与既有侧栏共同出现时的排版尺度；等待卡片可见后重新采集，已确认内容为面板。
- 全视图并排比较：`typography-comparison-full.jpg`，左侧改前、右侧改后，均为 1280 × 720 CSS px、浅色、全屏、全部项目、空搜索、六个会话、两个执行中、一个需关注、两个未读。相对更新时间自然前进约一分钟，不影响排版比较。
- 卡片局部并排比较：`typography-comparison-card.jpg`，两侧以相同像素尺度展示第一张卡片，检查标题、身份行、活动、未读和页脚。
- 字体局部并排比较：`typography-comparison-body.jpg`，将实际 ChatView 正文与改后活动正文放在同一张图中，以 1:1 截图尺度检查字体与字号；不同页面内容和行间分组不作为逐像素布局匹配目标。

ChatView 真值、改前与改后完整截图均为 1280 × 720 像素。浏览器报告 devicePixelRatio 为 2，截图 API 输出为每 CSS px 一像素；比较时未额外放大或缩小。全视图合并加入 24px 间隔和 28px 标签区。聚焦比较保持原像素尺寸，只裁切对应内容。

## 五项视觉检查

- 字体：ChatView 与面板正文计算出的 family、14px、22px、400 完全一致；UI 控件和标题继续使用产品 `--fb-font`，对应 ChatView 标题栏的 UI 字体。标题保持一至两行，活动单行省略。默认、800px 和 390px 宽度都采用 15px 卡片标题、14px 正文。
- 间距：字号缩小后卡片内容与身份区域同步收紧；页脚位置保持稳定。三列、两列、一列网格切换正常，窄屏无横向溢出，搜索、筛选、全屏及列表操作均可见。
- 颜色：现有文字、品牌、背景和状态变量保留。活动的次要文字颜色、运行蓝、待确认黄、完成绿仍可辨识；文字层级调整未引入新色板。
- 图像：保留现有 FreeBuddy 与 Agent 原始资产，无新绘制或替代图像；缩小显示尺寸后边缘清晰，比例与裁切正常。活动图标统一为 16px，与正文尺度相配。
- 文案：标题、实际模型、项目、状态、活动和操作文案未变，卡片仍优先呈现任务标题；所有操作含义保持清楚。

## 验证与最终结果

- `typography-800.jpg`：800 × 900，双列，无横向溢出。
- `typography-390.jpg`：390 × 844，单列，无横向溢出；顶部按钮右边界最大 374px，全部在视口内，点击区域高 32–36px。
- 点击“列表”恢复上次 README 会话与原侧栏；再次点击侧栏“任务面板”正常返回。
- 浏览器错误和警告为 0，记录于 `typography-browser-qa.json`；最终计算样式见 `typography-after-styles.json` 与 `typography-narrow-styles.json`。
- `npm run build:renderer` 通过；保留既有大 chunk 构建提示。此次为纯 CSS 修改，未重复运行上一轮完整功能测试。
- `git diff --check` 通过。没有剩余 P0 / P1 / P2。原生全屏动画的上一轮验证边界仍适用；本次未改动原生窗口实现。
- 可保留的 P3：更紧凑的卡片高度可按用户偏好进一步调整；本次已将字号和空间比例对齐现有 ChatView，不再建议向原生成示意图放大文字。

## 实施核对

- [x] ChatView 与面板正文使用相同 family / size / line-height / weight。
- [x] 标题、控件、辅助信息采用现有应用的字体尺度。
- [x] 移除窄屏放大覆盖，修复 reset 行高优先级。
- [x] 截图的完整与局部并排比较通过。
- [x] 800px / 390px 响应式与原列表返回验证通过。
- [x] 浏览器控制台和 renderer 构建检查通过。

---

# 会话任务面板：真实内容密度与层级整理

日期：2026-10-05。依据用户最新截图“怎么感觉乱糟糟的”，本轮检查和修正总览、需关注筛选、原对话详情三个步骤。此前演示图和字号记录保留；本轮以真实内容压力场景的可扫读性为目标。

final result: passed

## 问题与结果

- [P1，已修复] 完整命令、cwd、MCP 工具名挤占活动正文。识别有依据的文件 / 搜索 / 脚本 / 构建 / 协作动作；未知执行使用中性名称，已有简短自然描述保留。文件显示相对路径，原始 filePath、messageId 和调用对象仍用于导航。完成动作去重，最多显示三条；不同运行 / 待执行 / 失败调用不因同名被合并。
- [P2，已修复] 五行灰色回复、Mermaid 与 Markdown 源码抢占视线。正文改为两行纯文本摘要，移除气泡与装饰图标；代码结果只有中性提示，不编造任务成果。长普通回复保留最近内容，长代码保留 opening fence，避免完成后数据库投影截掉 fence 而再次显示中部源码。数学比较符及普通图表名称说明不会被误删。
- [P2，已修复] 长标题 / 身份 / 状态位置和卡片高度不一致。标题统一单行，状态移至首行；完成 / 空闲 / 停止为轻量文字，执行 / 待确认 / 失败保留语义颜色和图标。身份统一 24px 头像和一行信息，卡片最小高度 244px，移除内部横线和阴影，页脚为轻量文本入口。1470px 压力场景首行实际高 256px，由三条活动决定，同一行对齐。

## 来源、尺寸与完整 / 局部比较

- 用户原图 `clarity-user-before.png` 为 2940 × 1912 像素；按 2× 缩小为 `clarity-user-normalized.jpg` 的 1470 × 956，用于对照同一 CSS 尺度。没有重新生成用户截图。
- 本轮在实际 App 和生产组件上使用内存桥接，构造 42 会话 / 0 执行中 / 13 需关注 / 0 未读的压力场景，包含长自然回复、六条 shell 命令、五个 MCP 动作、Mermaid、附件哈希标题。它复现同类内容，未读取或更改用户真实数据库；项目标签与第三行会话内容不要求与用户数据逐字一致。
- `clarity-before.jpg` 和 `clarity-after.jpg` 均为 1470 × 956 CSS px、浅色、全屏、全部项目、空搜索、首批 24 张卡片，使用相同 fixture 输入。浏览器报告 devicePixelRatio 2，截图 API 每 CSS px 输出一像素，未额外缩放。
- `clarity-comparison-full.jpg` 同图并排检查改前 / 改后；`clarity-comparison-user.jpg` 同图检查归一化用户截图 / 实现。比较画布增加 24px 间隔与 32px 标签区。
- `clarity-comparison-card.jpg` 与 `clarity-comparison-actions.jpg` 以 1:1 像素裁切对应卡片：宽 464px，改前高 372px，改后高 256px；改后下方填比较画布背景，不引入下一张卡片。已逐一查看完整与局部合并图，确认标题 / 身份对齐、两行摘要、三条活动、轻量状态和页脚；无需要继续修正的 P0 / P1 / P2。

## 五项视觉检查

- 字体：正文继续 `--fb-chat-font / 14px / 22px / 400`，标题 15px / 600 / 22px，UI 与辅助信息采用既有 12–13px 尺度。800px / 390px 未额外放大字体，摘要计算出的 clamp 为 2。
- 间距：同一行标题和身份起点一致，移除聊天气泡、卡内横线和大按钮。首屏可见第三行待确认卡片；短回复仍保留适量留白，让网格保持稳定。
- 颜色：完成 / 空闲文字使用既有 secondary 变量，无胶囊背景；执行蓝、待确认黄、失败红、未读点保留。深色正文和安静状态为 rgb(203,213,225)，卡片为 rgb(17,27,45)，截图已检查。
- 图像：沿用 FreeBuddy 与 Agent 原始资产，24px 头像比例和边缘正常；没有新绘制或替代图像。
- 文案：真实标题、模型、项目和状态保留；长标题有完整 title 提示和可访问名称。命令按已知动作取短名称，不推断执行成果；详情仍保留原内容。

## 交互、工程检查和边界

- 三步骤审计见 `artifacts/product-design/multi-agent-activity-view/clarity-audit.zh-CN.md`，各步骤已记录原始截图、具体问题与修复后状态。
- 浏览器：需关注筛选 13 张；返回后筛选保持；加载更多由 24 到 42 张；搜索 Markdown 得到两张；work 项目得到 19 张。精简“运行脚本”打开正确对话，可展开六条原始命令；文件编辑打开 electron-builder.yml 的实际 +1 Diff；列表恢复原侧栏与最近签名会话。
- `clarity-800.jpg` 为 800 × 900 双列，`clarity-390.jpg` 为 390 × 844 单列，均无横向溢出，390px 顶部操作右边界最大 374px。`clarity-running.jpg`、`clarity-dark.jpg` 验证自然动作、执行 / 待确认 / 未读与深色。已恢复默认视口并保存 `clarity-default-viewport.jpg`，尺寸 980 × 823，无横向溢出。
- 浏览器干净检查从 2026-10-05T14:47:37.006Z 开始，0 错误、0 警告，见 `clarity-browser-qa.json`。
- 前端 helper / store / 导航 26 条测试通过；Electron 数据库投影 9 条通过，共 35 条通过，0 跳过 / 失败。包含长分块图表完成后投影与显示、普通 prose 最后结果、原始数据库内容不变、路径 / 真实调用对象导航、数学比较和自然语言说明等回归。
- `npm run typecheck`、`npm run build:renderer`、Electron TypeScript 编译与 `git diff --check` 通过。既有 npm sass 配置 / 大 chunk 提示与 Electron 测试 runner 的 macOS codesign 诊断保留，测试退出码为 0。本轮没有重复上一轮全量 1674 条测试。
- 真实 Agent、真实审批处理和 macOS 全屏动画未在内存 fixture 中执行；本轮未修改原生窗口与审批实现。截图与语义控件检查不代表完整屏幕阅读器合规审计。
- P3：用户真实标题中的附件哈希仍保留，只做单行截断；如需自动清理标题，属于另一项标题生成规则调整。辅助时间 / 模型沿用既有三级文字颜色，可后续随全局 token 一并改善。

## 实施核对

- [x] 长命令、MCP、代码和五行回复不再铺满卡片。
- [x] 标题 / 状态 / 身份统一位置，正文三条活动或两行摘要。
- [x] 真实短描述、最新 prose 结果和各调用的导航对象保留。
- [x] 完整与局部比较、深色 / 窄屏 / 详情入口复核通过。
- [x] 35 条定向回归、类型检查、构建和控制台检查通过。

## 发布前完整回归补充

用户已授权提交所有改动并发布新版。发布前完整回归发现摘要语义匹配正则含中文字面量，与仓库的 src 国际化检查冲突；已将匹配字符改为等价 Unicode 正则转义，未改变文案或识别行为。摘要与国际化 21 条定向检查通过。

2026-10-05 的 `npm test` 在系统权限环境中完整通过：Node 1502 条、Electron 数据库 174 条、文件编辑数据库 9 条，共 1685 条通过、176 条条件跳过、0 条失败。沙箱首次运行的本地端口用例失败以系统权限复跑解决；日志保存在 `/private/tmp/freebuddy-release-tests.log`。宣传目录 9 个 JavaScript 文件语法检查及 `git diff --check` 通过。GitHub 系统权限预检确认当前账号和仓库 API 权限有效。


---

# Pi BYOK 图片开关对齐修复（2026-10-07）

## 来源、预览与状态

- Source visual truth: /var/folders/5t/jv509wn1335b48c6gfk67f4w0000gn/T/codex-clipboard-1256912a-2398-4bb6-a1d2-44e62e9fffe4.png；原样副本 artifacts/product-design/pi-byok-alignment/source.png。
- 任务：修复截图中复选框位于“图片”文字上方的错位，沿用现有表单、网格、文案和图标；用户截图作为缺陷证据，不把竖排作为需要保留的设计目标。
- 实现：tests/fixtures/pi-byok-preview.html 使用生产 CLIAdaptersTab 和完整 SettingsPage 外层类名，内存中的单模型自定义 Pi BYOK，API 地址与 Key 后缀均为固定样例，不读写用户真实配置。
- Browser-rendered implementation: artifacts/product-design/pi-byok-alignment/final.jpg；局部截图 final-widget.jpg。
- 源图 1296 × 280 px，按 2× 归一化为 source-normalized.png 的 648 × 140 px。浏览器报告 devicePixelRatio 2；截图 API 每 CSS px 输出一像素，未再放大浏览器截图。
- 同状态全图：before.jpg / after.jpg 均为 1280 × 720 CSS px 与截图像素，浅色、图片未勾选、模型 ID 输入框聚焦。
- 源图同宽对照：1090 × 720 CSS px 视口，source-match-widget.jpg 为 648 × 141 px；源图没有聚焦描边，且裁剪边界没有包含全部说明文字，这些状态/裁剪差异不作为设计偏差。
- 响应式：narrow-dark.jpg 为 800 × 900 CSS px；最终可见预览 final.jpg 为 734 × 823 CSS px，局部截图为 608 × 141 px，图片已勾选并保存。已清除临时视口覆盖。

## 全图和局部比较证据

- comparison-full.jpg 把同视口、同状态的实际设置页改前/改后并排放在同一张图中；页面层级、网格宽度、输入框、删除按钮和其他区块保留，视觉控件不再撑高模型行。
- comparison-source.jpg 把用户截图归一化副本与 648 CSS px 宽的实际模型区放在同一张图中；明确看到复选框从文字上方回到文字左侧，且与输入框、删除按钮垂直居中。
- final-metrics.json：最终窗口中输入框、复选框、图片文字、删除按钮的中心 Y 均为 364.3359375 CSS px，复选框 16 × 16，输入框/删除按钮高 32，无横向溢出。
- narrow-metrics.json：800px 深色窗口中复选框与文字中心 Y 也完全一致，无横向溢出。

## Findings 与比较历史

1. [P2，已修复] 全局 .settings-surface label / .modal label 的选择器优先级高于原 .byok-model-vision，把控件改为 column，同时覆盖局部字号。生产页面复现的 computed flex-direction 为 column；此前只预览模型列表、未包含 SettingsPage 外层，因此遗漏了冲突。
2. 修复：在真实设置页和模态容器下限定 .byok-model-vision 样式，明确 row 和 center；复选框清除通用输入框内边距，并禁止在窄列内压缩。
3. 修复后重新截图并进行上述同图对照：computed flex-direction 为 row，四个控件中心一致；全图与局部比较均无剩余 P0/P1/P2 问题。

## 五项视觉核对

- 字体与排版：保留产品字体和原模型 ID 等宽字体；“图片”恢复原组件 12px 字号与单行显示，未改动全局标签排版。源图和浏览器截图的聚焦描边/光标差异为测试状态差异。
- 间距与布局：保留模型表格列宽、8px 行间距和表单卡片；标签内部 6px 间距，复选框 16px、文字和两侧控件居中。800px 深色及最终 734px 浅色窗口无溢出。
- 颜色与 tokens：沿用现有浅/深色表单、文字、边框和选中颜色，没有新增色值或改变色彩层级。
- 图片与图标：沿用生产 Agent 图标、Lucide 删除/添加图标及原生复选框，无替代图形、图标重画或新增位图资产。
- 文案与内容：模型 ID、显示名称、视觉、图片、添加/删除与说明文案保持不变；演示 API 地址和 Key 后缀只属于隔离 fixture。

## 交互与验证

- 点击“图片”文字切换勾选；出现未保存状态，点击保存后显示“已保存”，按钮恢复不可操作。预览保存仅更新内存。
- Pi、Codex 和 DeepSeek 的同类控件均为横排，文字/复选框中心差为 0。
- 预览浏览器控制台检查无 error/warn；真实生产数据、网络模型能力与原生 Electron 窗口没有在此隔离预览中执行。
- scripts/run-electron-node-test.mjs tests/pi-byok.test.mjs：4 项通过，0 失败，0 跳过，包含保存、重新加载、数据库与运行时能力转换回归。现有 macOS codesign 诊断不影响测试退出码 0。

## Implementation Checklist

- [x] 在完整设置页样式下复现，不再使用缺少外层样式的静态列表作为验证。
- [x] 修复标签层叠冲突并保留原表单结构。
- [x] 完整/局部同图比较、深浅色、窄窗口和实际点击/保存复核。
- [x] 4 项相关回归通过，临时视口已恢复，用户预览保持打开。

无需要阻塞交付的后续视觉问题。

final result: passed
