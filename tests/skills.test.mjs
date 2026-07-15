import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSkillAnnouncement,
  reconcileNativeSkillLinks
} from "../dist-electron/cli/skillRuntime.js";

const snapshot = (name, rootPath) => ({
  id: name,
  name,
  description: `${name} instructions`,
  version: "1.2.3",
  source: "imported",
  rootPath,
  contentHash: "abc123"
});

test("skill announcement exposes the selected catalog without replacing the prompt", () => {
  const result = buildSkillAnnouncement("Fix the bug", [snapshot("verify-change", "/tmp/skill")]);
  assert.match(result, /verify-change \(1\.2\.3\): verify-change instructions/);
  assert.match(result, /skill_list and skill_load/);
  assert.match(result, /skill_read_resource/);
  assert.ok(result.endsWith("Fix the bug"));
});

test("native skill mounting reconciles only FreeBuddy-owned symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-skills-"));
  const cwd = path.join(root, "workspace");
  const selectedRoot = path.join(root, "selected");
  const staleRoot = path.join(root, "stale");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(selectedRoot, { recursive: true });
  fs.mkdirSync(staleRoot, { recursive: true });
  const nativeDir = path.join(cwd, ".agents", "skills");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.symlinkSync(staleRoot, path.join(nativeDir, "stale"), "dir");
  fs.mkdirSync(path.join(nativeDir, "user-owned"));

  reconcileNativeSkillLinks(
    cwd,
    [".agents/skills"],
    [snapshot("selected", selectedRoot)],
    [selectedRoot, staleRoot]
  );

  assert.equal(
    fs.realpathSync(path.join(nativeDir, "selected")),
    fs.realpathSync(selectedRoot)
  );
  assert.equal(fs.existsSync(path.join(nativeDir, "stale")), false);
  assert.equal(fs.statSync(path.join(nativeDir, "user-owned")).isDirectory(), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill persistence, IPC, MCP, and conversation snapshots stay wired", () => {
  const db = fs.readFileSync(new URL("../electron/cli/db.ts", import.meta.url), "utf8");
  const ipc = fs.readFileSync(new URL("../electron/cli/ipc.ts", import.meta.url), "utf8");
  const acp = fs.readFileSync(new URL("../electron/cli/acpRuntime.ts", import.meta.url), "utf8");
  const conversations = fs.readFileSync(new URL("../electron/cli/conversations.ts", import.meta.url), "utf8");
  assert.match(db, /CREATE TABLE IF NOT EXISTS skills/);
  assert.match(db, /skill_snapshot TEXT/);
  assert.match(ipc, /skills:import/);
  assert.match(acp, /registerSkillToolSession/);
  assert.match(conversations, /resolveSkillSnapshots/);
});
