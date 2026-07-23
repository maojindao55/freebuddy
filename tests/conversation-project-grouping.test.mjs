import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadGrouping() {
  const source = fs.readFileSync(
    new URL("../src/components/CLI/conversationProjectGrouping.ts", import.meta.url),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function conversation(partial) {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    agentId: "agent",
    agentName: "Agent",
    adapter: "cli",
    skillSnapshot: [],
    archived: false,
    createdAt: partial.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? partial.lastMessageAt ?? "2026-07-01T00:00:00.000Z",
    lastMessageAt: partial.lastMessageAt,
    cwd: partial.cwd
  };
}

test("groupConversationsByProject buckets by cwd basename and sorts by activity", async () => {
  const {
    groupConversationsByProject,
    projectLabelFromCwd,
    recentConversations
  } = await loadGrouping();

  assert.equal(projectLabelFromCwd("/Users/me/Documents/freebuddy/"), "freebuddy");
  assert.equal(projectLabelFromCwd("C:\\\\work\\\\themes"), "themes");

  const groups = groupConversationsByProject([
    conversation({
      id: "a",
      title: "older freebuddy",
      cwd: "/Users/me/Documents/freebuddy",
      lastMessageAt: "2026-07-20T10:00:00.000Z"
    }),
    conversation({
      id: "b",
      title: "newer freebuddy",
      cwd: "/Users/me/Documents/freebuddy/",
      lastMessageAt: "2026-07-22T10:00:00.000Z"
    }),
    conversation({
      id: "c",
      title: "themes task",
      cwd: "/Users/me/work/themes",
      lastMessageAt: "2026-07-21T10:00:00.000Z"
    }),
    conversation({
      id: "d",
      title: "no cwd",
      lastMessageAt: "2026-07-23T10:00:00.000Z"
    })
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, "freebuddy");
  assert.deepEqual(
    groups[0].items.map((item) => item.id),
    ["b", "a"]
  );
  assert.equal(groups[1].label, "themes");

  const recent = recentConversations(
    [
      conversation({
        id: "d",
        lastMessageAt: "2026-07-23T10:00:00.000Z"
      }),
      conversation({
        id: "b",
        cwd: "/Users/me/Documents/freebuddy",
        lastMessageAt: "2026-07-22T10:00:00.000Z"
      }),
      conversation({
        id: "e",
        lastMessageAt: "2026-07-21T12:00:00.000Z"
      }),
      conversation({
        id: "c",
        cwd: "/Users/me/work/themes",
        lastMessageAt: "2026-07-21T10:00:00.000Z"
      })
    ],
    2
  );
  assert.deepEqual(
    recent.map((item) => item.id),
    ["d", "e"]
  );
});
