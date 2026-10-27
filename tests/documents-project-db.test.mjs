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

async function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  migrate(db);
  setDbForTest(db);
  const projects = await import("../dist-electron/cli/projects.js");
  const conversations = await import("../dist-electron/cli/conversations.js");
  return {
    db,
    projects,
    conversations,
    cleanup() {
      setDbForTest(null);
      db.close();
    }
  };
}

const abs = (...parts) => path.resolve("/", ...parts);

test("doc-studio conversation in an existing project inherits the project", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }
  const ctx = await setup();
  try {
    const project = ctx.projects.createProject({
      name: "My Repo",
      folders: [abs("work", "my-repo")],
      primaryPath: abs("work", "my-repo")
    });

    const docConv = ctx.conversations.createConversation({
      id: "doc-1",
      title: "Doc in Repo",
      agentId: "agent",
      agentName: "Agent",
      adapter: "codex-acp",
      kind: "doc-studio",
      cwd: abs("work", "my-repo", "docs")
    });

    assert.equal(docConv.projectId, project.id);
    // Should NOT create an extra "docs" project
    assert.equal(ctx.projects.listProjects().length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("doc-studio conversation outside existing projects groups under DocStudio system project", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }
  const ctx = await setup();
  try {
    const standaloneDoc = ctx.conversations.createConversation({
      id: "doc-standalone",
      title: "Standalone Note",
      agentId: "agent",
      agentName: "Agent",
      adapter: "codex-acp",
      kind: "doc-studio",
      cwd: abs("Users", "mac", "Downloads")
    });

    const docProject = ctx.projects.getProject(standaloneDoc.projectId);
    assert.ok(docProject);
    assert.equal(docProject.kind, "documents");
    assert.equal(docProject.name, "DocStudio");

    // Does NOT create a project named "Downloads"
    const downloadsProject = ctx.projects.listProjects().find((p) => p.name === "Downloads");
    assert.equal(downloadsProject, undefined);
  } finally {
    ctx.cleanup();
  }
});

test("subfolder conversations automatically find containing project", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }
  const ctx = await setup();
  try {
    const project = ctx.projects.createProject({
      name: "Frontend",
      folders: [abs("apps", "frontend")],
      primaryPath: abs("apps", "frontend")
    });

    const matched = ctx.projects.findContainingProject(abs("apps", "frontend", "src", "components"));
    assert.equal(matched?.id, project.id);

    const outside = ctx.projects.findContainingProject(abs("apps", "backend"));
    assert.equal(outside, null);
  } finally {
    ctx.cleanup();
  }
});
