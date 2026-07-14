import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrowserMcpServer } from "../dist-electron/mcp/browserMcpServer.js";

const read = (relativePath) =>
  fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("information cards are persisted, bridged, and mounted in the workspace", () => {
  const db = read("../electron/cli/db.ts");
  const service = read("../electron/cli/infoCards.ts");
  const ipc = read("../electron/cli/ipc.ts");
  const preload = read("../electron/preload.ts");
  const types = read("../src/types/freebuddy.d.ts");
  const settings = read("../src/components/Settings/InfoCardsTab.tsx");
  const host = read("../src/components/InfoCards/InfoCardHost.tsx");
  const workspace = read("../src/components/CLI/WorkspacePanel.tsx");

  assert.match(db, /CREATE TABLE IF NOT EXISTS info_card_snapshots/);
  assert.match(service, /workspace\.infoCards\.v1/);
  assert.match(service, /DEFAULT_RSS_CARD_ID/);
  assert.match(service, /fetchNbaScores/);
  for (const channel of [
    "infoCards:list",
    "infoCards:create",
    "infoCards:update",
    "infoCards:delete",
    "infoCards:reorder",
    "infoCards:snapshot",
    "infoCards:refresh"
  ]) {
    assert.match(ipc, new RegExp(channel));
    assert.match(preload, new RegExp(channel));
  }
  assert.match(types, /interface FreebuddyInfoCards/);
  assert.match(types, /infoCards: FreebuddyInfoCards/);
  assert.match(settings, /SportsCardEditor/);
  assert.doesNotMatch(settings, /sportsCompetitions|sports-kind-options/);
  assert.doesNotMatch(settings, /rowSelector|waitForSelector|agentRecipeHint/);
  assert.match(host, /card\.type === "rss"/);
  assert.match(host, /<InfoDataCard/);
  assert.match(workspace, /<InfoCardHost \/>/);
});

test("browser collector remains isolated for general browser extraction", () => {
  const collector = read("../electron/browserCollector.ts");
  const service = read("../electron/browserToolService.ts");
  const runtime = read("../electron/cli/acpRuntime.ts");
  const previewServer = read("../electron/previewServer.ts");

  assert.match(collector, /nodeIntegration:\s*false/);
  assert.match(collector, /contextIsolation:\s*true/);
  assert.match(collector, /sandbox:\s*true/);
  assert.match(collector, /setPermissionRequestHandler/);
  assert.match(collector, /setWindowOpenHandler/);
  assert.match(collector, /will-download/);
  assert.match(collector, /isBlockedHostname/);
  assert.match(collector, /will-redirect/);
  assert.match(collector, /parsed\.origin !== allowedOrigin/);
  assert.match(collector, /protocol !== "https:"/);
  assert.match(service, /randomBytes\(32\)/);
  assert.match(service, /invalid_capability_token/);
  assert.doesNotMatch(service, /saveRecipe|listCards|updateInfoCard/);
  assert.match(runtime, /registerBrowserToolSession/);
  assert.match(runtime, /unregisterBrowserToolSession/);
  assert.match(previewServer, /handleBrowserToolHttpRequest/);
});

test("Browser MCP exposes bounded general collection tools", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  process.env.FREEBUDDY_BROWSER_ENDPOINT =
    "http://127.0.0.1:17878/freebuddy/browser-tool";
  process.env.FREEBUDDY_BROWSER_TOKEN = "browser-test-token";
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
        ...(parsed.action === "inspect"
          ? {
              title: "Scores",
              text: "Team A 2 Team B 1",
              screenshot: {
                mimeType: "image/png",
                data: "iVBORw0KGgo=",
                width: 120,
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
    delete process.env.FREEBUDDY_BROWSER_ENDPOINT;
    delete process.env.FREEBUDDY_BROWSER_TOKEN;
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createBrowserMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "browser-test", version: "1.0.0" });
  await client.connect(clientTransport);
  t.after(() => client.close());
  t.after(() => server.close());

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      "browser_click",
      "browser_close",
      "browser_extract",
      "browser_inspect",
      "browser_open",
      "browser_scroll",
      "browser_type"
    ]
  );

  await client.callTool({
    name: "browser_open",
    arguments: { url: "https://example.com/scores" }
  });
  const inspected = await client.callTool({
    name: "browser_inspect",
    arguments: { screenshot: true, includeHtml: false }
  });
  assert.equal(inspected.structuredContent?.screenshot?.data, undefined);
  assert.equal(
    inspected.content.some(
      (entry) => entry.type === "image" && entry.data === "iVBORw0KGgo="
    ),
    true
  );
  await client.callTool({
    name: "browser_extract",
    arguments: {
      rowSelector: ".match",
      fields: { home: ".home", away: ".away", score: ".score" },
      maxItems: 6
    }
  });
  assert.deepEqual(calls.map((call) => call.action), ["open", "inspect", "extract"]);
  assert.equal(calls.every((call) => call.authorization === "Bearer browser-test-token"), true);
});
