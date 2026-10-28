import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

async function setup() {
  const db = makeDb();
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const projects = await import("../dist-electron/cli/projects.js");
  const conversations = await import("../dist-electron/cli/conversations.js");
  return {
    db,
    createConversation: conversations.createConversation,
    getConversation: conversations.getConversation,
    moveConversationToProject: conversations.moveConversationToProject,
    createProject: projects.createProject,
    getProject: projects.getProject,
    cleanup() {
      setDbForTest(null);
      db.close();
    }
  };
}

const abs = (...parts) => path.resolve("/", ...parts);

const convInput = (id, cwd) => ({
  id,
  title: id,
  agentId: "agent",
  agentName: "Agent",
  adapter: "codex-acp",
  cwd
});

test("moving a temp conversation adds its folder to the target project", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    const folder = abs("tmp", "ad-hoc-work");
    // A conversation without a matching project stays unassigned only when no
    // auto project is created; force that by creating it without a cwd.
    ctx.createConversation(convInput("conv-1"));
    const target = ctx.createProject({
      name: "Target",
      folders: [abs("tmp", "target")],
      primaryPath: abs("tmp", "target")
    });
    ctx.db.prepare("UPDATE conversations SET cwd = ? WHERE id = ?").run(folder, "conv-1");

    const moved = ctx.moveConversationToProject("conv-1", target.id);
    assert.equal(moved.projectId, target.id);
    assert.deepEqual(ctx.getProject(target.id).folders, [
      abs("tmp", "target"),
      folder
    ]);
  } finally {
    ctx.cleanup();
  }
});

test("moving between projects carries the conversation folder over", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    const folder = abs("tmp", "work");
    const source = ctx.createProject({
      name: "Source",
      folders: [folder],
      primaryPath: folder
    });
    const other = ctx.createProject({
      name: "Other",
      folders: [abs("tmp", "other")],
      primaryPath: abs("tmp", "other")
    });
    // Attach the conversation directly to the source project without letting
    // createConversation re-run the cwd matching.
    ctx.createConversation({ ...convInput("conv-1"), projectId: source.id, cwd: folder });

    const moved = ctx.moveConversationToProject("conv-1", other.id);
    assert.equal(moved.projectId, other.id);
    const otherAfter = ctx.getProject(other.id);
    assert.ok(otherAfter.folders.includes(folder), "target project now owns the folder");
    // Source project untouched.
    assert.deepEqual(ctx.getProject(source.id).folders, [folder]);
  } finally {
    ctx.cleanup();
  }
});

test("folders already covered by the target project are not duplicated", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    const folder = abs("tmp", "shared");
    const target = ctx.createProject({
      name: "Target",
      folders: [folder],
      primaryPath: folder
    });
    ctx.createConversation(convInput("conv-1", folder));

    const moved = ctx.moveConversationToProject("conv-1", target.id);
    assert.equal(moved.projectId, target.id);
    assert.deepEqual(ctx.getProject(target.id).folders, [folder]);
  } finally {
    ctx.cleanup();
  }
});

test("moving to null clears the project assignment", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    const folder = abs("tmp", "work");
    const project = ctx.createProject({ name: "P", folders: [folder], primaryPath: folder });
    ctx.createConversation({ ...convInput("conv-1"), projectId: project.id, cwd: folder });

    const moved = ctx.moveConversationToProject("conv-1", null);
    assert.equal(moved.projectId, undefined);
    // The explicit detach marker keeps the sidebar's cwd fallback from
    // regrouping the conversation under the project that owns its cwd.
    assert.equal(moved.metadata.projectDetached, true);
  } finally {
    ctx.cleanup();
  }
});

test("moving back into a project clears the detach marker", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    const folder = abs("tmp", "work");
    const project = ctx.createProject({ name: "P", folders: [folder], primaryPath: folder });
    ctx.createConversation({ ...convInput("conv-1"), projectId: project.id, cwd: folder });
    ctx.moveConversationToProject("conv-1", null);
    assert.equal(ctx.getConversation("conv-1").metadata.projectDetached, true);

    const moved = ctx.moveConversationToProject("conv-1", project.id);
    assert.equal(moved.metadata.projectDetached, undefined);
  } finally {
    ctx.cleanup();
  }
});

test("detach keeps unrelated metadata intact", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    const folder = abs("tmp", "work");
    const project = ctx.createProject({ name: "P", folders: [folder], primaryPath: folder });
    ctx.createConversation({
      ...convInput("conv-1"),
      projectId: project.id,
      cwd: folder,
      metadata: { mcpServerIds: ["srv-1"] }
    });

    const moved = ctx.moveConversationToProject("conv-1", null);
    assert.deepEqual(moved.metadata.mcpServerIds, ["srv-1"]);
    assert.equal(moved.metadata.projectDetached, true);
  } finally {
    ctx.cleanup();
  }
});

test("worktree conversations move by their source folder", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    const sourceFolder = abs("tmp", "repo");
    const worktree = abs("tmp", "repo", ".git-worktrees", "task-1");
    const target = ctx.createProject({
      name: "Target",
      folders: [abs("tmp", "target")],
      primaryPath: abs("tmp", "target")
    });
    const conversation = {
      ...convInput("conv-1", worktree),
      metadata: {
        taskWorkspace: { mode: "worktree", sourceCwd: sourceFolder }
      }
    };
    ctx.createConversation(conversation);

    ctx.moveConversationToProject("conv-1", target.id);
    const folders = ctx.getProject(target.id).folders;
    assert.ok(folders.includes(sourceFolder), "source folder added");
    assert.ok(!folders.includes(worktree), "worktree temp folder not added");
  } finally {
    ctx.cleanup();
  }
});

test("move rejects unknown conversations and projects", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    ctx.createConversation(convInput("conv-1"));
    const project = ctx.createProject({
      name: "P",
      folders: [abs("tmp", "p")],
      primaryPath: abs("tmp", "p")
    });

    assert.throws(
      () => ctx.moveConversationToProject("ghost", project.id),
      /Conversation not found/
    );
    assert.throws(
      () => ctx.moveConversationToProject("conv-1", "no-such-project"),
      /Project not found/
    );
  } finally {
    ctx.cleanup();
  }
});
