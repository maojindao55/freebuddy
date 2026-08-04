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
    cwd: partial.cwd,
    sourceCwd: partial.sourceCwd,
    projectId: partial.projectId
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
      cwd: "/app/remote-workspaces/user/themes-a1b2c3",
      sourceCwd: "/Users/me/work/themes",
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
  assert.equal(groups[1].cwd, "/Users/me/work/themes");

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
    ["d", "b"]
  );
});

test("groups by projectId and includes empty projects", async () => {
  const { groupConversationsByProjects } = await loadGrouping();
  const projects = [
    {
      id: "p1",
      name: "App",
      folders: ["/a", "/b"],
      primaryPath: "/a",
      createdAt: "t",
      updatedAt: "t"
    },
    {
      id: "p2",
      name: "Empty",
      folders: ["/z"],
      primaryPath: "/z",
      createdAt: "t",
      updatedAt: "t"
    }
  ];
  const groups = groupConversationsByProjects(
    [
      conversation({
        id: "c1",
        projectId: "p1",
        cwd: "/a",
        lastMessageAt: "2026-07-22T10:00:00.000Z"
      })
    ],
    projects
  );
  assert.equal(groups.length, 2);
  const app = groups.find((g) => g.key === "p1");
  const empty = groups.find((g) => g.key === "p2");
  assert.equal(app?.items.length, 1);
  assert.equal(app?.projectId, "p1");
  assert.deepEqual(app?.folders, ["/a", "/b"]);
  assert.equal(app?.primaryPath, "/a");
  assert.equal(app?.label, "App");
  assert.equal(empty?.items.length, 0);
  assert.equal(empty?.label, "Empty");
});

test("remapPinnedCwdKeysToProjectIds remaps single-folder cwd keys", async () => {
  const { remapPinnedCwdKeysToProjectIds, projectKeyFromCwd } = await loadGrouping();
  const projects = [
    {
      id: "p-single",
      name: "Solo",
      folders: ["/Users/me/solo"],
      primaryPath: "/Users/me/solo",
      createdAt: "t",
      updatedAt: "t"
    },
    {
      id: "p-multi",
      name: "Multi",
      folders: ["/a", "/b"],
      primaryPath: "/a",
      createdAt: "t",
      updatedAt: "t"
    }
  ];
  const cwdKey = projectKeyFromCwd("/Users/me/solo");
  const multiKey = projectKeyFromCwd("/a");
  const remapped = remapPinnedCwdKeysToProjectIds(
    [cwdKey, multiKey, "already-id", cwdKey],
    projects
  );
  assert.deepEqual(remapped, ["p-single", multiKey, "already-id"]);
});

test("recentConversations excludes projectId conversations but keeps cwd-only", async () => {
  const { recentConversations } = await loadGrouping();
  const recent = recentConversations([
    conversation({
      id: "with-project",
      projectId: "p1",
      lastMessageAt: "2026-07-23T10:00:00.000Z"
    }),
    conversation({
      id: "plain",
      lastMessageAt: "2026-07-22T10:00:00.000Z"
    }),
    conversation({
      id: "cwd-only",
      cwd: "/tmp/x",
      lastMessageAt: "2026-07-21T10:00:00.000Z"
    })
  ]);
  assert.deepEqual(
    recent.map((item) => item.id),
    ["plain", "cwd-only"]
  );
});

test("empty projects before load does not drop projectId conversations", async () => {
  const { groupConversationsByProjects, recentConversations } = await loadGrouping();
  const items = [
    conversation({
      id: "proj-chat",
      projectId: "p1",
      cwd: "/a",
      lastMessageAt: "2026-07-23T10:00:00.000Z"
    }),
    conversation({
      id: "plain",
      lastMessageAt: "2026-07-22T10:00:00.000Z"
    })
  ];

  // Authoritative empty list with no load yet would hide project chats from groups…
  assert.equal(groupConversationsByProjects(items, []).length, 0);

  // …so until hydrated, Recent must keep projectId chats (knownProjectIds === null).
  const beforeLoad = recentConversations(items, 8, null);
  assert.deepEqual(
    beforeLoad.map((item) => item.id),
    ["proj-chat", "plain"]
  );

  // After load with the project present, exclude only known ids.
  const afterLoad = recentConversations(items, 8, new Set(["p1"]));
  assert.deepEqual(
    afterLoad.map((item) => item.id),
    ["plain"]
  );

  // After load with empty/missing projects, orphans stay in Recent.
  const orphaned = recentConversations(items, 8, new Set());
  assert.deepEqual(
    orphaned.map((item) => item.id),
    ["proj-chat", "plain"]
  );
});
