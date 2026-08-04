import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("the WS broadcaster only delivers session events to the owning user", () => {
  const server = read("../electron/webUIServer.ts");

  assert.match(server, /classifyWsChannel\(channel\)/, "broadcaster classifies the channel");
  assert.match(server, /classified\.kind === "drop"/, "drops desktop-only channels");
  assert.match(server, /getSessionOwner\(classified\.sessionId\)/, "looks up the session owner");
  assert.match(
    server,
    /owner !== clientUsers\.get\(client\)/,
    "skips clients whose user does not own the session"
  );
  assert.match(
    server,
    /sessionUserId\(token\)/,
    "attaches the session userId to each WS connection on auth"
  );
});

test("conversation-scoped WS events are delivered to the conversation owner only", () => {
  const server = read("../electron/webUIServer.ts");

  const audience = server.slice(server.indexOf("function resolveChannelAudience"));
  assert.match(
    audience,
    /case "conversation":\s*\n\s*return conversationAudience\(classified\.conversationId\)/,
    "workflow message channels resolve the owner from the conversation id"
  );
  assert.match(
    audience,
    /conversationIdFromPayload\(payload\)/,
    "messages://changed resolves the conversation id from the payload"
  );

  const conversationAudience = server.slice(
    server.indexOf("function conversationAudience")
  );
  assert.match(
    conversationAudience,
    /if \(!conversation\) return \{ kind: "none" \}/,
    "events for unknown conversations are dropped"
  );
  assert.match(
    conversationAudience,
    /conversation\.ownerId \?\? getOwnerUser\(\)\?\.id/,
    "legacy conversations without an owner fall back to the desktop owner"
  );
  assert.match(
    audience,
    /ownerFromPayload\(payload\)/,
    "owner-carrying payloads resolve the owner from the payload"
  );
});

test("scheduled task changes reach remote clients", () => {
  const scheduled = read("../electron/cli/scheduledTasks.ts");

  const notify = scheduled.slice(scheduled.indexOf("function notifyChanged"));
  assert.match(
    notify,
    /safeSendToWebContents\(\s*win\.webContents,\s*"scheduledTasks:\/\/changed"/,
    "the notifier goes through the broadcasting send helper"
  );
});

test("run records the session owner and live kill preserves it until done", () => {
  const ipc = read("../electron/cli/ipc.ts");

  const run = ipc.slice(ipc.indexOf('"cli:run"'));
  assert.match(run, /recordSessionOwner\(/, "run records the session owner");

  const kill = ipc.slice(ipc.indexOf('"cli:kill"'));
  assert.match(
    kill,
    /if \(!killed\) clearSessionOwner\(sessionId\)/,
    "only a missing run is cleared immediately; a live run must broadcast done first"
  );
});
