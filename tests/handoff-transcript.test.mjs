import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cleanupOrphanHandoffTranscriptSnapshots,
  createHandoffTranscriptSnapshot,
  deleteHandoffTranscriptSnapshot,
  readHandoffTranscriptSnapshot
} from "../dist-electron/shared/handoffTranscript.js";

function message(overrides = {}) {
  return {
    id: "m1",
    conversationId: "A",
    role: "user",
    status: "sent",
    content: "hello",
    createdAt: "2026-07-18T00:00:00Z",
    updatedAt: "2026-07-18T00:00:00Z",
    ...overrides
  };
}

test("snapshot sanitizes secrets, inline media, private reasoning, and attachment paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-transcript-"));
  try {
    const transcript = createHandoffTranscriptSnapshot(dir, "brief/1", [
      message({
        content: "image data:image/png;base64,QUJDRA==",
        attachments: [{
          id: "a1", kind: "document", name: "notes.txt",
          path: "/private/secret/notes.txt", mimeType: "text/plain", size: 12
        }]
      }),
      message({
        id: "m2",
        role: "assistant",
        status: "done",
        content: JSON.stringify([
          { kind: "thinking", content: "private chain" },
          { kind: "text", content: "done", apiKey: "secret-value" },
          { kind: "usage", inputTokens: 42 }
        ])
      })
    ]);
    assert.equal(path.basename(transcript.path), "brief_1.jsonl");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(transcript.path).mode & 0o777, 0o600);
    }
    const loaded = readHandoffTranscriptSnapshot(dir, transcript);
    const serialized = JSON.stringify(loaded);
    assert.equal(serialized.includes("QUJDRA"), false);
    assert.equal(serialized.includes("private chain"), false);
    assert.equal(serialized.includes("secret-value"), false);
    assert.equal(serialized.includes("/private/secret"), false);
    assert.equal(loaded[1].content[0].apiKey, "[redacted]");
    assert.equal(loaded[0].attachments[0].name, "notes.txt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot keeps every JSONL record within the UTF-8 message budget", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-transcript-"));
  try {
    const transcript = createHandoffTranscriptSnapshot(dir, "large", [
      message({ role: "assistant", content: JSON.stringify([{ kind: "text", content: "你".repeat(100_000) }]) })
    ]);
    const lines = fs.readFileSync(transcript.path, "utf8").trim().split("\n");
    assert.ok(lines.every((line) => Buffer.byteLength(line, "utf8") <= 64 * 1024));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot reads and deletes only files inside its managed directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-transcript-"));
  const outside = path.join(dir, "outside.jsonl");
  fs.writeFileSync(outside, `${JSON.stringify(message())}\n`);
  const fake = { format: "jsonl", path: outside, messageCount: 1, byteSize: 1, truncated: false };
  try {
    assert.deepEqual(readHandoffTranscriptSnapshot(dir, fake), []);
    deleteHandoffTranscriptSnapshot(dir, outside);
    assert.equal(fs.existsSync(outside), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("orphan cleanup preserves referenced snapshots and removes stale files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-transcript-"));
  try {
    const kept = createHandoffTranscriptSnapshot(dir, "kept", [message()]);
    const stale = createHandoffTranscriptSnapshot(dir, "stale", [message({ id: "m2" })]);
    const temporary = path.join(dir, "handoff-snapshots", "interrupted.jsonl.tmp");
    fs.writeFileSync(temporary, "partial");
    cleanupOrphanHandoffTranscriptSnapshots(dir, [kept.path]);
    assert.equal(fs.existsSync(kept.path), true);
    assert.equal(fs.existsSync(stale.path), false);
    assert.equal(fs.existsSync(temporary), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
