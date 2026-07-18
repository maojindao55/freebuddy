import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createContextMcpServer } from "../dist-electron/mcp/contextMcpServer.js";

const sampleBrief = {
  version: 1,
  generatedAt: "2026-07-18T00:00:00Z",
  source: {
    conversationId: "A", agentId: "A", agentName: "Codex",
    adapter: "codex", title: "T", messageCount: 5
  },
  originalGoal: "implement login",
  recentUserMessages: ["use JWT"],
  lastAssistantSummary: "form validation done",
  fileChanges: [{ path: "/src/login.tsx", action: "edit" }],
  transcriptExcerpts: []
};

function withManifest(brief, source, fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-ctx-"));
    const file = path.join(dir, "m.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, brief, briefId: "b1", source }));
    process.env.FREEBUDDY_HANDOFF_MANIFEST = file;
    try {
      await fn();
    } finally {
      delete process.env.FREEBUDDY_HANDOFF_MANIFEST;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function withTranscriptManifest(messages, fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-ctx-history-"));
    const manifestDir = path.join(dir, "context-sessions");
    const snapshotDir = path.join(dir, "handoff-snapshots");
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshot = path.join(snapshotDir, "b1.jsonl");
    const serialized = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    fs.writeFileSync(snapshot, serialized);
    const file = path.join(manifestDir, "m.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 2,
      brief: sampleBrief,
      briefId: "b1",
      source: sampleBrief.source,
      transcript: {
        format: "jsonl",
        path: snapshot,
        messageCount: messages.length,
        byteSize: Buffer.byteLength(serialized),
        truncated: false
      }
    }));
    process.env.FREEBUDDY_HANDOFF_MANIFEST = file;
    try {
      await fn({ snapshot });
    } finally {
      delete process.env.FREEBUDDY_HANDOFF_MANIFEST;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createContextMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

test("listTools exposes brief, origin, page, and search tools", withManifest(sampleBrief, sampleBrief.source, async () => {
  const { client, server } = await connect();
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    assert.ok(names.includes("read_handoff_brief"));
    assert.ok(names.includes("get_handoff_origin"));
    assert.ok(names.includes("read_handoff_messages"));
    assert.ok(names.includes("search_handoff_history"));
  } finally {
    await client.close();
    await server.close();
  }
}));

const transcriptMessages = [
  { id: "m1", role: "user", status: "sent", content: "Build login", createdAt: "1" },
  { id: "m2", role: "assistant", status: "done", content: "Added validation", createdAt: "2" },
  { id: "m3", role: "user", status: "sent", content: "Switch authentication to JWT", createdAt: "3" }
];

test("read_handoff_messages paginates without exposing the snapshot path", withTranscriptManifest(transcriptMessages, async ({ snapshot }) => {
  const { client, server } = await connect();
  try {
    const first = await client.callTool({
      name: "read_handoff_messages",
      arguments: { cursor: 0, limit: 2 }
    });
    const page = JSON.parse(first.content[0].text);
    assert.deepEqual(page.messages.map((message) => message.id), ["m1", "m2"]);
    assert.equal(page.nextCursor, 2);
    assert.equal(page.hasMore, true);
    assert.equal(JSON.stringify(first).includes(snapshot), false);

    const second = await client.callTool({
      name: "read_handoff_messages",
      arguments: { cursor: page.nextCursor, limit: 2 }
    });
    const nextPage = JSON.parse(second.content[0].text);
    assert.deepEqual(nextPage.messages.map((message) => message.id), ["m3"]);
    assert.equal(nextPage.hasMore, false);
  } finally {
    await client.close();
    await server.close();
  }
}));

test("search_handoff_history returns bounded positions and exact hasMore state", withTranscriptManifest(transcriptMessages, async () => {
  const { client, server } = await connect();
  try {
    const jwt = await client.callTool({
      name: "search_handoff_history",
      arguments: { query: "jwt", limit: 10 }
    });
    const one = JSON.parse(jwt.content[0].text);
    assert.equal(one.matches[0].index, 2);
    assert.equal(one.matches[0].messageId, "m3");
    assert.equal(one.hasMoreMatches, false);

    const broad = await client.callTool({
      name: "search_handoff_history",
      arguments: { query: "user", limit: 1 }
    });
    assert.equal(JSON.parse(broad.content[0].text).hasMoreMatches, true);
  } finally {
    await client.close();
    await server.close();
  }
}));

test("read_handoff_brief full returns complete brief", withManifest(sampleBrief, sampleBrief.source, async () => {
  const { client, server } = await connect();
  try {
    const res = await client.callTool({ name: "read_handoff_brief", arguments: {} });
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.originalGoal, "implement login");
    assert.deepEqual(res.structuredContent.brief.originalGoal, "implement login");
  } finally {
    await client.close();
    await server.close();
  }
}));

test("read_handoff_brief compact returns only originalGoal/recentUserMessages/fileChanges paths", withManifest(sampleBrief, sampleBrief.source, async () => {
  const { client, server } = await connect();
  try {
    const res = await client.callTool({ name: "read_handoff_brief", arguments: { format: "compact" } });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.originalGoal, "implement login");
    assert.deepEqual(parsed.recentUserMessages, ["use JWT"]);
    assert.deepEqual(parsed.fileChanges, ["/src/login.tsx"]);
    assert.equal(parsed.lastAssistantSummary, undefined);
    assert.deepEqual(res.structuredContent.brief, parsed);
    assert.equal(res.structuredContent.brief.lastAssistantSummary, undefined);
  } finally {
    await client.close();
    await server.close();
  }
}));

test("read_handoff_brief: missing manifest -> non-error empty result", async () => {
  delete process.env.FREEBUDDY_HANDOFF_MANIFEST;
  const { client, server } = await connect();
  try {
    const res = await client.callTool({ name: "read_handoff_brief", arguments: {} });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /No handoff brief/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("read_handoff_brief: corrupted manifest file -> non-error empty result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-ctx-"));
  const file = path.join(dir, "bad.json");
  fs.writeFileSync(file, "{not json");
  process.env.FREEBUDDY_HANDOFF_MANIFEST = file;
  try {
    const { client, server } = await connect();
    try {
      const res = await client.callTool({ name: "read_handoff_brief", arguments: {} });
      assert.equal(res.isError, undefined);
      assert.match(res.content[0].text, /No handoff brief/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    delete process.env.FREEBUDDY_HANDOFF_MANIFEST;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("get_handoff_origin returns only source metadata", withManifest(sampleBrief, sampleBrief.source, async () => {
  const { client, server } = await connect();
  try {
    const res = await client.callTool({ name: "get_handoff_origin", arguments: {} });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.agentName, "Codex");
    assert.equal(parsed.adapter, "codex");
    assert.equal(parsed.originalGoal, undefined);
  } finally {
    await client.close();
    await server.close();
  }
}));

test("get_handoff_origin: missing manifest -> non-error", async () => {
  delete process.env.FREEBUDDY_HANDOFF_MANIFEST;
  const { client, server } = await connect();
  try {
    const res = await client.callTool({ name: "get_handoff_origin", arguments: {} });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /No handoff origin/);
  } finally {
    await client.close();
    await server.close();
  }
});
