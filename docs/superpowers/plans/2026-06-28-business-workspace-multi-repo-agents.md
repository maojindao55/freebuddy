# Business Workspace Multi-Repo Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first working Business Workspace MVP so FreeBuddy can configure a business made of multiple repos, generate a semi-automatic per-surface assignment plan, run each surface in its own repo, and commit all completed repos through one approval gate.

**Architecture:** Keep Business Workspace separate from Workflow Team. Add Electron-main persistence/validation for business workspaces and requirement runs, expose them through preload + typed renderer clients, then add a renderer flow for Business Requirement mode. The runtime layer reuses existing `cliRun()` for per-surface agent tasks, stores structured run state in SQLite, and uses a local Git commit gate that creates one branch and commit per repo only after user approval.

**Tech Stack:** Electron main process TypeScript, `better-sqlite3`, React, Zustand, i18next, Node built-in test runner, static source wiring tests used by the current repo.

**Spec:** `docs/superpowers/specs/2026-06-28-business-workspace-multi-repo-agents.zh-CN.md`

---

## File Structure

**New Electron main files:**
- `electron/cli/businessWorkspaceTypes.ts` — shared main-process types for workspaces, surfaces, assignment plans, runs, verification, and commit gates.
- `electron/cli/businessWorkspaceValidate.ts` — pure validation helpers for workspaces, assignment plans, contract drafts, and commit gates.
- `electron/cli/businessWorkspaces.ts` — SQLite row mapping and CRUD for `business_workspaces`.
- `electron/cli/businessRequirementRuns.ts` — SQLite row mapping and CRUD for `business_requirement_runs`.
- `electron/cli/businessAssignmentPlanner.ts` — deterministic MVP planner that groups enabled surfaces, assigns agents, builds dependencies, and creates contract drafts when provider/consumer surfaces exist.
- `electron/cli/businessCommitGate.ts` — local Git helper for status, diff summary, branch creation, staging, and commit.
- `electron/cli/businessRequirementRuntime.ts` — orchestrates surface execution with `cliRun()`, verification commands, and commit gate preparation.
- `electron/cli/businessWorkspaceIpc.ts` — IPC handlers for workspace CRUD, assignment preview, run lifecycle, and commit gate approval.

**New renderer files:**
- `src/services/businessWorkspaces/types.ts` — renderer mirror types.
- `src/services/businessWorkspaces/client.ts` — typed bridge wrapper.
- `src/store/businessWorkspaceStore.ts` — workspace list/edit state.
- `src/store/businessRequirementRunStore.ts` — assignment preview and active business run state.
- `src/components/Settings/BusinessWorkspacesTab.tsx`
- `src/components/Settings/BusinessWorkspaceList.tsx`
- `src/components/Settings/BusinessWorkspaceEditor.tsx`
- `src/components/Business/BusinessAssignmentPreviewCard.tsx`
- `src/components/Business/BusinessSurfaceRunPanel.tsx`
- `src/components/Business/BusinessCommitGateCard.tsx`

**Modify existing files:**
- `electron/cli/db.ts` — add `business_workspaces` and `business_requirement_runs` tables.
- `electron/cli/ipc.ts` — register `registerBusinessWorkspaceIpc()`.
- `electron/preload.ts` — expose `businessWorkspaces`.
- `src/types/freebuddy.d.ts` — add `FreebuddyBusinessWorkspaces`.
- `src/components/Settings/SettingsModal.tsx` — add Business Workspaces tab.
- `src/components/CLI/ChatView.tsx` — add Business Requirement mode and assignment preview.
- `src/components/CLI/WorkspacePanel.tsx` — mount the business surface run panel when active.
- `src/locales/en.json`, `src/locales/zh-CN.json` — business workspace strings.
- `styles.css` — settings editor, assignment preview, surface status, and commit gate styles.

**New tests:**
- `tests/business-workspaces.test.mjs`
- `tests/business-assignment-planner.test.mjs`
- `tests/business-runtime.test.mjs`
- `tests/business-ui.test.mjs`

---

### Task 1: Types, Validation, and Database Tables

**Files:**
- Create: `electron/cli/businessWorkspaceTypes.ts`
- Create: `electron/cli/businessWorkspaceValidate.ts`
- Create: `electron/cli/businessWorkspaces.ts`
- Modify: `electron/cli/db.ts`
- Test: `tests/business-workspaces.test.mjs`

- [ ] **Step 1: Write validation and schema tests**

Add these assertions to `tests/business-workspaces.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the new test and verify it fails**

Run: `npm run build:electron && node --test tests/business-workspaces.test.mjs`

Expected: FAIL because the business workspace files and table strings do not exist yet.

- [ ] **Step 3: Create `electron/cli/businessWorkspaceTypes.ts`**

Define the exact interfaces from the approved spec:

```ts
export type BusinessSurfaceKind =
  | "client"
  | "server"
  | "admin"
  | "shared"
  | "docs"
  | "test"
  | "custom";

export type ContractRole = "provider" | "consumer" | "both" | "none";

export interface BusinessSurface {
  id: string;
  name: string;
  kind: BusinessSurfaceKind;
  repoPath: string;
  defaultAgentId: string;
  allowedPaths: string[];
  verifyCommands: string[];
  responsibilities: string[];
  contractRole: ContractRole;
  enabled: boolean;
}

export interface BusinessWorkspacePolicy {
  requireAssignmentApproval: true;
  requireCommitApproval: true;
  blockCommitOnVerificationFailure: boolean;
  requireCleanRepoBeforeRun: boolean;
  branchNameTemplate: string;
}

export interface BusinessWorkspace {
  id: string;
  name: string;
  description?: string;
  surfaces: BusinessSurface[];
  defaultTeamId?: string;
  policy: BusinessWorkspacePolicy;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessAssignmentPlan {
  surfaces: Array<{
    surfaceId: string;
    agentId: string;
    repoPath: string;
    tasks: string[];
    dependsOnSurfaceIds: string[];
    writes: boolean;
    verifyCommands: string[];
  }>;
  dependencies: Array<{
    fromSurfaceId: string;
    toSurfaceId: string;
    reason: string;
  }>;
  needsContractDraft: boolean;
  summary: string;
}

export interface BusinessContractDraft {
  id: string;
  title: string;
  providerSurfaceIds: string[];
  consumerSurfaceIds: string[];
  endpoints: Array<{
    method: string;
    path: string;
    request: string;
    response: string;
    errors: string[];
  }>;
  dataRules: string[];
  permissionRules: string[];
  notes: string[];
}

export interface BusinessVerificationResult {
  command: string;
  cwd: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  summary: string;
  startedAt?: string;
  endedAt?: string;
}

export interface BusinessSurfaceRun {
  id: string;
  surfaceId: string;
  agentId: string;
  repoPath: string;
  status:
    | "pending"
    | "waiting_contract"
    | "running"
    | "verifying"
    | "done"
    | "failed"
    | "blocked";
  taskSummary: string;
  verificationResults: BusinessVerificationResult[];
  diffSummary?: string;
  riskSummary?: string;
  branchName?: string;
  commitMessage?: string;
  commitSha?: string;
}

export interface BusinessCommitGate {
  status: "pending" | "approved" | "rejected" | "committed";
  repositories: Array<{
    surfaceId: string;
    repoPath: string;
    branchName: string;
    commitMessage: string;
    diffFiles: string[];
    diffSummary: string;
    verificationResults: BusinessVerificationResult[];
    risks: string[];
    commitSha?: string;
  }>;
  contractConsistency: {
    status: "passed" | "failed" | "unknown";
    summary: string;
  };
  allowCommitWithFailures: boolean;
  approvedAt?: string;
}

export interface BusinessRequirementRun {
  id: string;
  workspaceId: string;
  workspaceSnapshot: BusinessWorkspace;
  teamId?: string;
  goal: string;
  status:
    | "draft"
    | "planning"
    | "awaiting_assignment_approval"
    | "running"
    | "verifying"
    | "awaiting_commit_approval"
    | "committing"
    | "done"
    | "failed"
    | "cancelled";
  assignmentPlan?: BusinessAssignmentPlan;
  contractDraft?: BusinessContractDraft;
  surfaceRuns: BusinessSurfaceRun[];
  commitGate?: BusinessCommitGate;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessValidationResult {
  ok: boolean;
  errors: string[];
}
```

- [ ] **Step 4: Create `electron/cli/businessWorkspaceValidate.ts`**

Implement validation with these exact exported functions:

```ts
import path from "node:path";
import type {
  BusinessAssignmentPlan,
  BusinessContractDraft,
  BusinessValidationResult,
  BusinessWorkspace
} from "./businessWorkspaceTypes.js";
import type { WorkflowAgentRef } from "./workflowTypes.js";

export function validateBusinessWorkspace(
  workspace: BusinessWorkspace,
  agents: WorkflowAgentRef[]
): BusinessValidationResult {
  const errors: string[] = [];
  if (!workspace.name.trim()) errors.push("workspace name is required");
  if (workspace.surfaces.length === 0) errors.push("at least one surface is required");

  const surfaceIds = new Set<string>();
  for (const surface of workspace.surfaces) {
    if (!surface.id.trim()) errors.push("surface id is required");
    if (surfaceIds.has(surface.id)) errors.push(`duplicate surface id: ${surface.id}`);
    surfaceIds.add(surface.id);
    if (!surface.name.trim()) errors.push(`surface ${surface.id} name is required`);
    if (!path.isAbsolute(surface.repoPath)) {
      errors.push(`surface ${surface.id} repoPath must be an absolute path`);
    }
    const agent = agents.find((a) => a.id === surface.defaultAgentId);
    if (!agent) errors.push(`surface ${surface.id} references unknown agent: ${surface.defaultAgentId}`);
    if (agent && !agent.enabled) errors.push(`surface ${surface.id} agent is disabled: ${surface.defaultAgentId}`);
    for (const allowedPath of surface.allowedPaths) {
      if (path.isAbsolute(allowedPath)) {
        errors.push(`surface ${surface.id} allowedPaths must be relative: ${allowedPath}`);
      }
    }
    for (const command of surface.verifyCommands) {
      if (!command.trim()) errors.push(`surface ${surface.id} has an empty verify command`);
    }
  }

  if (!workspace.policy.branchNameTemplate.includes("{{runSlug}}")) {
    errors.push("branchNameTemplate must include {{runSlug}}");
  }
  if (!workspace.policy.branchNameTemplate.includes("{{surfaceKey}}")) {
    errors.push("branchNameTemplate must include {{surfaceKey}}");
  }

  return { ok: errors.length === 0, errors };
}

export function validateBusinessAssignmentPlan(
  plan: BusinessAssignmentPlan,
  workspace: BusinessWorkspace
): BusinessValidationResult {
  const errors: string[] = [];
  const surfaceIds = new Set(workspace.surfaces.map((s) => s.id));
  for (const item of plan.surfaces) {
    if (!surfaceIds.has(item.surfaceId)) errors.push(`assignment references unknown surface: ${item.surfaceId}`);
    for (const dep of item.dependsOnSurfaceIds) {
      if (!surfaceIds.has(dep)) errors.push(`assignment ${item.surfaceId} depends on unknown surface: ${dep}`);
    }
  }
  for (const dep of plan.dependencies) {
    if (!surfaceIds.has(dep.fromSurfaceId)) errors.push(`dependency from unknown surface: ${dep.fromSurfaceId}`);
    if (!surfaceIds.has(dep.toSurfaceId)) errors.push(`dependency to unknown surface: ${dep.toSurfaceId}`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateBusinessContractDraft(
  draft: BusinessContractDraft,
  workspace: BusinessWorkspace
): BusinessValidationResult {
  const errors: string[] = [];
  const surfaceIds = new Set(workspace.surfaces.map((s) => s.id));
  for (const id of draft.providerSurfaceIds) {
    if (!surfaceIds.has(id)) errors.push(`contract provider references unknown surface: ${id}`);
  }
  for (const id of draft.consumerSurfaceIds) {
    if (!surfaceIds.has(id)) errors.push(`contract consumer references unknown surface: ${id}`);
  }
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 5: Add database tables to `electron/cli/db.ts`**

Inside `migrate(db)`, add these tables after `workflow_teams`:

```sql
    CREATE TABLE IF NOT EXISTS business_workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      surfaces_json TEXT NOT NULL,
      default_team_id TEXT,
      policy_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS business_requirement_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workspace_snapshot_json TEXT NOT NULL,
      team_id TEXT,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      assignment_plan_json TEXT,
      contract_draft_json TEXT,
      surface_runs_json TEXT NOT NULL,
      commit_gate_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_business_requirement_runs_workspace
      ON business_requirement_runs(workspace_id, created_at DESC);
```

- [ ] **Step 6: Create `electron/cli/businessWorkspaces.ts`**

Follow the `workflowTeams.ts` pattern. Export:

```ts
import { getDb } from "./db.js";
import type { BusinessWorkspace } from "./businessWorkspaceTypes.js";

function rowToWorkspace(row: any): BusinessWorkspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    surfaces: JSON.parse(row.surfaces_json),
    defaultTeamId: row.default_team_id ?? undefined,
    policy: JSON.parse(row.policy_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export type UpsertBusinessWorkspaceInput = Omit<BusinessWorkspace, "createdAt" | "updatedAt">;
export type UpdateBusinessWorkspacePatch = Partial<Omit<UpsertBusinessWorkspaceInput, "id">>;

export function listBusinessWorkspaces(): BusinessWorkspace[] {
  const rows = getDb()
    .prepare("SELECT * FROM business_workspaces ORDER BY updated_at DESC")
    .all() as any[];
  return rows.map(rowToWorkspace);
}

export function getBusinessWorkspace(id: string): BusinessWorkspace | undefined {
  const row = getDb().prepare("SELECT * FROM business_workspaces WHERE id = ?").get(id) as any;
  return row ? rowToWorkspace(row) : undefined;
}

export function insertBusinessWorkspace(input: UpsertBusinessWorkspaceInput): BusinessWorkspace {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO business_workspaces
         (id, name, description, surfaces_json, default_team_id, policy_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.name,
      input.description ?? null,
      JSON.stringify(input.surfaces),
      input.defaultTeamId ?? null,
      JSON.stringify(input.policy),
      now,
      now
    );
  return getBusinessWorkspace(input.id) as BusinessWorkspace;
}

export function updateBusinessWorkspace(
  id: string,
  patch: UpdateBusinessWorkspacePatch
): BusinessWorkspace | undefined {
  const existing = getBusinessWorkspace(id);
  if (!existing) return undefined;
  const next: UpsertBusinessWorkspaceInput = {
    id,
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    surfaces: patch.surfaces ?? existing.surfaces,
    defaultTeamId: patch.defaultTeamId ?? existing.defaultTeamId,
    policy: patch.policy ?? existing.policy
  };
  getDb()
    .prepare(
      `UPDATE business_workspaces
       SET name = ?, description = ?, surfaces_json = ?, default_team_id = ?, policy_json = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      next.name,
      next.description ?? null,
      JSON.stringify(next.surfaces),
      next.defaultTeamId ?? null,
      JSON.stringify(next.policy),
      new Date().toISOString(),
      id
    );
  return getBusinessWorkspace(id);
}

export function deleteBusinessWorkspace(id: string): boolean {
  const existing = getBusinessWorkspace(id);
  if (!existing) return false;
  getDb().prepare("DELETE FROM business_workspaces WHERE id = ?").run(id);
  return true;
}
```

- [ ] **Step 7: Run tests**

Run: `npm run build:electron && node --test tests/business-workspaces.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add electron/cli/db.ts electron/cli/businessWorkspaceTypes.ts electron/cli/businessWorkspaceValidate.ts electron/cli/businessWorkspaces.ts tests/business-workspaces.test.mjs
git commit -m "feat: add business workspace persistence"
```

---

### Task 2: IPC, Preload, Renderer Types, Client, and Store

**Files:**
- Create: `electron/cli/businessWorkspaceIpc.ts`
- Create: `src/services/businessWorkspaces/types.ts`
- Create: `src/services/businessWorkspaces/client.ts`
- Create: `src/store/businessWorkspaceStore.ts`
- Modify: `electron/cli/ipc.ts`
- Modify: `electron/preload.ts`
- Modify: `src/types/freebuddy.d.ts`
- Test: `tests/business-workspaces.test.mjs`

- [ ] **Step 1: Add IPC and bridge tests**

Append to `tests/business-workspaces.test.mjs`:

```js
test("business workspace IPC and preload bridge are wired", () => {
  const ipc = read("../electron/cli/businessWorkspaceIpc.ts");
  const cliIpc = read("../electron/cli/ipc.ts");
  const preload = read("../electron/preload.ts");
  const globals = read("../src/types/freebuddy.d.ts");
  for (const channel of [
    "businessWorkspaces:list",
    "businessWorkspaces:get",
    "businessWorkspaces:create",
    "businessWorkspaces:update",
    "businessWorkspaces:delete",
    "businessRequirements:previewAssignment"
  ]) {
    assert.match(ipc, new RegExp(channel));
  }
  assert.match(cliIpc, /registerBusinessWorkspaceIpc/);
  assert.match(preload, /const businessWorkspaces = \{/);
  assert.match(preload, /businessWorkspaces,/);
  assert.match(globals, /interface FreebuddyBusinessWorkspaces/);
  assert.match(globals, /businessWorkspaces: FreebuddyBusinessWorkspaces/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:electron && node --test tests/business-workspaces.test.mjs`

Expected: FAIL because the bridge is not wired.

- [ ] **Step 3: Create `electron/cli/businessWorkspaceIpc.ts`**

Register CRUD handlers and validation:

```ts
import { ipcMain } from "electron";
import { builtinCliMembers } from "./members.js";
import {
  deleteBusinessWorkspace,
  getBusinessWorkspace,
  insertBusinessWorkspace,
  listBusinessWorkspaces,
  updateBusinessWorkspace,
  type UpdateBusinessWorkspacePatch,
  type UpsertBusinessWorkspaceInput
} from "./businessWorkspaces.js";
import { validateBusinessWorkspace } from "./businessWorkspaceValidate.js";
import type { WorkflowAgentRef } from "./workflowTypes.js";

export function registerBusinessWorkspaceIpc() {
  ipcMain.handle("businessWorkspaces:list", () => listBusinessWorkspaces());
  ipcMain.handle("businessWorkspaces:get", (_e, id: string) => getBusinessWorkspace(id));
  ipcMain.handle("businessWorkspaces:create", (_e, input: UpsertBusinessWorkspaceInput) => {
    const validation = validateBusinessWorkspace(
      { ...input, createdAt: "", updatedAt: "" },
      businessAgents()
    );
    if (!validation.ok) return { ok: false as const, errors: validation.errors };
    return { ok: true as const, workspace: insertBusinessWorkspace(input) };
  });
  ipcMain.handle(
    "businessWorkspaces:update",
    (_e, args: { id: string; patch: UpdateBusinessWorkspacePatch }) => {
      const existing = getBusinessWorkspace(args.id);
      if (!existing) return { ok: false as const, errors: ["workspace not found"] };
      const merged = { ...existing, ...args.patch };
      const validation = validateBusinessWorkspace(merged, businessAgents());
      if (!validation.ok) return { ok: false as const, errors: validation.errors };
      const workspace = updateBusinessWorkspace(args.id, args.patch);
      return workspace
        ? { ok: true as const, workspace }
        : { ok: false as const, errors: ["workspace not found"] };
    }
  );
  ipcMain.handle("businessWorkspaces:delete", (_e, id: string) => deleteBusinessWorkspace(id));
  ipcMain.handle("businessRequirements:previewAssignment", () => ({
    ok: false as const,
    errors: ["assignment planner is not registered yet"]
  }));
}

function businessAgents(): WorkflowAgentRef[] {
  return builtinCliMembers.map((m) => ({
    id: m.id,
    name: m.name,
    adapter: m.cli.adapter,
    enabled: m.enabled !== false
  }));
}
```

- [ ] **Step 4: Register IPC in `electron/cli/ipc.ts`**

Add import:

```ts
import { registerBusinessWorkspaceIpc } from "./businessWorkspaceIpc.js";
```

At the end of `registerCliIpc()`, directly after `registerWorkflowIpc();`, call:

```ts
  registerBusinessWorkspaceIpc();
```

- [ ] **Step 5: Expose preload bridge in `electron/preload.ts`**

Add:

```ts
const businessWorkspaces = {
  list: () => ipcRenderer.invoke("businessWorkspaces:list"),
  get: (id: string) => ipcRenderer.invoke("businessWorkspaces:get", id),
  create: (input: unknown) => ipcRenderer.invoke("businessWorkspaces:create", input),
  update: (args: unknown) => ipcRenderer.invoke("businessWorkspaces:update", args),
  delete: (id: string) => ipcRenderer.invoke("businessWorkspaces:delete", id),
  previewAssignment: (input: unknown) =>
    ipcRenderer.invoke("businessRequirements:previewAssignment", input)
};
```

Expose it in `contextBridge.exposeInMainWorld("freebuddy", { ... })` next to `workflowTeams`.

- [ ] **Step 6: Add renderer types and client**

Mirror the main types in `src/services/businessWorkspaces/types.ts`.

Create `src/services/businessWorkspaces/client.ts`:

```ts
import type { BusinessWorkspace } from "./types";

function api() {
  const business = window.freebuddy?.businessWorkspaces;
  if (!business) throw new Error("businessWorkspaces bridge unavailable");
  return business;
}

export const businessWorkspacesClient = {
  isAvailable(): boolean {
    return Boolean(window.freebuddy?.businessWorkspaces);
  },
  list(): Promise<BusinessWorkspace[]> {
    return api().list();
  },
  get(id: string): Promise<BusinessWorkspace | undefined> {
    return api().get(id);
  },
  create(input: Omit<BusinessWorkspace, "createdAt" | "updatedAt">) {
    return api().create(input);
  },
  update(args: { id: string; patch: Partial<Omit<BusinessWorkspace, "id" | "createdAt" | "updatedAt">> }) {
    return api().update(args);
  },
  delete(id: string): Promise<boolean> {
    return api().delete(id);
  },
  previewAssignment(input: { workspaceId: string; goal: string }) {
    return api().previewAssignment(input);
  }
};
```

- [ ] **Step 7: Add global bridge types**

In `src/types/freebuddy.d.ts`, import `BusinessWorkspace`, `BusinessAssignmentPlan`, and `BusinessContractDraft`, then add:

```ts
  interface FreebuddyBusinessWorkspaces {
    list(): Promise<BusinessWorkspace[]>;
    get(id: string): Promise<BusinessWorkspace | undefined>;
    create(input: Omit<BusinessWorkspace, "createdAt" | "updatedAt">): Promise<
      | { ok: true; workspace: BusinessWorkspace }
      | { ok: false; errors: string[] }
    >;
    update(args: {
      id: string;
      patch: Partial<Omit<BusinessWorkspace, "id" | "createdAt" | "updatedAt">>;
    }): Promise<
      | { ok: true; workspace: BusinessWorkspace }
      | { ok: false; errors: string[] }
    >;
    delete(id: string): Promise<boolean>;
    previewAssignment(input: { workspaceId: string; goal: string }): Promise<
      | { ok: true; assignmentPlan: BusinessAssignmentPlan; contractDraft?: BusinessContractDraft }
      | { ok: false; errors: string[] }
    >;
  }
```

Add `businessWorkspaces: FreebuddyBusinessWorkspaces;` to `FreebuddyApi`.

- [ ] **Step 8: Add Zustand store**

Create `src/store/businessWorkspaceStore.ts`:

```ts
import { create } from "zustand";
import { businessWorkspacesClient } from "@/services/businessWorkspaces/client";
import type { BusinessWorkspace } from "@/services/businessWorkspaces/types";

interface State {
  loaded: boolean;
  workspaces: BusinessWorkspace[];
  errors: string[];
  load(): Promise<void>;
  refresh(): Promise<void>;
  create(input: Omit<BusinessWorkspace, "createdAt" | "updatedAt">): Promise<boolean>;
  update(id: string, patch: Partial<Omit<BusinessWorkspace, "id" | "createdAt" | "updatedAt">>): Promise<boolean>;
  remove(id: string): Promise<boolean>;
}

export const useBusinessWorkspaceStore = create<State>((set, get) => ({
  loaded: false,
  workspaces: [],
  errors: [],
  async load() {
    if (get().loaded) return;
    if (!businessWorkspacesClient.isAvailable()) {
      set({ loaded: true, workspaces: [] });
      return;
    }
    const workspaces = await businessWorkspacesClient.list();
    set({ loaded: true, workspaces, errors: [] });
  },
  async refresh() {
    if (!businessWorkspacesClient.isAvailable()) return;
    const workspaces = await businessWorkspacesClient.list();
    set({ workspaces, errors: [] });
  },
  async create(input) {
    const res = await businessWorkspacesClient.create(input);
    if (!res.ok) {
      set({ errors: res.errors });
      return false;
    }
    await get().refresh();
    return true;
  },
  async update(id, patch) {
    const res = await businessWorkspacesClient.update({ id, patch });
    if (!res.ok) {
      set({ errors: res.errors });
      return false;
    }
    await get().refresh();
    return true;
  },
  async remove(id) {
    const ok = await businessWorkspacesClient.delete(id);
    if (ok) await get().refresh();
    return ok;
  }
}));
```

- [ ] **Step 9: Run tests**

Run: `npm run typecheck && npm run build:electron && node --test tests/business-workspaces.test.mjs`

Expected: PASS.

- [ ] **Step 10: Commit**

Run:

```bash
git add electron/cli/ipc.ts electron/cli/businessWorkspaceIpc.ts electron/preload.ts src/types/freebuddy.d.ts src/services/businessWorkspaces src/store/businessWorkspaceStore.ts tests/business-workspaces.test.mjs
git commit -m "feat: wire business workspace bridge"
```

---

### Task 3: Assignment Planner and Contract Draft Preview

**Files:**
- Create: `electron/cli/businessAssignmentPlanner.ts`
- Create: `electron/cli/businessRequirementRuns.ts`
- Modify: `electron/cli/businessWorkspaceIpc.ts`
- Test: `tests/business-assignment-planner.test.mjs`

- [ ] **Step 1: Write planner tests**

Create `tests/business-assignment-planner.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

test("business assignment planner groups enabled surfaces and creates dependencies", async () => {
  const { previewBusinessAssignment } = await import("../dist-electron/cli/businessAssignmentPlanner.js");
  const workspace = {
    id: "biz-membership",
    name: "Membership",
    surfaces: [
      {
        id: "server",
        name: "Server",
        kind: "server",
        repoPath: "/repo/server",
        defaultAgentId: "cli-codex-acp",
        allowedPaths: [],
        verifyCommands: ["npm test"],
        responsibilities: ["API", "database"],
        contractRole: "provider",
        enabled: true
      },
      {
        id: "client",
        name: "Client",
        kind: "client",
        repoPath: "/repo/client",
        defaultAgentId: "cli-claude-agent-acp",
        allowedPaths: ["src"],
        verifyCommands: ["npm run build"],
        responsibilities: ["UI", "API consumption"],
        contractRole: "consumer",
        enabled: true
      }
    ],
    policy: {
      requireAssignmentApproval: true,
      requireCommitApproval: true,
      blockCommitOnVerificationFailure: true,
      requireCleanRepoBeforeRun: true,
      branchNameTemplate: "fb/{{runSlug}}/{{surfaceKey}}"
    },
    createdAt: "",
    updatedAt: ""
  };
  const result = previewBusinessAssignment(workspace, "add member discount");
  assert.equal(result.ok, true);
  assert.equal(result.assignmentPlan.surfaces.length, 2);
  assert.equal(result.assignmentPlan.needsContractDraft, true);
  assert.deepEqual(result.contractDraft.providerSurfaceIds, ["server"]);
  assert.deepEqual(result.contractDraft.consumerSurfaceIds, ["client"]);
  assert.deepEqual(result.assignmentPlan.surfaces.find((s) => s.surfaceId === "client").dependsOnSurfaceIds, ["server"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:electron && node --test tests/business-assignment-planner.test.mjs`

Expected: FAIL because the planner module is missing.

- [ ] **Step 3: Implement `businessAssignmentPlanner.ts`**

```ts
import { nanoid } from "nanoid";
import type {
  BusinessAssignmentPlan,
  BusinessContractDraft,
  BusinessWorkspace
} from "./businessWorkspaceTypes.js";

export function previewBusinessAssignment(
  workspace: BusinessWorkspace,
  goal: string
):
  | { ok: true; assignmentPlan: BusinessAssignmentPlan; contractDraft?: BusinessContractDraft }
  | { ok: false; errors: string[] } {
  const enabled = workspace.surfaces.filter((surface) => surface.enabled);
  if (enabled.length === 0) {
    return { ok: false, errors: ["workspace has no enabled surfaces"] };
  }

  const providers = enabled.filter((surface) =>
    surface.contractRole === "provider" || surface.contractRole === "both"
  );
  const consumers = enabled.filter((surface) =>
    surface.contractRole === "consumer" || surface.contractRole === "both"
  );
  const needsContractDraft = providers.length > 0 && consumers.length > 0;
  const providerIds = new Set(providers.map((surface) => surface.id));

  const assignmentPlan: BusinessAssignmentPlan = {
    surfaces: enabled.map((surface) => ({
      surfaceId: surface.id,
      agentId: surface.defaultAgentId,
      repoPath: surface.repoPath,
      tasks: [
        `Handle ${surface.name} changes for: ${goal}`,
        ...surface.responsibilities.map((item) => `Respect responsibility: ${item}`)
      ],
      dependsOnSurfaceIds:
        needsContractDraft && !providerIds.has(surface.id)
          ? providers.map((provider) => provider.id)
          : [],
      writes: surface.allowedPaths.length >= 0,
      verifyCommands: surface.verifyCommands
    })),
    dependencies: needsContractDraft
      ? consumers.flatMap((consumer) =>
          providers
            .filter((provider) => provider.id !== consumer.id)
            .map((provider) => ({
              fromSurfaceId: consumer.id,
              toSurfaceId: provider.id,
              reason: `${consumer.name} consumes contract from ${provider.name}`
            }))
        )
      : [],
    needsContractDraft,
    summary: `Plan ${enabled.length} surfaces for: ${goal}`
  };

  const contractDraft = needsContractDraft
    ? buildContractDraft(goal, providers.map((s) => s.id), consumers.map((s) => s.id))
    : undefined;

  return { ok: true, assignmentPlan, contractDraft };
}

function buildContractDraft(
  goal: string,
  providerSurfaceIds: string[],
  consumerSurfaceIds: string[]
): BusinessContractDraft {
  return {
    id: nanoid(),
    title: `Contract draft for ${goal}`,
    providerSurfaceIds,
    consumerSurfaceIds,
    endpoints: [
      {
        method: "POST",
        path: "/api/business-change",
        request: "Request fields should be finalized by provider surface before implementation is considered complete.",
        response: "Response fields should cover the UI states needed by consumer surfaces.",
        errors: ["VALIDATION_FAILED", "UNAUTHORIZED", "NOT_FOUND"]
      }
    ],
    dataRules: ["Provider surfaces own persistence and canonical business rules."],
    permissionRules: ["Provider surfaces define permission checks; consumer surfaces display permission failures."],
    notes: ["This MVP contract is a structured draft and can be edited before execution."]
  };
}
```

- [ ] **Step 4: Create `businessRequirementRuns.ts` persistence**

Export `insertBusinessRequirementRun()`, `getBusinessRequirementRun()`, and `updateBusinessRequirementRun()` using the `business_requirement_runs` table. Store `assignmentPlan`, `contractDraft`, `surfaceRuns`, and `commitGate` as JSON strings matching the spec.

- [ ] **Step 5: Wire `businessRequirements:previewAssignment`**

In `businessWorkspaceIpc.ts`, replace the stub handler:

```ts
ipcMain.handle(
  "businessRequirements:previewAssignment",
  (_e, input: { workspaceId: string; goal: string }) => {
    const workspace = getBusinessWorkspace(input.workspaceId);
    if (!workspace) return { ok: false as const, errors: ["workspace not found"] };
    const validation = validateBusinessWorkspace(workspace, businessAgents());
    if (!validation.ok) return { ok: false as const, errors: validation.errors };
    return previewBusinessAssignment(workspace, input.goal);
  }
);
```

- [ ] **Step 6: Run tests**

Run: `npm run build:electron && node --test tests/business-assignment-planner.test.mjs tests/business-workspaces.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add electron/cli/businessAssignmentPlanner.ts electron/cli/businessRequirementRuns.ts electron/cli/businessWorkspaceIpc.ts tests/business-assignment-planner.test.mjs
git commit -m "feat: preview business surface assignments"
```

---

### Task 4: Settings UI for Business Workspaces

**Files:**
- Create: `src/components/Settings/BusinessWorkspacesTab.tsx`
- Create: `src/components/Settings/BusinessWorkspaceList.tsx`
- Create: `src/components/Settings/BusinessWorkspaceEditor.tsx`
- Modify: `src/components/Settings/SettingsModal.tsx`
- Modify: `src/locales/en.json`
- Modify: `src/locales/zh-CN.json`
- Modify: `styles.css`
- Test: `tests/business-ui.test.mjs`

- [ ] **Step 1: Write UI wiring tests**

Create `tests/business-ui.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("Settings modal exposes Business Workspaces tab", () => {
  const settings = read("../src/components/Settings/SettingsModal.tsx");
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  assert.match(settings, /BusinessWorkspacesTab/);
  assert.match(settings, /workflowTeams[\s\S]*businessWorkspaces[\s\S]*general/);
  assert.ok(en.settings.tabs.businessWorkspaces);
  assert.ok(zh.settings.tabs.businessWorkspaces);
});

test("Business workspace editor captures surfaces, repo paths, agents, and verify commands", () => {
  const editor = read("../src/components/Settings/BusinessWorkspaceEditor.tsx");
  assert.match(editor, /repoPath/);
  assert.match(editor, /defaultAgentId/);
  assert.match(editor, /verifyCommands/);
  assert.match(editor, /allowedPaths/);
  assert.match(editor, /contractRole/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/business-ui.test.mjs`

Expected: FAIL because UI files and i18n keys are missing.

- [ ] **Step 3: Add Settings tab**

Modify `SettingsModal.tsx`:

```ts
import { BusinessWorkspacesTab } from "./BusinessWorkspacesTab";

type SettingsTab = "cli" | "workflowTeams" | "businessWorkspaces" | "general" | "about";

const TABS: { key: SettingsTab; labelKey: string }[] = [
  { key: "cli", labelKey: "settings.tabs.cli" },
  { key: "workflowTeams", labelKey: "settings.tabs.workflowTeams" },
  { key: "businessWorkspaces", labelKey: "settings.tabs.businessWorkspaces" },
  { key: "general", labelKey: "settings.tabs.general" },
  { key: "about", labelKey: "settings.tabs.about" }
];
```

Render:

```tsx
{activeTab === "businessWorkspaces" && <BusinessWorkspacesTab />}
```

- [ ] **Step 4: Create Business Workspaces tab components**

Build `BusinessWorkspacesTab` following `WorkflowTeamsTab`: load `useBusinessWorkspaceStore`, show list, edit selected workspace.

Build `BusinessWorkspaceList` with workspace cards showing name, surface count, default team, and edit/delete buttons.

Build `BusinessWorkspaceEditor` with:
- Workspace name.
- Description.
- Surface rows.
- Surface name.
- Kind select.
- Repo path input and directory picker using `cliClient.selectDirectory()`.
- Default agent select from `useConversationStore((s) => s.members)`.
- Allowed paths comma/newline textarea.
- Verify commands newline textarea.
- Responsibilities newline textarea.
- Contract role select.
- Save/cancel buttons.

- [ ] **Step 5: Add i18n keys**

Add these keys in both locale files under `settings.tabs` and `business`:

```json
"businessWorkspaces": "Business Workspaces"
```

For `src/locales/en.json`:

```json
"business": {
  "workspaceList": "Business workspaces",
  "workspaceHint": "Group related repositories and assign agents per surface.",
  "newWorkspace": "New workspace",
  "workspaceName": "Workspace name",
  "surface": "Surface",
  "surfaces": "Surfaces",
  "repoPath": "Repository path",
  "defaultAgent": "Default agent",
  "allowedPaths": "Allowed paths",
  "verifyCommands": "Verification commands",
  "responsibilities": "Responsibilities",
  "contractRole": "Contract role",
  "noWorkspaces": "No business workspaces yet",
  "confirmDeleteWorkspace": "Delete this business workspace?"
}
```

For `src/locales/zh-CN.json`, use clear Chinese labels:

```json
"business": {
  "workspaceList": "业务空间",
  "workspaceHint": "把相关仓库按端分组，并为每个端分配默认 Agent。",
  "newWorkspace": "新建业务空间",
  "workspaceName": "业务空间名称",
  "surface": "端",
  "surfaces": "端列表",
  "repoPath": "仓库路径",
  "defaultAgent": "默认 Agent",
  "allowedPaths": "允许路径",
  "verifyCommands": "验证命令",
  "responsibilities": "职责",
  "contractRole": "契约角色",
  "noWorkspaces": "尚未配置业务空间",
  "confirmDeleteWorkspace": "删除该业务空间？"
}
```

- [ ] **Step 6: Add styles**

Add compact settings styles in `styles.css`:

```css
.business-workspace-list,
.business-workspace-editor {
  display: grid;
  gap: 12px;
}

.business-workspace-card,
.business-surface-row {
  border: 1px solid var(--fb-border);
  border-radius: 8px;
  padding: 12px;
  background: var(--fb-surface);
}

.business-surface-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
```

- [ ] **Step 7: Run tests**

Run: `npm run typecheck && node --test tests/business-ui.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/components/Settings/BusinessWorkspacesTab.tsx src/components/Settings/BusinessWorkspaceList.tsx src/components/Settings/BusinessWorkspaceEditor.tsx src/components/Settings/SettingsModal.tsx src/locales/en.json src/locales/zh-CN.json styles.css tests/business-ui.test.mjs
git commit -m "feat: add business workspace settings"
```

---

### Task 5: Business Requirement Mode and Assignment Preview UI

**Files:**
- Create: `src/store/businessRequirementRunStore.ts`
- Create: `src/components/Business/BusinessAssignmentPreviewCard.tsx`
- Modify: `src/components/CLI/ChatView.tsx`
- Modify: `src/locales/en.json`
- Modify: `src/locales/zh-CN.json`
- Modify: `styles.css`
- Test: `tests/business-ui.test.mjs`

- [ ] **Step 1: Add UI tests for new task mode**

Append to `tests/business-ui.test.mjs`:

```js
test("ChatView exposes business requirement mode and assignment preview", () => {
  const chat = read("../src/components/CLI/ChatView.tsx");
  const preview = read("../src/components/Business/BusinessAssignmentPreviewCard.tsx");
  assert.match(chat, /taskMode.*business/s);
  assert.match(chat, /businessRequirement/);
  assert.match(chat, /BusinessAssignmentPreviewCard/);
  assert.match(preview, /assignmentPlan\.surfaces/);
  assert.match(preview, /contractDraft/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/business-ui.test.mjs`

Expected: FAIL because ChatView has no business mode yet.

- [ ] **Step 3: Create business requirement store**

Create `src/store/businessRequirementRunStore.ts`:

```ts
import { create } from "zustand";
import { businessWorkspacesClient } from "@/services/businessWorkspaces/client";
import type {
  BusinessAssignmentPlan,
  BusinessContractDraft
} from "@/services/businessWorkspaces/types";

interface State {
  pendingAssignmentPlan: BusinessAssignmentPlan | null;
  pendingContractDraft: BusinessContractDraft | null;
  pendingErrors: string[];
  previewAssignment(input: { workspaceId: string; goal: string }): Promise<void>;
  clearPreview(): void;
}

export const useBusinessRequirementRunStore = create<State>((set) => ({
  pendingAssignmentPlan: null,
  pendingContractDraft: null,
  pendingErrors: [],
  async previewAssignment(input) {
    const res = await businessWorkspacesClient.previewAssignment(input);
    if (res.ok) {
      set({
        pendingAssignmentPlan: res.assignmentPlan,
        pendingContractDraft: res.contractDraft ?? null,
        pendingErrors: []
      });
    } else {
      set({
        pendingAssignmentPlan: null,
        pendingContractDraft: null,
        pendingErrors: res.errors
      });
    }
  },
  clearPreview() {
    set({ pendingAssignmentPlan: null, pendingContractDraft: null, pendingErrors: [] });
  }
}));
```

- [ ] **Step 4: Create assignment preview card**

Create `BusinessAssignmentPreviewCard.tsx` that renders:
- Summary.
- One card per assigned surface.
- Surface repo path.
- Agent id.
- Task bullets.
- Dependencies.
- Contract draft title and endpoint count when present.
- Run/cancel actions.

- [ ] **Step 5: Extend ChatView task mode**

Change task mode union from `"normal" | "team"` to `"normal" | "team" | "business"`.

Load business workspaces with `useBusinessWorkspaceStore`.

In `NewTaskHome`, add a third mode tab labeled `business.requirementMode`, a workspace selector when `taskMode === "business"`, and make Enter/send call `previewAssignment` instead of starting work directly.

Render `BusinessAssignmentPreviewCard` below the composer when a pending plan exists.

- [ ] **Step 6: Add i18n and styles**

Add labels:

```json
"requirementMode": "Business requirement",
"selectWorkspace": "Select workspace",
"assignmentPreview": "Assignment plan",
"contractDraft": "Contract draft",
"approveAndRun": "Approve and run"
```

Add corresponding Chinese labels:

```json
"requirementMode": "业务需求",
"selectWorkspace": "选择业务空间",
"assignmentPreview": "认领计划",
"contractDraft": "契约草案",
"approveAndRun": "确认并执行"
```

- [ ] **Step 7: Run tests**

Run: `npm run typecheck && node --test tests/business-ui.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/store/businessRequirementRunStore.ts src/components/Business/BusinessAssignmentPreviewCard.tsx src/components/CLI/ChatView.tsx src/locales/en.json src/locales/zh-CN.json styles.css tests/business-ui.test.mjs
git commit -m "feat: preview business requirement assignments"
```

---

### Task 6: Surface Execution Runtime and Verification

**Files:**
- Create: `electron/cli/businessRequirementRuntime.ts`
- Modify: `electron/cli/businessWorkspaceIpc.ts`
- Modify: `src/services/businessWorkspaces/client.ts`
- Modify: `src/types/freebuddy.d.ts`
- Modify: `src/store/businessRequirementRunStore.ts`
- Test: `tests/business-runtime.test.mjs`

- [ ] **Step 1: Write runtime wiring tests**

Create `tests/business-runtime.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("business runtime uses surface repoPath as cwd and validates clean repos", () => {
  const runtime = read("../electron/cli/businessRequirementRuntime.ts");
  assert.match(runtime, /cwd: surfaceRun\.repoPath/);
  assert.match(runtime, /requireCleanRepoBeforeRun/);
  assert.match(runtime, /git status --porcelain/);
  assert.match(runtime, /verifyCommands/);
});

test("business requirement IPC exposes approve and start lifecycle", () => {
  const ipc = read("../electron/cli/businessWorkspaceIpc.ts");
  const preload = read("../electron/preload.ts");
  assert.match(ipc, /businessRequirements:createRun/);
  assert.match(ipc, /businessRequirements:startRun/);
  assert.match(ipc, /businessRequirements:getRun/);
  assert.match(preload, /createRun: \(input: unknown\) =>/);
  assert.match(preload, /startRun: \(runId: string\) =>/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:electron && node --test tests/business-runtime.test.mjs`

Expected: FAIL because runtime and lifecycle IPC are missing.

- [ ] **Step 3: Implement runtime skeleton**

Create `businessRequirementRuntime.ts` with:
- `createRunFromAssignment()`: creates `BusinessRequirementRun` with `surfaceRuns`.
- `startBusinessRun()`: checks each repo, runs `cliRun()` per surface, then verification commands.
- `runVerifyCommand()`: uses `child_process.spawn` with `shell: true`, `cwd = surface.repoPath`, captures exit code and summary.
- `ensureCleanRepo()`: runs `git status --porcelain` in each repo when policy requires it.

For every `cliRun()` call, build `CliRunArgs` with:

```ts
{
  sessionId: `${run.id}:${surfaceRun.surfaceId}`,
  agentId: surfaceRun.agentId,
  agentName: agent.name,
  adapter: agent.adapter,
  cwd: surfaceRun.repoPath,
  prompt,
  approvalMode: "ask"
}
```

Use the existing member lookup pattern from `workflowIpc.ts` for adapter and agent name.

- [ ] **Step 4: Wire lifecycle IPC**

Add handlers:

```ts
ipcMain.handle("businessRequirements:createRun", (_e, input) => createRunFromAssignment(input));
ipcMain.handle("businessRequirements:startRun", (event, runId: string) => startBusinessRun(event.sender, runId));
ipcMain.handle("businessRequirements:getRun", (_e, runId: string) => getBusinessRequirementRun(runId));
```

- [ ] **Step 5: Extend bridge/client/store**

Expose `createRun`, `startRun`, and `getRun` in preload, globals, client, and `businessRequirementRunStore`.

- [ ] **Step 6: Connect assignment approval in ChatView**

When the user clicks approve/run in `BusinessAssignmentPreviewCard`:
1. Create a normal conversation with coordinator agent.
2. Create business requirement run from workspace, goal, assignment, and contract.
3. Start the run.
4. Clear pending assignment preview.

- [ ] **Step 7: Run tests**

Run: `npm run typecheck && npm run build:electron && node --test tests/business-runtime.test.mjs tests/business-ui.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add electron/cli/businessRequirementRuntime.ts electron/cli/businessWorkspaceIpc.ts electron/cli/businessRequirementRuns.ts electron/preload.ts src/types/freebuddy.d.ts src/services/businessWorkspaces/client.ts src/store/businessRequirementRunStore.ts src/components/CLI/ChatView.tsx tests/business-runtime.test.mjs
git commit -m "feat: run business surface agents"
```

---

### Task 7: Commit Gate and Multi-Repo Local Commits

**Files:**
- Create: `electron/cli/businessCommitGate.ts`
- Modify: `electron/cli/businessRequirementRuntime.ts`
- Modify: `electron/cli/businessWorkspaceIpc.ts`
- Create: `src/components/Business/BusinessCommitGateCard.tsx`
- Modify: `src/store/businessRequirementRunStore.ts`
- Test: `tests/business-runtime.test.mjs`

- [ ] **Step 1: Add commit gate tests**

Append to `tests/business-runtime.test.mjs`:

```js
test("business commit gate creates branches and commits only after approval", () => {
  const gate = read("../electron/cli/businessCommitGate.ts");
  const ipc = read("../electron/cli/businessWorkspaceIpc.ts");
  assert.match(gate, /export async function previewBusinessCommitGate/);
  assert.match(gate, /git diff --name-only/);
  assert.match(gate, /git checkout -b/);
  assert.match(gate, /git add/);
  assert.match(gate, /git commit -m/);
  assert.match(ipc, /businessRequirements:previewCommitGate/);
  assert.match(ipc, /businessRequirements:approveCommitGate/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:electron && node --test tests/business-runtime.test.mjs`

Expected: FAIL because commit gate is missing.

- [ ] **Step 3: Implement `businessCommitGate.ts`**

Use `node:child_process` `execFile` with `git -C <repoPath> ...`.

Export:
- `previewBusinessCommitGate(run)`
- `approveBusinessCommitGate(run, patch)`
- `renderBranchName(template, runSlug, surfaceKey)`

Commands:
- `git -C repoPath status --porcelain`
- `git -C repoPath diff --name-only`
- `git -C repoPath diff --stat`
- `git -C repoPath checkout -b branchName`
- `git -C repoPath add -- <changedFiles>`
- `git -C repoPath commit -m commitMessage`

Parse commit sha with:

```ts
git -C repoPath rev-parse HEAD
```

- [ ] **Step 4: Wire commit gate IPC**

Add handlers:

```ts
ipcMain.handle("businessRequirements:previewCommitGate", (_e, runId: string) =>
  previewBusinessCommitGateForRun(runId)
);
ipcMain.handle("businessRequirements:approveCommitGate", (_e, args) =>
  approveBusinessCommitGateForRun(args.runId, args.patch)
);
```

- [ ] **Step 5: Add renderer commit gate card**

`BusinessCommitGateCard` renders:
- One repository section per surface.
- Branch name.
- Commit message textarea.
- Diff files.
- Verification statuses.
- Risk bullets.
- Approve button.
- Cancel button.

- [ ] **Step 6: Block commit on verification failure**

In approval logic, if any `verificationResults.status === "failed"` and `allowCommitWithFailures === false`, return:

```ts
{ ok: false as const, errors: ["verification failed; enable allowCommitWithFailures to commit anyway"] }
```

- [ ] **Step 7: Run tests**

Run: `npm run typecheck && npm run build:electron && node --test tests/business-runtime.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add electron/cli/businessCommitGate.ts electron/cli/businessRequirementRuntime.ts electron/cli/businessWorkspaceIpc.ts src/components/Business/BusinessCommitGateCard.tsx src/store/businessRequirementRunStore.ts tests/business-runtime.test.mjs
git commit -m "feat: add business commit gate"
```

---

### Task 8: Side Panel, Polish, Full Verification

**Files:**
- Create: `src/components/Business/BusinessSurfaceRunPanel.tsx`
- Modify: `src/components/CLI/WorkspacePanel.tsx`
- Modify: `src/components/CLI/ConversationList.tsx`
- Modify: `src/locales/en.json`
- Modify: `src/locales/zh-CN.json`
- Modify: `styles.css`
- Test: `tests/business-ui.test.mjs`

- [ ] **Step 1: Add panel tests**

Append to `tests/business-ui.test.mjs`:

```js
test("WorkspacePanel mounts business surface run panel", () => {
  const workspacePanel = read("../src/components/CLI/WorkspacePanel.tsx");
  const panel = read("../src/components/Business/BusinessSurfaceRunPanel.tsx");
  assert.match(workspacePanel, /BusinessSurfaceRunPanel/);
  assert.match(panel, /surfaceRuns/);
  assert.match(panel, /verificationResults/);
  assert.match(panel, /commitGate/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/business-ui.test.mjs`

Expected: FAIL because the panel is missing.

- [ ] **Step 3: Create `BusinessSurfaceRunPanel.tsx`**

Render active business run:
- Overall status.
- Surface status rows.
- Agent id.
- Repo short path.
- Verification results.
- Diff summary.
- Commit sha after commit.

- [ ] **Step 4: Mount in `WorkspacePanel.tsx`**

Load active business run from `useBusinessRequirementRunStore`. If active, render `BusinessSurfaceRunPanel` above the normal run state cards.

- [ ] **Step 5: Add running indicator**

In `ConversationList.tsx`, include business runs with status `running`, `verifying`, `awaiting_commit_approval`, and `committing` in the running indicator set.

- [ ] **Step 6: Final verification**

Run:

```bash
npm run typecheck
npm test
npm run build:renderer
```

Expected:
- `npm run typecheck` exits 0.
- `npm test` exits 0.
- `npm run build:renderer` exits 0.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/components/Business/BusinessSurfaceRunPanel.tsx src/components/CLI/WorkspacePanel.tsx src/components/CLI/ConversationList.tsx src/locales/en.json src/locales/zh-CN.json styles.css tests/business-ui.test.mjs
git commit -m "feat: show business run progress"
```

---

## Self-Review Checklist

- Spec coverage:
  - Business Workspace configuration: Tasks 1, 2, 4.
  - Surface repo/agent/verify/allowed path model: Tasks 1, 4.
  - Semi-automatic assignment preview: Tasks 3, 5.
  - Contract draft: Tasks 3, 5.
  - Per-surface execution in each repo: Task 6.
  - Verification commands: Task 6.
  - Unified commit gate: Task 7.
  - Surface status panel: Task 8.
- First implementation intentionally excludes automatic push, automatic PR creation, remote CI orchestration, and full environment bootstrapping, matching the spec non-goals.
- The plan uses exact file paths, test commands, and commit boundaries.
