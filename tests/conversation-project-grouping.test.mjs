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
    projectId: partial.projectId,
    pinned: partial.pinned,
    pinnedAt: partial.pinnedAt,
    sortPosition: partial.sortPosition
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

test("conversationWorktreePath reads the real worktree directory", async () => {
  const { conversationWorktreePath } = await loadGrouping();
  assert.equal(
    conversationWorktreePath({
      cwd: "/data/task-worktrees/app-abc/task-1/src",
      metadata: {
        taskWorkspace: {
          mode: "worktree",
          sourceCwd: "/Users/me/app",
          worktreeRoot: "/data/task-worktrees/app-abc/task-1"
        }
      }
    }),
    "/data/task-worktrees/app-abc/task-1"
  );
  assert.equal(
    conversationWorktreePath({
      cwd: "/data/task-worktrees/app-abc/task-2",
      metadata: { taskWorkspace: { mode: "worktree" } }
    }),
    "/data/task-worktrees/app-abc/task-2"
  );
  assert.equal(
    conversationWorktreePath({
      cwd: "/Users/me/app",
      metadata: { taskWorkspace: { mode: "local" } }
    }),
    undefined
  );
  assert.equal(conversationWorktreePath({ cwd: "/Users/me/app" }), undefined);
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

function project(id) {
  return {
    id,
    name: id,
    folders: [`/work/${id}`],
    primaryPath: `/work/${id}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z"
  };
}

function unreadEntry(kind = "message") {
  return { kind, at: "2026-07-25T00:00:00.000Z" };
}

test("unread view includes every unread kind and counts only current conversations", async () => {
  const { unreadConversationView } = await loadGrouping();
  const items = [
    conversation({ id: "message", lastMessageAt: "2026-07-21T00:00:00.000Z" }),
    conversation({ id: "read", lastMessageAt: "2026-07-25T00:00:00.000Z" }),
    conversation({ id: "failure", lastMessageAt: "2026-07-23T00:00:00.000Z" }),
    conversation({ id: "success", lastMessageAt: "2026-07-22T00:00:00.000Z" })
  ];
  const view = unreadConversationView(items, [], {
    message: unreadEntry(),
    success: unreadEntry("success"),
    failure: unreadEntry("failure"),
    deleted: unreadEntry(),
    archived: unreadEntry("success")
  });

  assert.equal(view.count, 3);
  assert.deepEqual(view.projects, []);
  assert.deepEqual(view.recent.map((item) => item.id), ["failure", "success", "message"]);
});

test("unread view removes empty and read-only projects while preserving pinned order", async () => {
  const { groupConversationsByProjects, unreadConversationView } = await loadGrouping();
  const items = [
    conversation({ id: "old", projectId: "pinned-old", lastMessageAt: "2026-07-20T00:00:00.000Z" }),
    conversation({ id: "new", projectId: "newest", lastMessageAt: "2026-07-24T00:00:00.000Z" }),
    conversation({ id: "middle", projectId: "pinned-middle", lastMessageAt: "2026-07-22T00:00:00.000Z" }),
    conversation({ id: "already-read", projectId: "read-only", lastMessageAt: "2026-07-25T00:00:00.000Z" }),
    conversation({ id: "read-in-mixed", projectId: "pinned-old", lastMessageAt: "2026-07-23T00:00:00.000Z" })
  ];
  const projectOrder = ["empty", "pinned-old", "read-only", "pinned-middle", "newest"];
  const groups = groupConversationsByProjects(items, projectOrder.map(project));
  // The sidebar has already put pinned projects in their user-selected order.
  const orderedGroups = projectOrder.map((id) => groups.find((group) => group.key === id));
  const view = unreadConversationView(items, orderedGroups, {
    old: unreadEntry(),
    new: unreadEntry(),
    middle: unreadEntry()
  });

  assert.deepEqual(view.projects.map((group) => group.key), ["pinned-old", "pinned-middle", "newest"]);
  assert.deepEqual(view.projects.map((group) => group.items.map((item) => item.id)), [["old"], ["middle"], ["new"]]);
  assert.equal(view.projects[0].primaryPath, "/work/pinned-old");
  assert.deepEqual(view.projects[0].folders, ["/work/pinned-old"]);
  assert.deepEqual(view.recent, []);
  assert.equal(view.count, 3);
});

test("unread view lists cwd-only matches once and retains missing-project orphans", async () => {
  const { groupConversationsByProjects, groupConversationsByProject, unreadConversationView } = await loadGrouping();
  const items = [
    conversation({ id: "cwd-only", cwd: "/work/app/", lastMessageAt: "2026-07-21T00:00:00.000Z" }),
    conversation({ id: "worktree", cwd: "/tmp/worktree", sourceCwd: "/work/app", lastMessageAt: "2026-07-22T00:00:00.000Z" }),
    conversation({ id: "orphan", projectId: "removed-project", lastMessageAt: "2026-07-24T00:00:00.000Z" }),
    conversation({ id: "plain", lastMessageAt: "2026-07-23T00:00:00.000Z" })
  ];
  const unread = Object.fromEntries(items.map((item) => [item.id, unreadEntry()]));
  const groupVariants = [
    groupConversationsByProjects(items, [project("app")]),
    groupConversationsByProject(items)
  ];

  for (const groups of groupVariants) {
    const view = unreadConversationView(items, groups, unread);
    assert.deepEqual(view.projects.flatMap((group) => group.items.map((item) => item.id)), ["worktree", "cwd-only"]);
    assert.deepEqual(view.recent.map((item) => item.id), ["orphan", "plain"]);
    assert.equal(view.count, 4);
    const visibleIds = [...view.projects.flatMap((group) => group.items), ...view.recent].map((item) => item.id);
    assert.equal(new Set(visibleIds).size, visibleIds.length);
  }

  // Without any hydrated groups, project conversations remain reachable in Recent.
  const beforeProjectsLoad = unreadConversationView(items, [], unread);
  assert.deepEqual(beforeProjectsLoad.recent.map((item) => item.id), ["orphan", "plain", "worktree", "cwd-only"]);
});

test("unread view exposes matches beyond every default sidebar display limit", async () => {
  const { groupConversationsByProjects, unreadConversationView } = await loadGrouping();
  const projects = Array.from({ length: 8 }, (_, index) => project(`project-${index}`));
  const projectItems = projects.flatMap((entry) =>
    Array.from({ length: 7 }, (_, index) => conversation({
      id: `${entry.id}-task-${index}`,
      projectId: entry.id,
      lastMessageAt: `2026-07-${String(index + 10).padStart(2, "0")}T00:00:00.000Z`
    }))
  );
  const recentItems = Array.from({ length: 10 }, (_, index) => conversation({
    id: `recent-${index}`,
    lastMessageAt: `2026-07-${String(index + 10).padStart(2, "0")}T00:00:00.000Z`
  }));
  const items = [...projectItems, ...recentItems];
  const view = unreadConversationView(
    items,
    groupConversationsByProjects(items, projects),
    Object.fromEntries(items.map((item) => [item.id, unreadEntry()]))
  );

  assert.equal(view.projects.length, 8);
  for (const group of view.projects) {
    assert.deepEqual(group.items.map((item) => item.id),
      [6, 5, 4, 3, 2, 1, 0].map((index) => `${group.key}-task-${index}`));
  }
  assert.deepEqual(view.recent.map((item) => item.id),
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((index) => `recent-${index}`));
  assert.equal(view.count, 66);
});

test("reading conversations updates unread results without mutating the all view or earlier results", async () => {
  const { groupConversationsByProjects, unreadConversationView } = await loadGrouping();
  const items = [
    conversation({ id: "project-task", projectId: "app" }),
    conversation({ id: "recent-task" }),
    conversation({ id: "already-read", projectId: "app" })
  ];
  const groups = groupConversationsByProjects(items, [project("app")]);
  const unread = { "project-task": unreadEntry(), "recent-task": unreadEntry("success") };
  const initialInputs = structuredClone({ items, groups, unread });
  const freeze = (value) => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(items);
  freeze(groups);
  freeze(unread);

  const beforeRead = unreadConversationView(items, groups, unread);
  const afterProjectRead = unreadConversationView(items, groups, { "recent-task": unread["recent-task"] });
  const afterAllRead = unreadConversationView(items, groups, {});

  assert.equal(beforeRead.count, 2);
  assert.deepEqual(beforeRead.projects[0].items.map((item) => item.id), ["project-task"]);
  assert.deepEqual(beforeRead.recent.map((item) => item.id), ["recent-task"]);
  assert.deepEqual(afterProjectRead.projects, []);
  assert.deepEqual(afterProjectRead.recent.map((item) => item.id), ["recent-task"]);
  assert.equal(afterProjectRead.count, 1);
  assert.deepEqual(afterAllRead, { projects: [], recent: [], count: 0 });
  assert.deepEqual({ items, groups, unread }, initialInputs);
});

test("pinned conversations lead their group and Recent regardless of activity", async () => {
  const { groupConversationsByProjects, recentConversations } = await loadGrouping();
  const project = {
    id: "p1",
    name: "P1",
    folders: ["/tmp/p1"],
    primaryPath: "/tmp/p1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z"
  };
  const items = [
    conversation({
      id: "fresh",
      projectId: "p1",
      lastMessageAt: "2026-07-10T00:00:00.000Z"
    }),
    conversation({
      id: "pinned-old",
      projectId: "p1",
      pinned: true,
      pinnedAt: "2026-07-02T00:00:00.000Z",
      lastMessageAt: "2026-07-01T00:00:00.000Z"
    }),
    conversation({
      id: "pinned-newer",
      projectId: "p1",
      pinned: true,
      pinnedAt: "2026-07-05T00:00:00.000Z",
      lastMessageAt: "2026-07-01T00:00:00.000Z"
    })
  ];
  const [group] = groupConversationsByProjects(items, [project]);
  assert.deepEqual(
    group.items.map((item) => item.id),
    ["pinned-newer", "pinned-old", "fresh"]
  );

  const recent = recentConversations([
    conversation({ id: "r-fresh", lastMessageAt: "2026-07-10T00:00:00.000Z" }),
    conversation({
      id: "r-pinned",
      pinned: true,
      pinnedAt: "2026-07-01T00:00:00.000Z",
      lastMessageAt: "2026-07-01T00:00:00.000Z"
    })
  ]);
  assert.deepEqual(
    recent.map((item) => item.id),
    ["r-pinned", "r-fresh"]
  );
});

test("manual positions order the group and unpositioned rows lead", async () => {
  const { groupConversationsByProjects } = await loadGrouping();
  const project = {
    id: "p1",
    name: "P1",
    folders: ["/tmp/p1"],
    primaryPath: "/tmp/p1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z"
  };
  const items = [
    conversation({ id: "pos-b", projectId: "p1", sortPosition: 2048 }),
    conversation({ id: "pos-a", projectId: "p1", sortPosition: 1024 }),
    // No position: leads above positioned rows, ordered by activity.
    conversation({ id: "fresh-2", projectId: "p1", lastMessageAt: "2026-07-10T00:00:00.000Z" }),
    conversation({ id: "fresh-1", projectId: "p1", lastMessageAt: "2026-07-05T00:00:00.000Z" }),
    // Pinned beats manual position.
    conversation({ id: "pinned", projectId: "p1", pinned: true, pinnedAt: "2026-07-01T00:00:00.000Z", sortPosition: 4096 })
  ];
  const [group] = groupConversationsByProjects(items, [project]);
  assert.deepEqual(
    group.items.map((item) => item.id),
    ["pinned", "fresh-2", "fresh-1", "pos-a", "pos-b"]
  );
});
