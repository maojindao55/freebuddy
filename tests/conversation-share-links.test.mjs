import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const read = (rel) =>
  fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const shareLinksModule = ts.transpileModule(
  read("src/utils/conversationShareLinks.ts"),
  {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }
).outputText;
const {
  assignShareReferencesToMessages,
  extractConversationShareTokens,
  stripConversationShareLinks
} = await import(
  `data:text/javascript;base64,${Buffer.from(shareLinksModule).toString("base64")}`
);

const token = "3YjZbEnMtdOwSZd4akzNrQafS0DwjFpD";
const link = `freebuddy://conversation-share/v1/${token}`;
const message = (id, content, overrides = {}) => ({
  id,
  conversationId: "target",
  role: "user",
  content,
  createdAt: "2026-10-23T10:00:00.000Z",
  ...overrides
});
const reference = (id, targetMessageId, overrides = {}) => ({
  id,
  snapshotId: `snapshot-${id}`,
  targetConversationId: "target",
  targetMessageId,
  referenceType: "share",
  createdAt: "2026-10-23T10:00:00.000Z",
  ...overrides
});

test("conversation share link helpers strip links and pair refs to user messages", () => {
  const src = read("src/utils/conversationShareLinks.ts");
  const chat = read("src/components/CLI/ChatView.tsx");
  const bubble = read("src/components/CLI/MessageBubble.tsx");

  assert.match(src, /export function extractConversationShareTokens/);
  assert.match(src, /export function stripConversationShareLinks/);
  assert.match(src, /export function assignShareReferencesToMessages/);
  assert.match(src, /freebuddy:\\\/\\\/conversation-share\\\/v1\\\//);

  assert.match(chat, /assignShareReferencesToMessages/);
  assert.match(chat, /shareReferencesByMessageId/);
  assert.match(chat, /afterContent=/);
  assert.match(bubble, /stripConversationShareLinks/);
  assert.match(bubble, /afterContent/);
});

test("share link regex in helper matches freebuddy conversation share urls", () => {
  const src = read("src/utils/conversationShareLinks.ts");
  const match = src.match(
    /CONVERSATION_SHARE_LINK_RE =\s*\/(.+)\/([gimsuy]*)/
  );
  assert.ok(match, "expected CONVERSATION_SHARE_LINK_RE literal");
  const re = new RegExp(match[1], match[2]);
  const token = "3YjZbEnMtdOwSZd4akzNrQafS0DwjFpD";
  const text = `请看这个\nfreebuddy://conversation-share/v1/${token}\n谢谢`;
  assert.deepEqual([...text.matchAll(re)].map((item) => item[1]), [token]);
});

test("share link helpers deduplicate tokens and hide URLs in user text", () => {
  assert.deepEqual(extractConversationShareTokens(`${link}\n${link}`), [token]);
  assert.equal(stripConversationShareLinks(`请看这个\n${link}\n谢谢`), "请看这个\n\n谢谢");
});

test("an unloaded share message never moves its card onto newer user messages", () => {
  const refs = [reference("original-ref", "original")];
  const recent = [message("followup-1", "继续处理")];
  assert.equal(assignShareReferencesToMessages(recent, refs).size, 0);
  recent.push(message("followup-2", "再看一下"));
  assert.equal(assignShareReferencesToMessages(recent, refs).size, 0);

  const original = message("original", link);
  const loaded = assignShareReferencesToMessages([original, ...recent], refs);
  assert.deepEqual([...loaded], [["original", refs]]);
});

test("partial history and repeated links do not consume another message's reference", () => {
  const older = reference("older-ref", "older");
  const visible = reference("visible-ref", "visible");
  const messages = [message("visible", link), message("repeat", link)];
  assert.deepEqual(
    [...assignShareReferencesToMessages(messages, [older, visible])],
    [["visible", [visible]]]
  );
});

test("share cards use message identity even with reordered messages and references", () => {
  const first = message("first", link);
  const second = message("second", `${link}\n${link}`);
  const firstRef = reference("first-ref", "first");
  const secondRefs = [reference("second-a", "second"), reference("second-b", "second")];
  const assigned = assignShareReferencesToMessages(
    [second, first],
    [...secondRefs, firstRef]
  );
  assert.deepEqual(assigned.get("first"), [firstRef]);
  assert.deepEqual(assigned.get("second"), secondRefs);
});

test("unbound, transfer, assistant, and other-conversation refs cannot attach to a user bubble", () => {
  const messages = [message("user", link), message("assistant", link, { role: "assistant" })];
  const refs = [
    reference("unbound", undefined),
    reference("transfer", "user", { referenceType: "transfer" }),
    reference("assistant-ref", "assistant"),
    reference("other-conversation", "user", { targetConversationId: "other" })
  ];
  assert.equal(assignShareReferencesToMessages(messages, refs).size, 0);
});
