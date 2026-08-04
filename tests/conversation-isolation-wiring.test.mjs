import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("conversation data handlers enforce ownership at the boundary", () => {
  const ipc = read("../electron/cli/ipc.ts");

  const getConv = ipc.slice(ipc.indexOf('"cli:getConversation"'));
  assert.match(getConv, /requireOwnedConversation/, "getConversation uses requireOwnedConversation");

  const del = ipc.slice(ipc.indexOf('"cli:deleteConversation"'));
  assert.match(del, /requireOwnedConversation/, "deleteConversation checks ownership");

  const listMsgs = ipc.slice(ipc.indexOf('"cli:listMessages"'));
  assert.match(listMsgs, /requireOwnedConversation/, "listMessages checks ownership");

  const append = ipc.slice(ipc.indexOf('"cli:appendMessage"'));
  assert.match(append, /requireOwnedConversation/, "appendMessage checks ownership");

  const run = ipc.slice(ipc.indexOf('"cli:run"'));
  assert.match(run, /requireOwnedConversation/, "run checks conversation ownership");
});

test("every conversation participant refreshes messages changed by another client", () => {
  const app = read("../src/App.tsx");
  const listener = app.slice(
    app.indexOf("onMessagesChanged?."),
    app.indexOf("onChromeVisible", app.indexOf("onMessagesChanged?."))
  );

  assert.doesNotMatch(
    listener,
    /currentUser\?\.isOwner|isOwner\s*!==\s*true/,
    "ordinary users must not discard updates to conversations they own"
  );
  assert.match(
    listener,
    /state\.loadMessages\(conversationId\)/,
    "the active shared conversation reloads persisted messages"
  );
  assert.match(
    listener,
    /state\.markConversationUnread\(conversationId\)/,
    "inactive shared conversations are marked unread"
  );
  assert.match(
    listener,
    /isStreaming/,
    "the initiating client still avoids duplicate reloads during its own stream"
  );
});

test("conversation mutations and handoff exports enforce ownership", () => {
  const ipc = read("../electron/cli/ipc.ts");

  // Each handler body ends at the next registerHandler call, so slicing to the
  // following registration keeps the assertion scoped to one handler.
  const handlerBody = (channel) => {
    const start = ipc.indexOf(`"${channel}"`);
    assert.ok(start > 0, `${channel} is registered`);
    const next = ipc.indexOf("registerHandler(", start);
    return next > 0 ? ipc.slice(start, next) : ipc.slice(start);
  };

  for (const channel of [
    "cli:renameConversation",
    "cli:archiveConversation",
    "cli:setConversationApprovalMode",
    "cli:setConversationConfigOptionOverrides",
    "cli:setConversationSkills",
    "cli:listConversationContextReferences",
    "cli:removeConversationContextReference",
    "cli:previewHandoffBrief",
    "cli:transferConversation",
    "cli:createConversationShare",
    "cli:attachConversationShares"
  ]) {
    assert.match(
      handlerBody(channel),
      /requireOwnedConversation/,
      `${channel} checks conversation ownership`
    );
  }

  for (const channel of ["cli:listMessage", "cli:updateMessage"]) {
    assert.match(
      handlerBody(channel),
      /callerCanAccessMessage\(/,
      `${channel} resolves ownership through the message's conversation`
    );
  }
});

test("enabling remote access backfills legacy ownership immediately", () => {
  const remoteControl = read("../electron/cli/remoteControl.ts");
  const main = read("../electron/main.ts");
  const backfill = read("../electron/cli/ownerBackfill.ts");

  const setEnabled = remoteControl.slice(remoteControl.indexOf('"remote:setEnabled"'));
  assert.match(
    setEnabled,
    /applyOwnerBackfill\(user\.id\)/,
    "remote:setEnabled backfills right after the owner is created"
  );
  assert.match(
    main,
    /applyOwnerBackfill\(user\.id\)/,
    "startup backfills after ensureOwnerUser creates the owner"
  );
  assert.match(backfill, /backfillMissingOwners/);
  assert.match(backfill, /backfillScheduledTaskOwners/);
  assert.match(backfill, /migrateGlobalRootsToOwner/);
});

test("scheduled runs execute under the task owner's identity", () => {
  const scheduled = read("../electron/cli/scheduledTasks.ts");

  const runTask = scheduled.slice(scheduled.indexOf("export async function runScheduledTask"));
  assert.match(
    runTask,
    /runAsCaller\(task\.ownerId, \(\) => executeScheduledTask\(task, webContents\)\)/,
    "the run is wrapped in the task owner's caller context"
  );

  const listRuns = scheduled.slice(scheduled.indexOf('"scheduledTasks:listRuns"'));
  assert.match(
    listRuns,
    /requireOwnedScheduledTask\(taskId\)/,
    "run history is scoped to the task owner"
  );
});

test("the remote invoke bridge runs handlers under the session user's identity", () => {
  const server = read("../electron/webUIServer.ts");
  assert.match(server, /sessionUserId\(extractBearerToken/, "resolves userId from the bearer token");
  assert.match(server, /sessionUserId\(readSessionCookie/, "resolves userId from the session cookie");
  assert.match(server, /runAsCaller\(userId/, "wraps localInvoke in the caller's identity");
});

test("desktop invokes run under the owner identity", () => {
  const registry = read("../electron/invokeRegistry.ts");
  assert.match(registry, /runAsCaller/, "registerHandler wraps handlers with a caller context");
  assert.match(registry, /getOwnerUser/, "desktop caller resolves to the owner user");
});
