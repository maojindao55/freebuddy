import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("desktop delegation IPC routes orchestration through the runtime process client", () => {
  const ipc = read("electron/cli/delegationIpc.ts");
  assert.match(ipc, /createDelegationRuntimeHandle/);
  assert.match(ipc, /handleDelegationFollowUp/);
  const client = read("electron/runtime/delegationRuntimeClient.ts");
  assert.match(client, /delegation\.prepareRun/);
  assert.match(client, /delegation\.runEntry/);
  assert.match(client, /delegation\.stopRun/);
  assert.match(client, /delegation\.followUp/);
  const handlers = read("packages/runtime-entry/src/rpc/serviceHandlers.ts");
  assert.match(handlers, /"delegation\.stopRun"/);
  assert.match(handlers, /"delegation\.pauseRun"/);
  assert.match(handlers, /"delegation\.resumeRun"/);
  assert.match(handlers, /"delegation\.followUp"/);
});

test("delegation conversations get a short user-facing title instead of the skill announcement", () => {
  const ipc = read("electron/cli/delegationIpc.ts");
  assert.match(ipc, /function buildDelegationConversationTitle/);
  assert.match(ipc, /kind: "delegation"/);
  assert.match(ipc, /FreeBuddy active skills/);
  assert.doesNotMatch(ipc, /input\.goal\.length > 100/);
  const app = read("src/App.tsx");
  assert.match(app, /ConversationKindBadge/);
  assert.match(app, /conversationVisibleTitle/);
  const list = read("src/components/CLI/ConversationList.tsx");
  assert.match(list, /ConversationKindBadge/);
  assert.match(list, /useConversationVisibleTitle/);
  const localesEn = JSON.parse(read("src/locales/en.json"));
  const localesZh = JSON.parse(read("src/locales/zh-CN.json"));
  assert.equal(localesEn.workflow.delegation.sessionTitleFallback, "Self-organizing team");
  assert.equal(localesZh.workflow.delegation.sessionTitleFallback, "自组织团队会话");
});
