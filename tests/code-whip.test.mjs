import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("MessageBubble aims whip at avatar coordinates", () => {
  const src = read("../src/components/CLI/MessageBubble.tsx");
  assert.match(src, /canWhip = message\.role === "assistant"/);
  assert.match(src, /useWhipEffectStore/);
  assert.match(src, /getBoundingClientRect/);
  assert.match(src, /targetMessageId === message\.id/);
  assert.match(src, /whip-hit/);
});

test("ChatView mounts a full-chat code whip overlay", () => {
  const chat = read("../src/components/CLI/ChatView.tsx");
  const overlay = read("../src/components/CLI/CodeWhipOverlay.tsx");
  assert.match(chat, /CodeWhipOverlay/);
  assert.match(overlay, /code-whip-overlay/);
  assert.match(overlay, /code-whip-svg/);
  assert.match(overlay, /whip-handle-grad/);
  assert.match(overlay, /--whip-hit-x/);
});

test("styles aim whip tip at avatar and shake hit avatar", () => {
  const css = read("../styles.css");
  assert.match(css, /\.code-whip-overlay/);
  assert.match(css, /@keyframes code-whip-swing/);
  assert.match(css, /@keyframes code-whip-avatar-hit/);
  assert.match(css, /\.msg-avatar-whip-target\.whip-hit/);
  assert.match(css, /--whip-hit-x/);
});

test("whip effect store tracks target message and point", () => {
  const src = read("../src/store/whipEffectStore.ts");
  assert.match(src, /WHIP_EFFECT_MS/);
  assert.match(src, /targetMessageId/);
  assert.match(src, /WhipTargetPoint/);
  assert.match(src, /trigger:/);
});
