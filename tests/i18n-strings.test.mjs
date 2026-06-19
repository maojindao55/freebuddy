import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const files = [
  "../src/App.tsx",
  "../src/components/CLI/ChatView.tsx",
  "../src/components/CLI/ConversationList.tsx",
  "../src/components/CLI/WorkspacePanel.tsx",
  "../src/components/CLI/MessageBubble.tsx",
  "../src/components/CLI/StreamItem.tsx",
  "../src/components/CLI/PermissionDialog.tsx",
  "../src/components/CLI/ImageLightbox.tsx",
  "../src/components/Settings/SettingsModal.tsx",
  "../src/components/Settings/CLIAdaptersTab.tsx",
  "../src/components/Settings/AvatarPicker.tsx"
];

test("no CJK literals remain in migrated components", () => {
  for (const f of files) {
    const src = read(f);
    assert.equal(/[\u4e00-\u9fff]/.test(src), false, `CJK found in ${f}`);
  }
});

test("migrated components use the translation hook", () => {
  for (const f of files) {
    const src = read(f);
    if (/Conversations|Settings|Permission|ChatView|Workspace/.test(f)) {
      assert.match(src, /useTranslation\(\)|i18next\.t\(/, `${f} should use t()`);
    }
  }
});
