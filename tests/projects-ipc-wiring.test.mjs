import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) =>
  fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const CHANNELS = [
  "cli:listProjects",
  "cli:createProject",
  "cli:ensureProjectForCwd",
  "cli:updateProject",
  "cli:deleteProject",
  "cli:getProject"
];

test("project IPC channels are registered end-to-end", () => {
  const ipc = read("electron/cli/ipc.ts");
  const preload = read("electron/preload.ts");
  const client = read("src/services/cli/client.ts");
  for (const name of CHANNELS) {
    assert.match(ipc, new RegExp(name.replace(":", "\\:")));
  }
  assert.match(preload, /listProjects/);
  assert.match(preload, /createProject/);
  assert.match(preload, /ensureProjectForCwd/);
  assert.match(preload, /updateProject/);
  assert.match(preload, /deleteProject/);
  assert.match(preload, /getProject/);
  assert.match(client, /listProjects/);
  assert.match(client, /createProject/);
  assert.match(client, /ensureProjectForCwd/);
  assert.match(client, /updateProject/);
  assert.match(client, /deleteProject/);
  assert.match(client, /getProject/);
});

test("renderer types expose Project and workspaceRoots", () => {
  const types = read("src/services/cli/types.ts");
  const freebuddy = read("src/types/freebuddy.d.ts");
  const runtimeShared = read("electron/cli/runtimeShared.ts");

  assert.match(types, /export interface Project \{/);
  assert.match(types, /projectId\?:/);
  assert.match(types, /workspaceRoots\?: string\[\]/);
  assert.match(runtimeShared, /workspaceRoots\?: string\[\]/);
  assert.match(freebuddy, /listProjects\(/);
  assert.match(freebuddy, /createProject\(/);
  assert.match(freebuddy, /ensureProjectForCwd\(/);
  assert.match(freebuddy, /updateProject\(/);
  assert.match(freebuddy, /deleteProject\(/);
  assert.match(freebuddy, /getProject\(/);
});
