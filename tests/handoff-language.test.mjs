import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) =>
  fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("agent language helper prefers Simplified Chinese for zh-CN", async () => {
  const {
    AGENT_LANGUAGE_HEADER,
    applyAgentLanguagePreference,
    resolveAgentOutputLanguage
  } = await import("../dist-electron/cli/agentLanguage.js");

  assert.equal(resolveAgentOutputLanguage("zh-CN"), "Simplified Chinese");
  assert.equal(resolveAgentOutputLanguage("en"), "English");
  assert.equal(resolveAgentOutputLanguage(undefined), "English");

  const zh = applyAgentLanguagePreference("Continue the task.", "zh-CN");
  assert.match(zh, new RegExp(`^${AGENT_LANGUAGE_HEADER}`));
  assert.match(zh, /Write all user-facing prose in Simplified Chinese/);
  assert.match(zh, /Continue the task\./);
  assert.equal(applyAgentLanguagePreference(zh, "zh-CN"), zh);

  const en = applyAgentLanguagePreference("Continue the task.", "en");
  assert.match(en, /Write all user-facing prose in English/);
});

test("transfer seed and context prefix localize with language preference", async () => {
  const {
    buildTransferSeedPrompt,
    conversationContextPromptPrefix
  } = await import("../dist-electron/cli/conversationContext.js");

  const source = { agentName: "Cursor", adapter: "cursor" };
  const brief = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      conversationId: "A",
      agentId: "cursor",
      agentName: "Cursor",
      adapter: "cursor",
      title: "Draft",
      messageCount: 2
    },
    originalGoal: "Fix draft preview",
    recentUserMessages: [],
    lastAssistantSummary: "Done some work",
    fileChanges: [],
    transcriptExcerpts: []
  };

  const zhSeed = buildTransferSeedPrompt(source, brief, "zh-CN");
  assert.match(zhSeed, /正在继续从 Cursor（cursor）转接过来的任务/);
  assert.match(zhSeed, /read_context_brief/);
  assert.doesNotMatch(zhSeed, /FreeBuddy response language:/);

  const zhEmpty = buildTransferSeedPrompt(source, null, "zh-CN");
  assert.match(zhEmpty, /暂无可用的先前上下文/);
  assert.match(zhEmpty, /Write all user-facing prose in Simplified Chinese/);

  const enSeed = buildTransferSeedPrompt(source, brief, "en");
  assert.match(enSeed, /Continuing a task transferred from Cursor \(cursor\)/);

  const refs = [{ id: "ref-1" }];
  const zhPrefix = conversationContextPromptPrefix(refs, "zh-CN");
  assert.match(zhPrefix, /当前会话附带了一个或多个 FreeBuddy 对话引用/);
  assert.match(zhPrefix, /read_context_brief/);

  const enPrefix = conversationContextPromptPrefix(refs, "en");
  assert.match(enPrefix, /One or more FreeBuddy conversation references are attached/);
  assert.equal(conversationContextPromptPrefix([], "zh-CN"), "");
});

test("cli run and workflow runtime apply agent language for context refs", () => {
  const ipc = read("electron/cli/ipc.ts");
  const workflow = read("electron/cli/workflowRuntime.ts");
  const context = read("electron/cli/conversationContext.ts");

  assert.match(ipc, /applyAgentLanguagePreference/);
  assert.match(ipc, /buildTransferSeedPrompt\(source, brief\)/);
  assert.match(ipc, /getLanguage\(\)/);
  assert.doesNotMatch(ipc, /function buildSeedPrompt/);

  assert.match(workflow, /applyAgentLanguagePreference/);
  assert.match(workflow, /conversationContextPromptPrefix\(contextReferences\)/);

  assert.match(context, /buildTransferSeedPrompt/);
  assert.match(context, /正在继续从/);
  assert.match(context, /当前会话附带了一个或多个 FreeBuddy 对话引用/);
});
