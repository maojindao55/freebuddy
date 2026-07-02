import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("replayStore exposes fixed timing and typing helpers", () => {
  const src = read("../src/store/replayStore.ts");
  assert.match(src, /REPLAY_BASE_INTERVAL_MS/);
  assert.match(src, /REPLAY_TYPING_INTERVAL_MS/);
  assert.match(src, /export function splitTextSteps/);
  assert.match(src, /export function clampIndex/);
  assert.match(src, /export interface ReplayWorkflowSnapshot/);
  assert.match(src, /at\?: string/);
  assert.match(src, /export interface ReplayFrame/);
  assert.match(src, /workflow\?: ReplayWorkflowSnapshot/);
});

test("replayStore start stores frames and starts playback", () => {
  const src = read("../src/store/replayStore.ts");
  assert.match(src, /start\(conversationId, frames\)[\s\S]*?set\(\{ \.\.\.EMPTY, conversationId, frames, playing: frames\.length > 0 \}\)/);
  assert.match(src, /frames: \[\] as ReplayFrame\[\]/);
  assert.match(src, /const EMPTY[\s\S]*?index: -1[\s\S]*?playing: false/);
});

test("replayStore play restarts when already at the end", () => {
  const src = read("../src/store/replayStore.ts");
  assert.match(src, /const total = get\(\)\.frames\.length[\s\S]*?const atEnd = index >= total - 1[\s\S]*?set\(\{ playing: true, index: atEnd \? -1 : index \}\)/);
});

test("replayStore next auto-pauses at the last frame", () => {
  const src = read("../src/store/replayStore.ts");
  assert.match(src, /const atEnd = index >= total - 1[\s\S]*?if \(atEnd\)[\s\S]*?set\(\{ index: total - 1, playing: false \}\)/);
});

test("replayStore prev clamps against frames length", () => {
  const src = read("../src/store/replayStore.ts");
  assert.match(src, /prev\(\)[\s\S]*?set\(\{ index: clampIndex\(index - 1, frames\.length\) \}\)/);
});

test("splitTextSteps chunks long text into typing milestones", () => {
  const src = read("../src/store/replayStore.ts");
  assert.match(src, /for \(let k = REPLAY_TYPING_STEP; k < len; k \+= REPLAY_TYPING_STEP\)/);
  assert.match(src, /steps\.push\(len\)/);
});

test("messageBlocks exports block helpers including computeMessageBlocks", () => {
  const src = read("../src/components/CLI/messageBlocks.ts");
  assert.match(src, /export function isVisibleItem/);
  assert.match(src, /export function visibleBlocks/);
  assert.match(src, /export function computeMessageBlocks/);
  assert.match(src, /export function countVisibleBlocks/);
  assert.match(src, /export type VisibleBlock/);
});

test("ReplayButton drives titlebar playback with typing-scaled intervals", () => {
  const src = read("../src/components/CLI/ReplayBar.tsx");
  assert.match(src, /export function ReplayButton/);
  assert.match(src, /import \{ RotateCcw, Square \} from "lucide-react"/);
  assert.match(src, /REPLAY_FIXED_SPEED = 1\.5/);
  assert.match(src, /REPLAY_TYPING_INTERVAL_MS/);
  assert.match(src, /const isTyping = current\?\.typingChars != null/);
  assert.match(src, /const base = isTyping \? REPLAY_TYPING_INTERVAL_MS : REPLAY_BASE_INTERVAL_MS/);
  assert.match(src, /window\.setInterval\(\(\) => next\(\)/);
  assert.match(src, /useConversationStore/);
  assert.match(src, /useWorkflowStore/);
  assert.match(src, /function buildWorkflowSnapshot/);
  assert.match(src, /messageComplete/);
  assert.match(src, /const at = frame\.messageComplete === true[\s\S]*?currentMessage\?\.updatedAt[\s\S]*?currentMessage\?\.createdAt/);
  assert.match(src, /const workflow = buildWorkflowSnapshot/);
  assert.match(src, /WORKFLOW_REPLAY_BLOCKED_STATUSES = new Set<WorkflowRunStatus>\(\[[\s\S]*?"running"[\s\S]*?"paused"[\s\S]*?"blocked"[\s\S]*?\]\)/);
  assert.match(src, /const workflowBlocksReplay =[\s\S]*?activeRun != null[\s\S]*?activeRun\.conversationId === activeId[\s\S]*?WORKFLOW_REPLAY_BLOCKED_STATUSES\.has\(activeRun\.status\)/);
  assert.match(src, /const canReplay =[\s\S]*?!running[\s\S]*?!workflowBlocksReplay/);
  assert.match(src, /buttonTitle = t\("chat\.replay\.disabledWorkflowActive"\)/);
  assert.match(src, /start\(activeId, nextFrames\)/);
  assert.match(src, /aria-pressed=\{replaying\}/);
  assert.match(src, /const Icon = replaying \? Square : RotateCcw/);
  assert.match(src, /title-replay-label/);
});

test("MessageBubble supports blockLimit and typingChars for incremental replay", () => {
  const src = read("../src/components/CLI/MessageBubble.tsx");
  assert.match(src, /blockLimit\?: number/);
  assert.match(src, /typingChars\?: number/);
  assert.match(src, /const renderedBlocks = useMemo/);
  assert.match(src, /const renderedSections = useMemo/);
  assert.match(src, /buildDisplaySections\(renderedBlocks\)/);
  assert.match(src, /content: \(last\.item\.content \?\? ""\)\.slice\(0, typingChars\)/);
  assert.match(src, /renderedSections\.map\(\(section, i\)/);
  assert.match(src, /import \{ isVisibleItem, visibleBlocks \} from "\.\/messageBlocks"/);
});

test("ChatView plays back at block granularity with typing text and locks the composer", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  assert.match(src, /const replaying = replayConvId === conv\?\.id && replayConvId !== null/);
  assert.match(src, /const storeFrames = useReplayStore\(\(s\) => s\.frames\)/);
  assert.match(src, /blockLimit=\{replayPartial\.blockLimit\}/);
  assert.match(src, /typingChars=\{replayPartial\.typingChars\}/);
  assert.match(src, /disabled=\{sending \|\| replaying\}/);
  assert.match(src, /replay-disabled/);
  assert.match(src, /stopReplay\(\)/);
});

test("replay styles exist in the stylesheet", () => {
  const css = read("../styles.css");
  assert.match(css, /\.titlebar-actions-plain\s*\{/);
  assert.match(css, /\.title-replay-btn\s*\{/);
  assert.match(css, /\.title-replay-btn\.replaying\s*\{/);
  assert.match(css, /\.title-replay-btn\.replaying\s*\{[\s\S]*?background: var\(--fb-brand-glow\)/);
  assert.match(css, /\.title-replay-label\s*\{/);
  assert.match(css, /\.chat-composer\.replay-disabled\s*\{/);
  assert.match(css, /\.chat-scroll\.replay-active > \.msg:last-child/);
  assert.match(css, /@keyframes replay-fade-in/);
});

test("replay i18n keys exist in both locales", () => {
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  const keys = [
    "title", "entry", "play", "pause", "exitShort", "exit",
    "progress", "disabledRunning", "disabledWorkflowActive", "disabledEmpty"
  ];
  for (const key of keys) {
    assert.ok(en.chat.replay?.[key], `missing en chat.replay.${key}`);
    assert.ok(zh.chat.replay?.[key], `missing zh-CN chat.replay.${key}`);
  }
  assert.equal(en.chat.replay.exitShort, "Exit");
  assert.equal(en.chat.replay.progress, "{{n}}/{{total}}");
  assert.equal(zh.chat.replay.entry, "回放");
  assert.equal(zh.chat.replay.exitShort, "退出");
  assert.equal(zh.chat.replay.disabledWorkflowActive, "团队工作流处理中无法回放");
});
