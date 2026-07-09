import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("MessageBubble gates code whip to running/starting assistant avatars", () => {
  const src = read("../src/components/CLI/MessageBubble.tsx");
  assert.match(src, /whipNonce/);
  assert.match(src, /whipping/);
  assert.match(src, /whip-hit/);
  assert.match(
    src,
    /status === "running" \|\| message\.status === "starting"/
  );
  assert.match(src, /handleWhip|onWhip|whipAvatar/);
});

test("styles define whip-hit comedy effect and reduced-motion fallback", () => {
  const css = read("../styles.css");
  assert.match(css, /\.whip-hit/);
  assert.match(css, /@keyframes whip/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /whip-crack|啪/);
});
