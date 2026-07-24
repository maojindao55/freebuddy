import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) =>
  fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

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
