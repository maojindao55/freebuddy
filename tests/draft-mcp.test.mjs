import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDraftMcpServer } from "../dist-electron/mcp/draftMcpServer.js";

test("Draft MCP exposes structured tools and forwards calls to FreeBuddy", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  process.env.FREEBUDDY_DRAFT_ENDPOINT =
    "http://127.0.0.1:17878/freebuddy/draft-tool";
  process.env.FREEBUDDY_DRAFT_TOKEN = "test-token";
  globalThis.fetch = async (input, init) => {
    const parsed = JSON.parse(String(init?.body));
    calls.push({
      endpoint: String(input),
      authorization: new Headers(init?.headers).get("Authorization"),
      action: parsed.action,
      params: parsed.params
    });
    return new Response(
      JSON.stringify({
        ok: true,
        conversationId: "conv-1",
        cwd: "/tmp/project",
        target: parsed.params?.target,
        resolvedUrl: "http://127.0.0.1:5173/",
        loadState: "ready",
        visible: true,
        ...(parsed.action === "inspect" && parsed.params?.screenshot
          ? {
              screenshot: {
                mimeType: "image/png",
                data: "iVBORw0KGgo=",
                width: 100,
                height: 80
              }
            }
          : {})
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.FREEBUDDY_DRAFT_ENDPOINT;
    delete process.env.FREEBUDDY_DRAFT_TOKEN;
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createDraftMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "freebuddy-test", version: "1.0.0" });
  await client.connect(clientTransport);
  t.after(() => client.close());
  t.after(() => server.close());

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["draft_inspect", "draft_report", "draft_show"]
  );

  const result = await client.callTool({
    name: "draft_show",
    arguments: {
      target: "http://127.0.0.1:5173/",
      open: true,
      waitForReady: true
    }
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.loadState, "ready");
  const inspected = await client.callTool({
    name: "draft_inspect",
    arguments: { screenshot: true, console: true }
  });
  assert.equal(inspected.structuredContent?.screenshot?.data, undefined);
  assert.equal(
    inspected.structuredContent?.screenshot?.width,
    100,
    JSON.stringify({ inspected, calls })
  );
  assert.equal(
    inspected.content.some(
      (entry) => entry.type === "image" && entry.data === "iVBORw0KGgo="
    ),
    true
  );
  assert.deepEqual(calls, [
    {
      endpoint: "http://127.0.0.1:17878/freebuddy/draft-tool",
      authorization: "Bearer test-token",
      action: "show",
      params: {
        target: "http://127.0.0.1:5173/",
        open: true,
        waitForReady: true
      }
    },
    {
      endpoint: "http://127.0.0.1:17878/freebuddy/draft-tool",
      authorization: "Bearer test-token",
      action: "inspect",
      params: { screenshot: true, console: true }
    }
  ]);
});
