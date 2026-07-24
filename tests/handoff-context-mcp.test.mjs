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

const transcriptMessages = [
  { id: "m1", role: "user", status: "sent", content: "Build login", createdAt: "1" },
  { id: "m2", role: "assistant", status: "done", content: "Added validation", createdAt: "2" },
  { id: "m3", role: "user", status: "sent", content: "Switch authentication to JWT", createdAt: "3" }
];

function reference(id, referenceType, brief = sampleBrief, transcript) {
  return {
    id,
    referenceType,
    brief,
    source: brief.source,
    ...(transcript ? { transcript } : {}),
    createdAt: brief.generatedAt
  };
}

function withContextManifest(references, fn, messages = []) {
  return async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-context-"));
    const manifestDir = path.join(dataDir, "context-sessions");
    const snapshotDir = path.join(dataDir, "handoff-snapshots");
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.mkdirSync(snapshotDir, { recursive: true });
    let resolvedReferences = references;
    let snapshot;
    if (messages.length > 0) {
      snapshot = path.join(snapshotDir, "context-a.jsonl");
      const serialized = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
      fs.writeFileSync(snapshot, serialized);
      resolvedReferences = references.map((item, index) =>
        index === 0
          ? {
              ...item,
              transcript: {
                format: "jsonl",
                path: snapshot,
                messageCount: messages.length,
                byteSize: Buffer.byteLength(serialized),
                truncated: false
              }
            }
          : item
      );
    }
    const manifest = path.join(manifestDir, "manifest.json");
    fs.writeFileSync(manifest, JSON.stringify({ version: 4, references: resolvedReferences }));
    process.env.FREEBUDDY_CONTEXT_MANIFEST = manifest;
    try {
      await fn({ snapshot });
    } finally {
      delete process.env.FREEBUDDY_CONTEXT_MANIFEST;
      fs.rmSync(dataDir, { recursive: true, force: true });
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

test("context MCP exposes only the canonical context tools", withContextManifest(
  [reference("context-a", "transfer")],
  async () => {
    const { client, server } = await connect();
    try {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name).sort(),
        [
          "list_context_sources",
          "read_context_brief",
          "read_context_messages",
          "search_context_history"
        ]
      );
    } finally {
      await client.close();
      await server.close();
    }
  }
));

test("context tools select transfer and share references through the same API", async () => {
  const secondBrief = {
    ...sampleBrief,
    source: { ...sampleBrief.source, conversationId: "B", agentName: "Claude", title: "Second" },
    originalGoal: "review implementation"
  };
  await withContextManifest(
    [reference("context-a", "transfer"), reference("context-b", "share", secondBrief)],
    async () => {
      const { client, server } = await connect();
      try {
        const listed = await client.callTool({ name: "list_context_sources", arguments: {} });
        const sources = JSON.parse(listed.content[0].text).sources;
        assert.deepEqual(sources.map((source) => [source.contextId, source.referenceType]), [
          ["context-a", "transfer"],
          ["context-b", "share"]
        ]);

        const selected = await client.callTool({
          name: "read_context_brief",
          arguments: { contextId: "context-b" }
        });
        assert.equal(JSON.parse(selected.content[0].text).originalGoal, "review implementation");

        const compact = await client.callTool({
          name: "read_context_brief",
          arguments: { contextId: "context-a", format: "compact" }
        });
        const compactBrief = JSON.parse(compact.content[0].text);
        assert.deepEqual(compactBrief.fileChanges, ["/src/login.tsx"]);
        assert.equal(compactBrief.lastAssistantSummary, undefined);
      } finally {
        await client.close();
        await server.close();
      }
    }
  )();
});

test("read_context_messages paginates without exposing the snapshot path", withContextManifest(
  [reference("context-a", "transfer")],
  async ({ snapshot }) => {
    const { client, server } = await connect();
    try {
      const first = await client.callTool({
        name: "read_context_messages",
        arguments: { contextId: "context-a", cursor: 0, limit: 2 }
      });
      const page = JSON.parse(first.content[0].text);
      assert.deepEqual(page.messages.map((message) => message.id), ["m1", "m2"]);
      assert.equal(page.nextCursor, 2);
      assert.equal(page.hasMore, true);
      assert.equal(JSON.stringify(first).includes(snapshot), false);

      const second = await client.callTool({
        name: "read_context_messages",
        arguments: { contextId: "context-a", cursor: page.nextCursor, limit: 2 }
      });
      assert.deepEqual(JSON.parse(second.content[0].text).messages.map((message) => message.id), ["m3"]);
    } finally {
      await client.close();
      await server.close();
    }
  },
  transcriptMessages
));

test("search_context_history returns bounded positions and exact hasMore state", withContextManifest(
  [reference("context-a", "share")],
  async () => {
    const { client, server } = await connect();
    try {
      const jwt = await client.callTool({
        name: "search_context_history",
        arguments: { contextId: "context-a", query: "jwt", limit: 10 }
      });
      const one = JSON.parse(jwt.content[0].text);
      assert.equal(one.matches[0].index, 2);
      assert.equal(one.matches[0].messageId, "m3");
      assert.equal(one.hasMoreMatches, false);

      const broad = await client.callTool({
        name: "search_context_history",
        arguments: { contextId: "context-a", query: "user", limit: 1 }
      });
      assert.equal(JSON.parse(broad.content[0].text).hasMoreMatches, true);
    } finally {
      await client.close();
      await server.close();
    }
  },
  transcriptMessages
));

test("missing or corrupt context manifests return non-error empty results", async () => {
  delete process.env.FREEBUDDY_CONTEXT_MANIFEST;
  let connection = await connect();
  try {
    const result = await connection.client.callTool({ name: "read_context_brief", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /not found/i);
  } finally {
    await connection.client.close();
    await connection.server.close();
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-context-bad-"));
  const manifest = path.join(dir, "bad.json");
  fs.writeFileSync(manifest, "{not json");
  process.env.FREEBUDDY_CONTEXT_MANIFEST = manifest;
  try {
    connection = await connect();
    try {
      const result = await connection.client.callTool({ name: "list_context_sources", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /No conversation context sources/);
    } finally {
      await connection.client.close();
      await connection.server.close();
    }
  } finally {
    delete process.env.FREEBUDDY_CONTEXT_MANIFEST;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
