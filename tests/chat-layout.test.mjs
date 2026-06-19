import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const chatViewSource = fs.readFileSync(
  new URL("../src/components/CLI/ChatView.tsx", import.meta.url),
  "utf8"
);
const appSource = fs.readFileSync(
  new URL("../src/App.tsx", import.meta.url),
  "utf8"
);
const stylesSource = fs.readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8"
);

test("chat scroll leaves enough bottom clearance for the composer", () => {
  assert.match(stylesSource, /--chat-composer-reserve:\s*(1[6-9]\d|2[0-4]\d|250)px/);
  assert.match(
    stylesSource,
    /\.chat-scroll\s*\{[\s\S]*padding:[^;]*calc\(var\(--chat-composer-reserve\)[^;]*;/m
  );
  assert.match(
    stylesSource,
    /\.chat-scroll\s*\{[\s\S]*scroll-padding-bottom:\s*var\(--chat-composer-reserve\)/m
  );
});

test("desktop shell is pinned to the actual viewport in fullscreen", () => {
  assert.match(stylesSource, /html,\s*body,\s*#root\s*\{[\s\S]*height:\s*100%;/m);
  assert.match(stylesSource, /\.app-shell\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/m);
  assert.doesNotMatch(stylesSource, /\.app-shell\s*\{[^}]*\n\s*height:\s*100vh;/m);
});

test("workspace keeps the composer inside the visible column", () => {
  assert.match(stylesSource, /\.workspace\s*\{[^}]*overflow:\s*hidden;/m);
  assert.match(stylesSource, /\.chat-section\s*\{[^}]*position:\s*relative;[^}]*min-height:\s*0;/m);
  assert.match(stylesSource, /\.chat-view\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s*auto;/m);
  assert.match(stylesSource, /\.chat-composer\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*18px;/m);
  assert.match(stylesSource, /\.chat-composer\s*\{[^}]*left:\s*272px;[^}]*right:\s*320px;/m);
});

test("sending a message restores auto-follow to the latest output", () => {
  assert.match(
    chatViewSource,
    /const onSend = async \(\) => \{[\s\S]*isNearBottomRef\.current = true;[\s\S]*setSubmitPreview\(preview\)/m
  );
});

test("sidebar conversation list scrolls instead of being clipped", () => {
  assert.match(stylesSource, /\.sidebar\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/m);
  assert.match(
    stylesSource,
    /\.conv-list\s*\{[\s\S]*?min-height:\s*0;/
  );
  assert.match(
    stylesSource,
    /\.conv-list ul\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/
  );
});

test("sidebar collapse toggle hides the sidebar column", () => {
  assert.match(stylesSource, /\.sidebar-toggle\.floating\s*\{[\s\S]*?position:\s*absolute;/m);
  assert.match(
    stylesSource,
    /\.app-shell\.sidebar-collapsed\s*\{[\s\S]*?grid-template-columns:\s*minmax\(420px,\s*1fr\)\s*320px;/
  );
  assert.match(stylesSource, /\.sidebar-collapsed \.sidebar\s*\{[\s\S]*?display:\s*none;/m);
  assert.match(
    stylesSource,
    /\.sidebar-collapsed \.chat-composer\s*\{[\s\S]*?left:\s*0;/
  );
});

test("sidebar brand uses the dedicated sidebar logo asset", () => {
  const brandMarkSource = appSource.match(/function BrandMark\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(appSource, /import\s+sidebarLogoUrl\s+from\s+"..\/assets\/sidebar-logo\.png"/);
  assert.match(appSource, /<img\s+src=\{sidebarLogoUrl\}\s+alt=""\s+className="sidebar-logo-img"\s*\/>/);
  assert.doesNotMatch(brandMarkSource, /<svg/m);
  assert.match(stylesSource, /\.sidebar-logo-img\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*cover;/m);
});
