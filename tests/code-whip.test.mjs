import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("MessageBubble allows whipping any assistant avatar", () => {
  const src = read("../src/components/CLI/MessageBubble.tsx");
  assert.match(src, /canWhip = message\.role === "assistant"/);
  assert.match(src, /useWhipEffectStore/);
  assert.match(src, /handleWhip/);
  assert.match(src, /\.trigger\(\)/);
});

test("ChatView mounts a full-chat code whip overlay", () => {
  const chat = read("../src/components/CLI/ChatView.tsx");
  const overlay = read("../src/components/CLI/CodeWhipOverlay.tsx");
  assert.match(chat, /CodeWhipOverlay/);
  assert.match(overlay, /code-whip-overlay/);
  assert.match(overlay, /code-whip-svg/);
  assert.match(overlay, /useWhipEffectStore/);
});

test("styles define livestream-style center whip effect", () => {
  const css = read("../styles.css");
  assert.match(css, /\.code-whip-overlay/);
  assert.match(css, /@keyframes code-whip-swing/);
  assert.match(css, /\.code-whip-crack/);
  assert.match(css, /prefers-reduced-motion/);
});

test("whip effect store exposes trigger cooldown", () => {
  const src = read("../src/store/whipEffectStore.ts");
  assert.match(src, /WHIP_EFFECT_MS/);
  assert.match(src, /trigger:/);
  assert.match(src, /active: true/);
});
