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
    findProjectFolderOwner: projects.findProjectFolderOwner,
    resolveWorkspaceRootsForConversation: projects.resolveWorkspaceRootsForConversation,
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

test("moving between projects does not duplicate the folder across projects", async (t) => {
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
    // The conversation's cwd already belongs to the source project; copying
    // that folder into the target project would give both projects the same
    // path and make findProjectByCwd ambiguous. The conversation stays
    // assigned via its explicit projectId instead (workspace access keeps
    // working because resolveWorkspaceRootsForConversation includes the cwd).
    assert.deepEqual(ctx.getProject(other.id).folders, [abs("tmp", "other")]);
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

test("moving a worktree preserves its source folder owner and workspace access", async (t) => {
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
    const created = ctx.createConversation(conversation);
    const source = ctx.getProject(created.projectId);

    const moved = ctx.moveConversationToProject("conv-1", target.id);
    const folders = ctx.getProject(target.id).folders;
    assert.equal(moved.projectId, target.id);
    assert.deepEqual(folders, [abs("tmp", "target")]);
    assert.deepEqual(ctx.getProject(source.id).folders, [sourceFolder]);
    assert.equal(ctx.findProjectFolderOwner(sourceFolder).id, source.id);
    assert.ok(!folders.includes(worktree), "worktree temp folder not added");
    assert.deepEqual(ctx.resolveWorkspaceRootsForConversation(moved), [worktree]);
  } finally {
    ctx.cleanup();
  }
});

test("moving a worktree does not claim a user-created source project's folder", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    const sourceFolder = abs("tmp", "repo");
    const worktree = abs("tmp", "worktrees", "task-1");
    const source = ctx.createProject({
      name: "Source", folders: [sourceFolder], primaryPath: sourceFolder
    });
    const targetFolder = abs("tmp", "target");
    const target = ctx.createProject({
      name: "Target", folders: [targetFolder], primaryPath: targetFolder
    });
    ctx.createConversation({
      ...convInput("conv-1", worktree),
      projectId: source.id,
      metadata: { taskWorkspace: { mode: "worktree", sourceCwd: sourceFolder } }
    });
    ctx.createConversation({ ...convInput("sibling", sourceFolder), projectId: source.id });

    const moved = ctx.moveConversationToProject("conv-1", target.id);

    assert.equal(moved.projectId, target.id);
    assert.deepEqual(ctx.getProject(target.id).folders, [targetFolder]);
    assert.deepEqual(ctx.getProject(source.id).folders, [sourceFolder]);
    assert.equal(ctx.findProjectFolderOwner(sourceFolder).id, source.id);
    assert.equal(ctx.getConversation("sibling").projectId, source.id);
    assert.deepEqual(ctx.resolveWorkspaceRootsForConversation(moved), [worktree]);
    assert.equal(ctx.createConversation(convInput("new", sourceFolder)).projectId, source.id);
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

test("extendProjectFolders:false skips host project folder changes", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    const folder = abs("tmp", "fresh-folder");
    const target = ctx.createProject({
      name: "Target",
      folders: [abs("tmp", "target")],
      primaryPath: abs("tmp", "target")
    });
    ctx.createConversation(convInput("conv-1", folder));

    const moved = ctx.moveConversationToProject("conv-1", target.id, {
      extendProjectFolders: false
    });
    // Assignment proceeds (per-conversation data) even though the host
    // folder list — global configuration — is left untouched.
    assert.equal(moved.projectId, target.id);
    assert.deepEqual(ctx.getProject(target.id).folders, [abs("tmp", "target")]);
  } finally {
    ctx.cleanup();
  }
});

test("workspace roots include the conversation cwd even under an unrelated project", async (t) => {
  if (!bindingAvailable) { t.skip("better-sqlite3 native binding unavailable"); return; }
  const ctx = await setup();
  try {
    const target = ctx.createProject({
      name: "Target",
      folders: [abs("tmp", "target")],
      primaryPath: abs("tmp", "target")
    });
    const cwd = abs("tmp", "elsewhere");
    const roots = ctx.resolveWorkspaceRootsForConversation({
      projectId: target.id,
      cwd
    });
    // Moving into a project whose folders do not cover the cwd must not
    // hide the conversation's own workspace from the agent.
    assert.ok(roots.includes(abs("tmp", "target")));
    assert.ok(roots.includes(cwd));
  } finally {
    ctx.cleanup();
  }
});
