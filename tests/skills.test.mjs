import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";

import {
  buildSkillAnnouncement,
  reconcileNativeSkillLinks
} from "../dist-electron/cli/skillRuntime.js";
import { extractSkillArchive } from "../dist-electron/cli/skillArchive.js";

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
  assert.match(db, /market_provider/);
  assert.match(db, /skill_snapshot TEXT/);
  assert.match(ipc, /skills:import/);
  assert.match(ipc, /skills:installFromMarket/);
  assert.match(acp, /registerSkillToolSession/);
  assert.match(conversations, /resolveSkillSnapshots/);
});

test("skill ZIP extraction accepts a normal Skill package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-skill-zip-"));
  const archivePath = path.join(root, "demo.zip");
  const destination = path.join(root, "expanded");
  const archive = new AdmZip();
  archive.addFile(
    "demo/SKILL.md",
    Buffer.from("---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n")
  );
  archive.addFile("demo/references/guide.md", Buffer.from("Safe reference"));
  archive.writeZip(archivePath);

  extractSkillArchive(archivePath, destination);

  assert.match(
    fs.readFileSync(path.join(destination, "demo", "SKILL.md"), "utf8"),
    /name: demo/
  );
  assert.equal(
    fs.readFileSync(path.join(destination, "demo", "references", "guide.md"), "utf8"),
    "Safe reference"
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill ZIP extraction rejects path traversal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-skill-zip-"));
  const archivePath = path.join(root, "unsafe.zip");
  const destination = path.join(root, "expanded");
  const archive = new AdmZip();
  const entry = archive.addFile("safe.txt", Buffer.from("unsafe"));
  entry.entryName = "../escape.txt";
  archive.writeZip(archivePath);

  assert.throws(
    () => extractSkillArchive(archivePath, destination),
    /path outside the archive/
  );
  assert.equal(fs.existsSync(path.join(root, "escape.txt")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill ZIP extraction rejects case-folded and file/directory path collisions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-skill-zip-"));
  const casePath = path.join(root, "case.zip");
  const prefixPath = path.join(root, "prefix.zip");
  const destination = path.join(root, "expanded");

  const caseZip = new AdmZip();
  caseZip.addFile(
    "SKILL.md",
    Buffer.from("---\nname: demo\ndescription: Demo\n---\n# Upper\n")
  );
  caseZip.addFile("skill.md", Buffer.from("# lower overwrite\n"));
  caseZip.writeZip(casePath);
  assert.throws(
    () => extractSkillArchive(casePath, destination),
    /colliding paths|duplicate path/
  );

  const prefixZip = new AdmZip();
  prefixZip.addFile("nested", Buffer.from("file pretending to be a directory root"));
  prefixZip.addFile("nested/SKILL.md", Buffer.from("---\nname: demo\ndescription: Demo\n---\n"));
  prefixZip.writeZip(prefixPath);
  assert.throws(
    () => extractSkillArchive(prefixPath, path.join(root, "expanded-prefix")),
    /colliding paths/
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test("skill ZIP extraction accepts explicit directory entries with descendant files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-skill-zip-"));
  const archivePath = path.join(root, "dirs.zip");
  const destination = path.join(root, "expanded");
  const archive = new AdmZip();
  // Market ZIPs and GitHub zipballs commonly include both directory entries and files.
  archive.addFile("demo/", Buffer.alloc(0));
  archive.addFile("demo/references/", Buffer.alloc(0));
  archive.addFile(
    "demo/SKILL.md",
    Buffer.from("---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n")
  );
  archive.addFile("demo/references/guide.md", Buffer.from("Safe reference"));
  archive.writeZip(archivePath);

  extractSkillArchive(archivePath, destination);
  assert.match(
    fs.readFileSync(path.join(destination, "demo", "SKILL.md"), "utf8"),
    /name: demo/
  );
  assert.equal(
    fs.readFileSync(path.join(destination, "demo", "references", "guide.md"), "utf8"),
    "Safe reference"
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("skills UI exposes split detail management and both import modes", () => {
  const ui = fs.readFileSync(
    new URL("../src/components/Settings/SkillsTab.tsx", import.meta.url),
    "utf8"
  );
  const preload = fs.readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  const ipc = fs.readFileSync(new URL("../electron/cli/ipc.ts", import.meta.url), "utf8");
  assert.match(ui, /skills-manager/);
  assert.match(ui, /skill-detail-pane/);
  assert.match(ui, /SkillMarketPanel/);
  assert.match(ui, /selectArchive/);
  assert.match(ui, /ReactMarkdown/);
  assert.match(preload, /skills:selectArchive/);
  assert.match(preload, /skills:installFromMarket/);
  assert.match(ipc, /extensions: \["zip"\]/);
});
