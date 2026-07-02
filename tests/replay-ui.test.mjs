import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("replayStore exposes speeds, 1.5 default, and typing helpers", () => {
  const src = read("../src/store/replayStore.ts");
  assert.match(src, /REPLAY_SPEEDS = \[1, 1\.5, 2, 4, 8\]/);
  assert.match(src, /REPLAY_DEFAULT_SPEED[\s\S]*?1\.5/);
  assert.match(src, /REPLAY_TYPING_INTERVAL_MS/);
  assert.match(src, /export function splitTextSteps/);
  assert.match(src, /export function clampIndex/);
  assert.match(src, /export interface ReplayFrame/);
});

test("replayStore start stores frames and resets to the beginning", () => {
  const src = read("../src/store/replayStore.ts");
  assert.match(src, /start\(conversationId, frames\)[\s\S]*?set\(\{ \.\.\.EMPTY, conversationId, frames, speed: REPLAY_DEFAULT_SPEED \}\)/);
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

test("replayStore setIndex clamps against frames length and pauses", () => {
  const src = read("../src/store/replayStore.ts");
  assert.match(src, /setIndex\(i\)[\s\S]*?set\(\{ index: clampIndex\(i, get\(\)\.frames\.length\), playing: false \}\)/);
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

test("ReplayBar drives playback with speed- and typing-scaled intervals", () => {
  const src = read("../src/components/CLI/ReplayBar.tsx");
  assert.match(src, /REPLAY_TYPING_INTERVAL_MS/);
  assert.match(src, /const isTyping = current\?\.typingChars != null/);
  assert.match(src, /const base = isTyping \? REPLAY_TYPING_INTERVAL_MS : REPLAY_BASE_INTERVAL_MS/);
  assert.match(src, /window\.setInterval\(\(\) => next\(\)/);
  assert.match(src, /role="toolbar"/);
  assert.match(src, /s\) => s\.frames\.length/);
});

test("MessageBubble supports blockLimit and typingChars for incremental replay", () => {
  const src = read("../src/components/CLI/MessageBubble.tsx");
  assert.match(src, /blockLimit\?: number/);
  assert.match(src, /typingChars\?: number/);
  assert.match(src, /const renderedBlocks = useMemo/);
  assert.match(src, /content: \(last\.item\.content \?\? ""\)\.slice\(0, typingChars\)/);
  assert.match(src, /renderedBlocks\.map\(\(block, i\)/);
  assert.match(src, /import \{ isVisibleItem, visibleBlocks \} from "\.\/messageBlocks"/);
});

test("ChatView plays back at block granularity with typing text and exposes the entry button", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  assert.match(src, /import \{ ReplayBar \} from "\.\/ReplayBar"/);
  assert.match(src, /import \{ computeMessageBlocks \} from "\.\/messageBlocks"/);
  assert.match(src, /splitTextSteps,/);
  assert.match(src, /type ReplayFrame/);
  assert.match(src, /const replaying = replayConvId === conv\?\.id && replayConvId !== null/);
  assert.match(src, /canEnterReplay = messages\.length >= 2 && !running && !replaying/);
  assert.match(src, /function buildReplayFrames/);
  assert.match(src, /computeMessageBlocks\(message\.content\)/);
  assert.match(src, /splitTextSteps\(item\.content\)/);
  assert.match(src, /typingChars: chars/);
  assert.match(src, /const storeFrames = useReplayStore\(\(s\) => s\.frames\)/);
  assert.match(src, /blockLimit=\{replayPartial\.blockLimit\}/);
  assert.match(src, /typingChars=\{replayPartial\.typingChars\}/);
  assert.match(src, /startReplay\(conv\.id, buildReplayFrames\(messages\)\)/);
  assert.match(src, /replay-entry-btn/);
  assert.match(src, /disabled=\{sending \|\| replaying\}/);
  assert.match(src, /replay-disabled/);
  assert.match(src, /stopReplay\(\)/);
});

test("replay styles exist in the stylesheet", () => {
  const css = read("../styles.css");
  assert.match(css, /\.chat-topbar\s*\{/);
  assert.match(css, /\.replay-entry-btn\s*\{/);
  assert.match(css, /\.replay-bar\s*\{/);
  assert.match(css, /\.replay-play-btn\s*\{/);
  assert.match(css, /\.replay-progress\s*\{/);
  assert.match(css, /\.replay-count\s*\{/);
  assert.match(css, /\.chat-composer\.replay-disabled\s*\{/);
  assert.match(css, /\.chat-scroll\.replay-active > \.msg:last-child/);
  assert.match(css, /@keyframes replay-fade-in/);
});

test("replay i18n keys exist in both locales", () => {
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  const keys = [
    "title", "entry", "play", "pause", "prev", "next", "exit",
    "speed", "speedOption", "progress", "disabledRunning", "disabledEmpty"
  ];
  for (const key of keys) {
    assert.ok(en.chat.replay?.[key], `missing en chat.replay.${key}`);
    assert.ok(zh.chat.replay?.[key], `missing zh-CN chat.replay.${key}`);
  }
  assert.equal(en.chat.replay.speedOption, "{{speed}}x");
  assert.equal(en.chat.replay.progress, "{{n}}/{{total}}");
  assert.equal(zh.chat.replay.entry, "回放");
});
