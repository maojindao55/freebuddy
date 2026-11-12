import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const dataUrl = value => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const compile = value => ts.transpileModule(value, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText;
const chat = ts.createSourceFile("ChatView.tsx", fs.readFileSync(new URL("../src/components/CLI/ChatView.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const { buildReferencedPrompt } = await import(dataUrl(compile(fs.readFileSync(new URL("../src/utils/conversationReferences.ts", import.meta.url), "utf8"))));
const { supportsMessageQueue } = await import(dataUrl(compile(fs.readFileSync(new URL("../electron/shared/messageQueueTypes.ts", import.meta.url), "utf8"))));

// Execute the production send handlers with isolated service/state boundaries.
async function handler(name, scope) {
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(chat) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(chat);
  assert.ok(initializer, `missing ${name}`);
  const module = await import(dataUrl(compile(`export default scope => { const { ${Object.keys(scope).join(", ")} } = scope; return ${initializer.getText(chat)}; };`)));
  return module.default(scope);
}

function harness({ team = false, gate = false, delegation = false, refreshFails = false, queue = false, queueError, freshConversation } = {}) {
  const calls = [];
  const record = name => (...args) => calls.push([name, ...args]);
  const member = { id: "agent", cli: { skillIds: [] } };
  const refs = [{ id: "source", title: "source", agentName: "Codex" }];
  let sequence = 0;
  const scope = {
    attachmentBusy: false, sending: false, sendLock: false, newTaskSendLock: false, queueSend: queue,
    supportsMessageQueue, queueSubmissionRef: { current: new Map() },
    activeConversationConfigOptions: [], sessionConfigOptions: [], snapshotSessionConfigOptionOverrides: () => ({}),
    setMessageSkillDrafts: record('skillDrafts'), setReferenceDrafts: record('referenceDrafts'),
    enqueueMessage: async (...args) => { record('enqueue')(...args); if (queueError) throw new Error(queueError); },
    sendInFlightRef: { current: false }, newTaskSendInFlightRef: { current: false },
    attachmentImportGenerationRef: { current: 0 }, isNearBottomRef: { current: false },
    draft: "use context", newTaskDraft: "use context", pendingAttachments: [], newTaskPendingAttachments: [],
    messageSkills: delegation ? [] : [{ id: "skill" }], newTaskMessageSkills: [{ id: "skill" }],
    selectedReferences: refs, conv: { id: "target" }, members: [member], availableAgentIds: new Set([member.id]),
    teamMode: team, selectedTeamId: "team", allTeams: [{ id: "team", name: "Team" }], selectedMemberId: member.id,
    newTaskProjectId: undefined, newTaskConfigOptionOverrides: {}, newTaskMcpServerIds: [], permissionMode: "ask",
    pendingWorkflowAction: gate ? { runId: "run", phaseId: "phase" } : null,
    getPromptContext: undefined, buildReferencedPrompt, nanoid: () => `message-${++sequence}`,
    prepareWorkspaceForNewTask: async () => null, buildNewTaskMetadata: () => ({}),
    buildConversationTitle: () => "title", preflightMember: async () => true,
    resolveWorkflowFollowupMember: async () => member, isDelegationTeam: () => false,
    teamConversationMember: () => member, createConversation: async () => ({ id: "target" }),
    createAndStartTeam: async () => true, loadWorkflowForConversation: async () => {},
    requestGateChanges: async () => true, composeMessageWithAttachments: text => text,
    detachAttachmentsForSend: () => [], restoreAttachmentsForSend: value => value,
    protectManagedAttachments: () => {}, unprotectManagedAttachments: () => {}, focusComposer: () => {},
    window: { setTimeout: () => {} }, t: key => key,
    sendMessage: async args => { record("send")(args); return true; },
    updateContextReferences: record("refs"), notify: record("notify"),
    cliClient: {
      isMessageQueueAvailable: () => true,
      getConversation: async () => freshConversation ?? { id: 'target', kind: 'default', archived: false, messageQueueSupported: true },
      createConversationShare: async () => ({ link: "freebuddy://conversation-share/v1/abcdefghijklmnopqrstuv" }),
      attachConversationShares: async input => {
        record("attach")(input);
        return { references: [{ id: "reference", targetMessageId: input.targetMessageId }], attachedCount: 1 };
      },
      appendMessage: async input => { record("append")(input); return input; },
      listConversationContextReferences: async () => {
        if (refreshFails) throw new Error("refresh failed");
        return [{ id: "reference", targetMessageId: "persisted-delegation-message" }];
      }
    },
    delegationClient: { isAvailable: () => delegation, hasRunForConversation: async () => delegation,
      followUp: async args => { record("followup")(args); return { ok: true }; } },
    useConversationStore: { setState: record('conversationState'), getState: () => ({ activeId: 'target', loadMessages: async () => {
      if (refreshFails) throw new Error("load failed");
    } }) }
  };
  for (const name of ["setSendLock", "setNewTaskSendLock", "setPreflightMsg", "setDraft", "setNewTaskDraft", "setMessageSkills", "setNewTaskMessageSkills", "setPendingAttachments", "setNewTaskPendingAttachments", "setSubmitPreview", "setPreferredAgentId", "setSelectedReferences", "setPendingWorkflowAction"]) scope[name] = record(name);
  return { calls, scope };
}

test('a stale queue decision routes a legacy self-organizing followup to the delegation bus', async () => {
  const { scope, calls } = harness({ queue: true, delegation: true,
    freshConversation: { id: 'target', kind: 'default', archived: false, messageQueueSupported: false } });
  scope.queueSubmissionRef.current.set('target', { id: 'failed-attempt', fingerprint: 'old' });
  await (await handler('onSend', scope))();
  assert.equal(calls.filter(([kind]) => kind === 'followup').length, 1);
  assert.equal(calls.some(([kind]) => kind === 'enqueue' || kind === 'send'), false);
  assert.equal(scope.queueSubmissionRef.current.has('target'), false);
});

test('stale queue eligibility cannot enqueue or start a second turn while a team is still busy', async () => {
  const { scope, calls } = harness({ queue: true, delegation: true,
    freshConversation: { id: 'target', kind: 'delegation', archived: false, messageQueueSupported: false } });
  scope.sending = true;
  await (await handler('onSend', scope))();
  assert.equal(calls.some(([kind]) => ['enqueue', 'send', 'followup', 'setDraft'].includes(kind)), false);
  assert.equal(scope.sendInFlightRef.current, false);
});

test('archive races keep the draft and do not attempt to enqueue', async () => {
  const { scope, calls } = harness({ queue: true,
    freshConversation: { id: 'target', kind: 'default', archived: true, messageQueueSupported: false } });
  await (await handler('onSend', scope))();
  assert.equal(calls.some(([kind]) => ['enqueue', 'send', 'setDraft'].includes(kind)), false);
  assert.ok(calls.some(([kind, value]) => kind === 'setPreflightMsg' && value === 'messageQueue.conversationUnavailable'));
  assert.equal(scope.sendInFlightRef.current, false);
});

test('a late unsupported response clears only this conversation retry and keeps the draft', async () => {
  const { scope, calls } = harness({ queue: true, queueError: "Error invoking remote method 'cli:changeMessageQueue': Error: message_queue_unsupported" });
  scope.queueSubmissionRef.current.set('another-chat', { id: 'other-attempt', fingerprint: 'other' });
  await (await handler('onSend', scope))();
  assert.equal(calls.filter(([kind]) => kind === 'enqueue').length, 1);
  assert.equal(scope.queueSubmissionRef.current.has('target'), false);
  assert.equal(scope.queueSubmissionRef.current.has('another-chat'), true);
  assert.equal(calls.some(([kind]) => kind === 'setDraft'), false);
  assert.ok(calls.some(([kind, value]) => kind === 'setPreflightMsg' && value === 'messageQueue.unavailable'));
});

test('lost-response retries keep a stable id scoped to the original conversation', async () => {
  const { scope, calls } = harness({ queue: true, queueError: 'IPC response lost' });
  await (await handler('onSend', scope))();
  await (await handler('onSend', scope))();
  const attempts = calls.filter(([kind]) => kind === 'enqueue');
  assert.equal(attempts.length, 2); assert.equal(attempts[0][2].id, attempts[1][2].id);
  scope.conv = { id: 'another-chat', kind: 'default', archived: false };
  scope.queueSupported = true; scope.sending = false; scope.messageQueue = undefined;
  assert.equal(await handler('queueSend', scope), false, 'an unrelated retry cannot force an idle chat into the queue');
});

test('host capability disables the queue before workflow state is loaded', async () => {
  const { scope } = harness();
  scope.activeRun = null; scope.messageQueue = undefined;
  scope.conv = { id: 'target', kind: 'default', archived: false, messageQueueSupported: false };
  assert.equal(await handler('queueSupported', scope), false);
  scope.conv = { id: 'target', kind: 'default', archived: true, messageQueueSupported: true };
  assert.equal(await handler('queueSupported', scope), false);
  scope.conv = { id: 'target', kind: 'default', archived: false, messageQueueSupported: true };
  assert.equal(await handler('queueSupported', scope), true);
});

test('the background runner never dispatches an unsupported snapshot', async () => {
  const file = ts.createSourceFile('runner.ts', fs.readFileSync(new URL('../src/services/messageQueue/runner.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const node = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'dispatchQueuedMessage');
  const factory = (await import(dataUrl(compile(`export default scope => {
    const { dispatching, useConversationStore, useMessageQueueStore } = scope;
    ${node.getText(file).replace(/^export /, '')}
    return dispatchQueuedMessage;
  };`)))).default;
  const entry = { id: 'pending', conversationId: 'team' };
  const state = { queues: { team: { supported: false, paused: false, busy: false, entries: [entry] } } };
  let sent = false;
  const dispatch = factory({ dispatching: new Set(), useMessageQueueStore: { getState: () => state },
    useConversationStore: { getState: () => ({ isRunning: () => false, sendMessage: () => { sent = true; } }) } });
  await dispatch(entry);
  assert.equal(sent, false);
});

for (const scenario of [
  { label: "new conversation", name: "onCreateAndSend", sent: "send" },
  { label: "new workflow conversation", name: "onCreateAndSend", sent: "append", team: true },
  { label: "existing conversation", name: "onSend", sent: "send" },
  { label: "workflow change request", name: "onSend", sent: "append", gate: true }
]) {
  test(`${scenario.label} binds generated references to the actual user message`, async () => {
    const { scope, calls } = harness(scenario);
    await (await handler(scenario.name, scope))();
    assert.equal(calls.some(([kind, value]) => kind === "setPreflightMsg" && value), false);
    const attached = calls.find(([kind]) => kind === "attach")?.[1];
    const sent = calls.find(([kind]) => kind === scenario.sent)?.[1];
    assert.ok(attached && sent, "expected attachment and dispatch");
    assert.match(attached.text, /freebuddy:\/\/conversation-share/);
    assert.equal(attached.targetMessageId, sent.userMessageId ?? sent.id);
    assert.equal(attached.text, sent.prompt ?? sent.content);
    assert.deepEqual(calls.find(([kind]) => kind === "refs").slice(1), ["target", [{ id: "reference", targetMessageId: attached.targetMessageId }]]);
  });
}

for (const refreshFails of [false, true]) {
  test(`accepted delegation followup clears references without retry when refreshFails=${refreshFails}`, async () => {
    const { scope, calls } = harness({ delegation: true, refreshFails });
    await (await handler("onSend", scope))();
    assert.equal(calls.filter(([kind]) => kind === "followup").length, 1);
    assert.equal(calls.some(([kind]) => kind === "send"), false);
    assert.equal(calls.some(([kind, value]) => kind === "setPreflightMsg" && value), false);
    assert.ok(calls.some(([kind, value]) => kind === "setSelectedReferences" && value.length === 0));
    if (!refreshFails) assert.equal(calls.filter(([kind]) => kind === "refs").at(-1)[2][0].targetMessageId, "persisted-delegation-message");
  });
}
