import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

function listSourceFiles(dir) {
  const root = new URL(dir, import.meta.url);
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(new URL(`${entry.name}/`, root)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const migratedFiles = [
  "../src/App.tsx",
  "../src/components/CLI/ChatView.tsx",
  "../src/components/CLI/ConversationList.tsx",
  "../src/components/CLI/WorkspacePanel.tsx",
  "../src/components/CLI/MessageBubble.tsx",
  "../src/components/CLI/StreamItem.tsx",
  "../src/components/CLI/PermissionDialog.tsx",
  "../src/components/CLI/AuthenticationDialog.tsx",
  "../src/components/CLI/ImageLightbox.tsx",
  "../src/components/Settings/SettingsModal.tsx",
  "../src/components/Settings/CLIAdaptersTab.tsx",
  "../src/components/Settings/AvatarPicker.tsx"
];

test("no CJK literals remain anywhere in src/", () => {
  for (const file of listSourceFiles("../src/")) {
    const src = fs.readFileSync(file, "utf8");
    assert.equal(/[\u4e00-\u9fff]/.test(src), false, `CJK found in ${file}`);
  }
});

test("migrated components use the translation hook", () => {
  for (const f of migratedFiles) {
    const src = read(f);
    if (/Conversations|Settings|Permission|ChatView|Workspace/.test(f)) {
      assert.match(src, /useTranslation\(\)|i18next\.t\(/, `${f} should use t()`);
    }
  }
});
