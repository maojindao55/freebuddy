import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

test("edited imported skills refresh their record and immutable snapshot", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable");
    return;
  }

  const db = new Database(":memory:");
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  const skills = await import("../dist-electron/cli/skills.js");
  migrate(db);
  setDbForTest(db);

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const name = `refresh-${suffix}`;
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "freebuddy-skill-refresh-source-")
  );
  fs.writeFileSync(
    path.join(sourceRoot, "SKILL.md"),
    `---\nname: ${name}\ndescription: Initial instructions\nversion: 1.0.0\n---\n\n# Initial\n`
  );
  fs.mkdirSync(path.join(sourceRoot, "references"));
  fs.writeFileSync(
    path.join(sourceRoot, "references", "guide.md"),
    "Initial guide\n"
  );

  const imported = skills.importSkills(sourceRoot).imported[0];
  assert.ok(imported);
  const first = skills.resolveSkillSnapshots([name])[0];
  assert.ok(first);

  const originalReadFileSync = fs.readFileSync;
  let unchangedSourceReads = 0;
  fs.readFileSync = (...args) => {
    const target = args[0];
    if (
      typeof target === "string" &&
      path.resolve(target).startsWith(`${path.resolve(imported.rootPath)}${path.sep}`)
    ) {
      unchangedSourceReads += 1;
    }
    return originalReadFileSync(...args);
  };
  try {
    assert.equal(skills.listSkills().some((skill) => skill.id === name), true);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(unchangedSourceReads, 0);

  fs.writeFileSync(
    path.join(imported.rootPath, "SKILL.md"),
    `---\nname: ${name}\ndescription: Refreshed instructions\nversion: 2.0.0\n---\n\n# Refreshed\n`
  );

  const refreshedRecord = skills.listSkills().find((skill) => skill.id === name);
  assert.ok(refreshedRecord);
  assert.notEqual(refreshedRecord.contentHash, first.contentHash);
  const refreshed = skills.resolveSkillSnapshots([name])[0];
  assert.ok(refreshed);
  assert.notEqual(refreshed.contentHash, first.contentHash);
  assert.notEqual(refreshed.rootPath, first.rootPath);
  assert.equal(refreshed.version, "2.0.0");
  assert.match(
    fs.readFileSync(path.join(refreshed.rootPath, "SKILL.md"), "utf8"),
    /# Refreshed/
  );
  assert.equal(
    skills.listSkills().find((skill) => skill.id === name)?.contentHash,
    refreshed.contentHash
  );
  const refreshedSourceFingerprint = db
    .prepare("SELECT source_fingerprint FROM skills WHERE id = ?")
    .get(name).source_fingerprint;

  fs.writeFileSync(
    path.join(imported.rootPath, "references", "guide.md"),
    "Updated guide\n"
  );

  const assetRefreshedRecord = skills.listSkills().find((skill) => skill.id === name);
  assert.ok(assetRefreshedRecord);
  assert.notEqual(assetRefreshedRecord.contentHash, refreshed.contentHash);
  const assetRefreshedSourceFingerprint = db
    .prepare("SELECT source_fingerprint FROM skills WHERE id = ?")
    .get(name).source_fingerprint;
  assert.notEqual(assetRefreshedSourceFingerprint, refreshedSourceFingerprint);
  const assetRefreshed = skills.resolveSkillSnapshots([name])[0];
  assert.ok(assetRefreshed);
  assert.notEqual(assetRefreshed.contentHash, refreshed.contentHash);
  assert.notEqual(assetRefreshed.rootPath, refreshed.rootPath);
  assert.equal(
    fs.readFileSync(
      path.join(assetRefreshed.rootPath, "references", "guide.md"),
      "utf8"
    ),
    "Updated guide\n"
  );

  fs.unlinkSync(path.join(imported.rootPath, "references", "guide.md"));
  const deletedAssetRecord = skills.listSkills().find((skill) => skill.id === name);
  assert.ok(deletedAssetRecord);
  assert.notEqual(deletedAssetRecord.contentHash, assetRefreshed.contentHash);
  const deletedAssetSourceFingerprint = db
    .prepare("SELECT source_fingerprint FROM skills WHERE id = ?")
    .get(name).source_fingerprint;
  assert.notEqual(deletedAssetSourceFingerprint, assetRefreshedSourceFingerprint);
  const deletedAsset = skills.resolveSkillSnapshots([name])[0];
  assert.ok(deletedAsset);
  assert.notEqual(deletedAsset.contentHash, assetRefreshed.contentHash);
  assert.notEqual(deletedAsset.rootPath, assetRefreshed.rootPath);
  assert.equal(
    fs.existsSync(path.join(deletedAsset.rootPath, "references", "guide.md")),
    false
  );

  setDbForTest(null);
  db.close();
  fs.rmSync(sourceRoot, { recursive: true, force: true });
  fs.rmSync(imported.rootPath, { recursive: true, force: true });
  fs.rmSync(first.rootPath, { recursive: true, force: true });
  fs.rmSync(refreshed.rootPath, { recursive: true, force: true });
  fs.rmSync(assetRefreshed.rootPath, { recursive: true, force: true });
  fs.rmSync(deletedAsset.rootPath, { recursive: true, force: true });
});
