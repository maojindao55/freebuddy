import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadPolicy() {
  const source = fs.readFileSync(
    new URL("../electron/shared/wsChannelPolicy.ts", import.meta.url),
    "utf8"
  );
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
  );
}

test("classifyWsChannel routes global, session-scoped, and desktop-only channels", async () => {
  const { classifyWsChannel } = await loadPolicy();

  assert.deepEqual(classifyWsChannel("cli://runtime"), { kind: "global" });
  assert.deepEqual(classifyWsChannel("infoCards://changed"), { kind: "global" });
  assert.deepEqual(classifyWsChannel("conversations://changed"), { kind: "global" });

  assert.deepEqual(classifyWsChannel("cli://abc-123"), {
    kind: "session",
    sessionId: "abc-123"
  });

  assert.deepEqual(classifyWsChannel("cli://install"), { kind: "drop" });
  assert.deepEqual(classifyWsChannel("window:chrome"), { kind: "drop" });
  assert.deepEqual(classifyWsChannel("freebuddy://bridge"), { kind: "drop" });
  assert.deepEqual(classifyWsChannel("updater://event"), { kind: "drop" });
  assert.deepEqual(classifyWsChannel("unknown://whatever"), { kind: "drop" });

  // Draft MCP events carry conversationId in the payload so WebUI can open
  // the Draft panel for the owning conversation.
  assert.deepEqual(classifyWsChannel("freebuddy://draft-tool"), {
    kind: "conversationPayload"
  });
});

test("conversation-scoped channels are classified for per-owner delivery", async () => {
  const { classifyWsChannel, conversationIdFromPayload } = await loadPolicy();

  assert.deepEqual(classifyWsChannel("messages://changed"), {
    kind: "conversationPayload"
  });
  assert.deepEqual(classifyWsChannel("workflow://message/conv-1"), {
    kind: "conversation",
    conversationId: "conv-1"
  });
  assert.deepEqual(classifyWsChannel("workflow://event/conv-1"), {
    kind: "conversation",
    conversationId: "conv-1"
  });
  assert.deepEqual(classifyWsChannel("workflow://message/"), { kind: "drop" });
  assert.deepEqual(classifyWsChannel("workflow://event/"), { kind: "drop" });

  assert.equal(conversationIdFromPayload({ conversationId: "conv-1" }), "conv-1");
  assert.equal(conversationIdFromPayload({ conversationId: "" }), null);
  assert.equal(conversationIdFromPayload({ at: 1 }), null);
  assert.equal(conversationIdFromPayload(null), null);
});

test("owner-carrying payloads are classified for per-owner delivery", async () => {
  const { classifyWsChannel, ownerFromPayload } = await loadPolicy();

  assert.deepEqual(classifyWsChannel("scheduledTasks://changed"), {
    kind: "ownerPayload"
  });

  assert.deepEqual(ownerFromPayload({ id: "t1", ownerId: "alice" }), {
    kind: "owner",
    ownerId: "alice"
  });
  assert.deepEqual(ownerFromPayload({ id: "t1", ownerId: null }), {
    kind: "owner",
    ownerId: null
  });
  // No record attached: nothing to leak, so every client may refetch.
  assert.deepEqual(ownerFromPayload(undefined), { kind: "signal" });
});
