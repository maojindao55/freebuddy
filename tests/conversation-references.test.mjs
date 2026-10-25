import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = path => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const dataUrl = value => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const compile = file => ts.transpileModule(source(file), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const utilsUrl = dataUrl(compile("../src/utils/conversationReferences.ts"));
const { findReferenceConversations, mergeConversationReferences, buildReferencedPrompt } = await import(utilsUrl);
const conversations = [
  { id: "current", title: "登录页", agentName: "Codex", updatedAt: "2026-10-24T12:00:00Z" },
  { id: "old", title: "登录规范", agentName: "Claude", cwd: "/www/app", archived: true, updatedAt: "2026-10-23T12:00:00Z" },
  { id: "new", title: "登录需求", agentName: "Codex", cwd: "/www/app", updatedAt: "2026-10-24T11:00:00Z" }
];

test("picker excludes the target, searches title/agent/project words and sorts by recent activity", () => {
  assert.deepEqual(findReferenceConversations(conversations, "", "current").map(c => c.id), ["new", "old"]);
  assert.deepEqual(findReferenceConversations(conversations, "登录 cLaUdE app", "current").map(c => c.id), ["old"]);
  assert.deepEqual(findReferenceConversations(conversations, "missing", "current"), []);
  assert.deepEqual(findReferenceConversations([], ""), []);
  assert.equal(conversations[0].id, "current");
});

test("restoring a scheduled draft deduplicates references by stable conversation id", () => {
  assert.deepEqual(mergeConversationReferences([conversations[1]], [conversations[1], conversations[2]]).map(r => r.id), ["old", "new"]);
});

test("sending snapshots each selected source exactly once and preserves ordinary slash paths", async () => {
  const calls = [];
  const prompt = await buildReferencedPrompt("  请参考这些会话，检查 /car_paly/home/  ", [conversations[1], conversations[1], conversations[2]], async input => {
    calls.push(input);
    return { link: `freebuddy://conversation-share/v1/${input.sourceConversationId.padEnd(24, "x")}` };
  }, "current");
  assert.deepEqual(calls, [{ sourceConversationId: "old" }, { sourceConversationId: "new" }]);
  assert.match(prompt, /^请参考这些会话，检查 \/car_paly\/home\//);
  assert.equal((prompt.match(/freebuddy:\/\//g) ?? []).length, 2);
});

test("messages without references do not create snapshots; existing pasted share links are preserved", async () => {
  const text = "请参考 freebuddy://conversation-share/v1/abcdefghijklmnopqrstuv";
  assert.equal(await buildReferencedPrompt(text, [], () => assert.fail("unexpected snapshot")), text);
});

test("self references and inaccessible sources fail before the outgoing message is sent", async () => {
  await assert.rejects(buildReferencedPrompt("task", [conversations[0]], () => assert.fail("unexpected snapshot"), "current"), /itself/);
  await assert.rejects(buildReferencedPrompt("task", [conversations[1], conversations[0]], () => assert.fail("unexpected snapshot before self-reference validation"), "current"), /itself/);
  const selected = [conversations[1]];
  await assert.rejects(buildReferencedPrompt("task", selected, async () => { throw new Error("Source conversation not found"); }), /Source conversation not found/);
  assert.equal(selected.length, 1, "failed snapshot generation keeps the selected draft intact");
});

let harnessCount = 0;
async function scheduledHarness({ failSnapshot = false, failAttach = false, delegation = false } = {}) {
  const mockUrl = dataUrl(`
    // isolated harness ${harnessCount++}
    export const calls = [];
    export const entry = { conversationId: "target", prompt: "use context", attachments: [], conversationReferences: [{ id: "source", title: "source", agentName: "Codex" }], status: "pending" };
    const store = { conversations: [{ id: "target", approvalMode: "ask" }], isRunning: () => false,
      sendMessage: async args => { calls.push(["send", args]); }, loadMessages: async () => {} };
    export const useConversationStore = { getState: () => store };
    export const useScheduledSendStore = { getState: () => ({ setStatus: (...args) => calls.push(["status", ...args]), remove: (...args) => calls.push(["remove", ...args]) }) };
    export const useAgentBridgeStore = { getState: () => ({ notify: text => calls.push(["notify", text]) }) };
    export const cliClient = {
      createConversationShare: async input => { calls.push(["snapshot", input]); if (${failSnapshot}) throw new Error("source denied"); return { link: "freebuddy://conversation-share/v1/abcdefghijklmnopqrstuv" }; },
      attachConversationShares: async input => { calls.push(["attach", input]); if (${failAttach}) throw new Error("attach failed"); return { references: [], attachedCount: 1 }; }
    };
    export const delegationClient = { isAvailable: () => ${delegation}, hasRunForConversation: async () => ${delegation}, followUp: async args => { calls.push(["followup", args]); return { ok: true }; } };
    export const unprotectManagedAttachments = () => calls.push(["unprotect"]);
    export const composeMessageWithAttachments = text => text;
    export const truncatePromptPreview = text => text;
    export const dueScheduledSends = () => [];
    export default { t: key => key };
  `);
  const runner = compile("../src/services/scheduledSend/runner.ts").replace(/from\s+["']([^"']+)["']/g, (_, path) => `from ${JSON.stringify(path === "@/utils/conversationReferences" ? utilsUrl : mockUrl)}`);
  return { ...await import(dataUrl(runner)), ...await import(mockUrl) };
}

test("scheduled references are snapshotted and attached before normal dispatch", async () => {
  const h = await scheduledHarness();
  await h.fireScheduledSend(h.entry);
  assert.deepEqual(h.calls.filter(c => ["snapshot", "attach", "send", "remove"].includes(c[0])).map(c => c[0]), ["snapshot", "attach", "send", "remove"]);
  assert.match(h.calls.find(c => c[0] === "send")[1].prompt, /conversation-share/);
});

test("scheduled context failure leaves the entry available for retry and never dispatches", async () => {
  for (const scenario of [{ failSnapshot: true }, { failAttach: true }]) {
    const h = await scheduledHarness(scenario);
    await h.fireScheduledSend(h.entry);
    assert.equal(h.calls.some(c => ["send", "followup", "remove", "unprotect"].includes(c[0])), false);
    assert.ok(h.calls.some(c => c[0] === "status" && c[2] === "failed"));
  }
});

test("scheduled delegation followups receive the same snapshot links after attachment", async () => {
  const h = await scheduledHarness({ delegation: true });
  await h.fireScheduledSend(h.entry);
  assert.deepEqual(h.calls.filter(c => ["snapshot", "attach", "followup", "send"].includes(c[0])).map(c => c[0]), ["snapshot", "attach", "followup"]);
});

test("delegation runner resolves actual conversation snapshots and exposes them to the agent", async () => {
  const mockUrl = dataUrl(`
    export let captured;
    export const resolved = [{ id: "snapshot", source: { conversationId: "source" } }];
    export const listResolvedConversationContextPayloads = id => id === "target" ? resolved : [];
    export const conversationContextPromptPrefix = refs => "READ_CONTEXT:" + refs[0].id + "\\n";
    export const cliRun = async (_window, args, emit) => { captured = args; emit({ type: "done", exitCode: 0 }); };
    export const appendMessage = () => {};
    export const updateMessage = () => {};
    export const safeSendToWebContents = () => {};
    export const serializeStreamItemsForPersist = items => JSON.stringify(items);
  `);
  const runnerSource = compile("../electron/cli/delegationRunner.ts").replace(/from\s+["']([^"']+)["']/g,
    (_, path) => `from ${JSON.stringify(path.startsWith("node:") || path === "@freebuddy/agent-runtime" ? import.meta.resolve(path) : mockUrl)}`);
  const { createDelegateAgentRunner } = await import(dataUrl(runnerSource));
  const mocks = await import(mockUrl);
  await createDelegateAgentRunner(undefined)({ conversationId: "target", prompt: "compare these", sessionId: "run" });
  assert.equal(mocks.captured.prompt, "READ_CONTEXT:snapshot\ncompare these");
  assert.deepEqual(mocks.captured.contextReferences, mocks.resolved);
  await createDelegateAgentRunner(undefined)({ prompt: "no conversation", sessionId: "run2" });
  assert.equal(mocks.captured.prompt, "no conversation");
});
