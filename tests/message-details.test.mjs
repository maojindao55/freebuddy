import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { readLogDetailsPage, restoreLogItems } = await import("../dist-electron/cli/messageDetails.js");

test("detail pages reconstruct a long UTF-8 line without loading the full log", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "freebuddy-detail-"));
  try {
    const file = path.join(dir, "run.jsonl");
    const text = "🙂".repeat(100_000) + "\nfinal result\n";
    await writeFile(file, text);
    let offset = 0;
    let reconstructed = "";
    let pages = 0;
    while (true) {
      const page = await readLogDetailsPage(file, offset);
      assert.ok(Buffer.byteLength(page.text) <= 128 * 1024);
      assert.ok(page.nextOffset > offset);
      assert.doesNotMatch(page.text, /\uFFFD/);
      reconstructed += page.text;
      pages++;
      if (!page.hasMore) break;
      offset = page.nextOffset;
    }
    assert.equal(reconstructed, text);
    assert.ok(pages > 1);
    assert.equal((await readLogDetailsPage(file, Buffer.byteLength(text))).hasMore, false);
    assert.equal((await readLogDetailsPage(path.join(dir, "missing"))).available, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("detail paging retains complete short log lines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "freebuddy-detail-lines-"));
  try {
    const file = path.join(dir, "run.jsonl");
    await writeFile(file, ("short log line\n").repeat(20_000));
    const page = await readLogDetailsPage(file);
    assert.ok(page.text.endsWith("\n"));
    assert.equal(page.nextOffset, Buffer.byteLength(page.text));
    assert.ok(page.hasMore);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

 test("log restoration uses normal ACP items and ignores diagnostics and user input", () => {
  const log = (update) => JSON.stringify({type: "stdout", content: JSON.stringify({method: "session/update", params: {update}})});
  const items = restoreLogItems([
    log({sessionUpdate: "agent_message_chunk", content: {type: "text", text: "answer"}}),
    log({sessionUpdate: "agent_thought_chunk", content: {type: "text", text: "thinking"}}),
    log({sessionUpdate: "user_message_chunk", content: {type: "text", text: "private question"}}),
    JSON.stringify({type: "stderr", content: "diagnostic"}),
    "partial JSON"
  ].join("\n"));
  assert.ok(items.some((item) => item.kind === "text" && item.content === "answer"));
  assert.ok(items.some((item) => item.kind === "thinking"));
  assert.equal(items.length, 2);
});
