import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const pickerSource = fs.readFileSync(
  new URL("../src/components/CLI/AgentPicker.tsx", import.meta.url),
  "utf8"
);
const chatViewSource = fs.readFileSync(
  new URL("../src/components/CLI/ChatView.tsx", import.meta.url),
  "utf8"
);
const appSource = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const conversationStoreSource = fs.readFileSync(
  new URL("../src/store/conversationStore.ts", import.meta.url),
  "utf8"
);
const stylesSource = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const zh = JSON.parse(
  fs.readFileSync(new URL("../src/locales/zh-CN.json", import.meta.url), "utf8")
);
const en = JSON.parse(
  fs.readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8")
);

test("new task uses the availability-aware AgentPicker and opens agent settings", () => {
  assert.match(chatViewSource, /<AgentPicker/);
  assert.match(chatViewSource, /groups=\{agentAvailability\}/);
  assert.match(chatViewSource, /onOpen=\{onRefreshAgents\}/);
  assert.match(chatViewSource, /onManage=\{onManageAgents\}/);
  assert.match(appSource, /<ChatView onOpenAgentSettings=\{\(\) => openSettings\("cli"\)\}/);
  assert.match(conversationStoreSource, /enabled: executor\?\.enabled \?\? member\.enabled/);
});

test("AgentPicker separates ready agents from checking and installation management", () => {
  assert.match(pickerSource, /groups\.available/);
  assert.match(pickerSource, /groups\.checking/);
  assert.match(pickerSource, /groups\.unavailable/);
  assert.match(pickerSource, /chat\.agentPicker\.installMore/);
  assert.match(pickerSource, /available\.length > 8/);
  assert.match(pickerSource, /agent-picker-search/);
  assert.equal(zh.chat.agentPicker.noAvailable, "暂无可用 Agent");
  assert.equal(en.chat.agentPicker.noAvailable, "No agents are ready");
});

test("AgentPicker exposes listbox keyboard navigation and textual status", () => {
  assert.match(pickerSource, /role="listbox"/);
  assert.match(pickerSource, /event\.key === "ArrowDown"/);
  assert.match(pickerSource, /event\.key === "ArrowUp"/);
  assert.match(pickerSource, /aria-live="polite"/);
  assert.match(pickerSource, /chat\.agentPicker\.ready/);
});

test("AgentPicker opens above the composer without being clipped", () => {
  assert.match(
    stylesSource,
    /\.new-task-composer:has\(\.agent-picker-trigger\[aria-expanded="true"\]\)\s*\{[^}]*overflow:\s*visible;/m
  );
  assert.match(
    stylesSource,
    /\.agent-picker-popover\s*\{[^}]*bottom:\s*calc\(100% \+ 10px\);[^}]*width:\s*min\(300px,/m
  );
  assert.match(stylesSource, /\.agent-picker-option\s*\{[^}]*min-height:\s*48px;/m);
});
