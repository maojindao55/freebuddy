import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const menuSource = fs.readFileSync(
  new URL("../src/components/CLI/ComposerAddMenu.tsx", import.meta.url),
  "utf8"
);
const chatViewSource = fs.readFileSync(
  new URL("../src/components/CLI/ChatView.tsx", import.meta.url),
  "utf8"
);
const stylesSource = fs.readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8"
);

test("composer consolidates attachments, skills, and plugins behind one add menu", () => {
  assert.equal((chatViewSource.match(/<ComposerAddMenu/g) ?? []).length, 2);
  assert.doesNotMatch(chatViewSource, /<SkillPicker/);
  assert.doesNotMatch(chatViewSource, /<PaperclipIcon/);
  assert.match(menuSource, /onSelectAttachments/);
  assert.match(menuSource, /onSkillsChange/);
  assert.match(menuSource, /onSelectPlugin/);
  assert.match(menuSource, /pluginsClient\.list\(pluginAgent\)/);
  assert.match(menuSource, /skills\.menuSummary/);
  assert.match(menuSource, /plugins\.menuSummary/);
  assert.match(menuSource, /selectedAvailableCount/);
  assert.match(menuSource, /attachmentPreviewUrl\(plugin\.iconPath\)/);
  assert.match(chatViewSource, /plugin:\/\/\$\{plugin\.name\}@\$\{plugin\.marketplace\}/);
});

test("composer add menu supports dismiss and independent disabled states", () => {
  assert.match(menuSource, /document\.addEventListener\("mousedown", closeOnOutsidePointer\)/);
  assert.match(menuSource, /event\.key !== "Escape"/);
  assert.match(menuSource, /attachmentDisabled && skillsDisabled && \(!pluginAgent \|\| pluginsDisabled\)/);
  assert.match(menuSource, /disabled=\{attachmentDisabled\}/);
  assert.match(menuSource, /disabled=\{skillsDisabled\}/);
  assert.match(menuSource, /disabled=\{pluginsDisabled\}/);
  assert.match(menuSource, /onClick=\{\(\) => setActivePanel\("skills"\)\}/);
  assert.match(menuSource, /onClick=\{\(\) => setActivePanel\("plugins"\)\}/);
  assert.match(menuSource, /aria-expanded=\{open\}/);
  assert.match(menuSource, /aria-expanded=\{activePanel === "skills"\}/);
  assert.match(menuSource, /aria-expanded=\{activePanel === "plugins"\}/);
});

test("composer add menu follows the compact two-panel reference layout", () => {
  assert.match(stylesSource, /\.composer-add-trigger\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;[^}]*border-radius:\s*999px;/m);
  assert.match(stylesSource, /\.composer-add-popover\s*\{[^}]*display:\s*flex;[^}]*gap:\s*8px;/m);
  assert.match(stylesSource, /\.composer-add-primary\s*\{[^}]*width:\s*224px;/m);
  assert.match(stylesSource, /\.composer-add-skills-panel\s*\{[^}]*width:\s*292px;/m);
  assert.match(stylesSource, /\.composer-add-plugin-option\s*\{[^}]*grid-template-columns:\s*36px minmax\(0, 1fr\);/m);
});

test("composer add menu escapes the rounded composer clipping boundary", () => {
  assert.match(
    stylesSource,
    /\.chat-composer:has\(\.composer-add-trigger\.active\),\s*\.new-task-composer:has\(\.composer-add-trigger\.active\)\s*\{[^}]*overflow:\s*visible;/m
  );
});
