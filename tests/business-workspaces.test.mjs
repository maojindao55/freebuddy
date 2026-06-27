import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("business workspace database tables are created", () => {
  const db = read("../electron/cli/db.ts");
  assert.match(db, /CREATE TABLE IF NOT EXISTS business_workspaces/);
  assert.match(db, /surfaces_json TEXT NOT NULL/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS business_requirement_runs/);
  assert.match(db, /workspace_snapshot_json TEXT NOT NULL/);
  assert.match(db, /commit_gate_json TEXT/);
});

test("business workspace modules expose CRUD and validation", () => {
  const types = read("../electron/cli/businessWorkspaceTypes.ts");
  const validate = read("../electron/cli/businessWorkspaceValidate.ts");
  const store = read("../electron/cli/businessWorkspaces.ts");
  assert.match(types, /export interface BusinessWorkspace/);
  assert.match(types, /export interface BusinessSurface/);
  assert.match(validate, /export function validateBusinessWorkspace/);
  assert.match(validate, /repoPath must be an absolute path/);
  assert.match(store, /export function listBusinessWorkspaces/);
  assert.match(store, /export function insertBusinessWorkspace/);
  assert.match(store, /export function updateBusinessWorkspace/);
  assert.match(store, /export function deleteBusinessWorkspace/);
});
