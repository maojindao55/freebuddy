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

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createContextMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

test("listTools exposes read_handoff_brief and get_handoff_origin", withManifest(sampleBrief, sampleBrief.source, async () => {
  const { client, server } = await connect();
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    assert.ok(names.includes("read_handoff_brief"));
    assert.ok(names.includes("get_handoff_origin"));
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
