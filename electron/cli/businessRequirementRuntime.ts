import path from "node:path";
import type { WebContents } from "electron";
import { nanoid } from "nanoid";

import { cliRun } from "./runtime.js";
import type { CliRunArgs } from "./runtimeShared.js";
import { builtinCliMembers } from "./members.js";
import {
  getBusinessRequirementRun,
  insertBusinessRequirementRun,
  updateBusinessRequirementRun
} from "./businessRequirementRuns.js";
import {
  ensureCleanRepo,
  runVerifyCommand,
  surfaceDependencyOrder
} from "./businessGit.js";
import type {
  BusinessAssignmentPlan,
  BusinessContractDraft,
  BusinessRequirementRun,
  BusinessSurfaceRun,
  BusinessVerificationResult,
  BusinessWorkspace
} from "./businessWorkspaceTypes.js";

export interface CreateRunFromAssignmentInput {
  workspace: BusinessWorkspace;
  goal: string;
  teamId?: string;
  assignmentPlan: BusinessAssignmentPlan;
  contractDraft?: BusinessContractDraft;
}

function buildSurfaceRuns(
  plan: BusinessAssignmentPlan,
  workspace: BusinessWorkspace
): BusinessSurfaceRun[] {
  return plan.surfaces.map((item) => {
    const surface = workspace.surfaces.find((s) => s.id === item.surfaceId);
    return {
      id: nanoid(),
      surfaceId: item.surfaceId,
      agentId: item.agentId,
      repoPath: item.repoPath,
      status: "pending",
      taskSummary: item.tasks.join("; "),
      verificationResults: [],
      branchName: undefined,
      commitMessage: undefined,
      commitSha: undefined,
      riskSummary: surface && surface.allowedPaths.length === 0
        ? "no allowedPaths; nothing will be committed for this surface"
        : undefined
    };
  });
}

export function createRunFromAssignment(
  input: CreateRunFromAssignmentInput
):
  | { ok: true; run: BusinessRequirementRun }
  | { ok: false; errors: string[] } {
  if (input.assignmentPlan.surfaces.length === 0) {
    return { ok: false, errors: ["assignment plan has no surfaces"] };
  }
  const surfaceRuns = buildSurfaceRuns(input.assignmentPlan, input.workspace);
  const now = new Date().toISOString();
  const run: BusinessRequirementRun = {
    id: nanoid(),
    workspaceId: input.workspace.id,
    workspaceSnapshot: input.workspace,
    teamId: input.teamId,
    goal: input.goal,
    status: "running",
    assignmentPlan: input.assignmentPlan,
    contractDraft: input.contractDraft,
    surfaceRuns,
    commitGate: undefined,
    createdAt: now,
    updatedAt: now
  };
  const inserted = insertBusinessRequirementRun({
    id: run.id,
    workspaceId: run.workspaceId,
    workspaceSnapshot: run.workspaceSnapshot,
    teamId: run.teamId,
    goal: run.goal,
    status: run.status,
    assignmentPlan: run.assignmentPlan,
    contractDraft: run.contractDraft,
    surfaceRuns: run.surfaceRuns,
    commitGate: run.commitGate
  });
  return { ok: true, run: inserted };
}

function resolveAgent(agentId: string) {
  const member = builtinCliMembers.find((m) => m.id === agentId);
  if (!member) return undefined;
  return {
    adapter: member.cli.adapter,
    agentName: member.name,
    binary: member.cli.binary,
    extraArgs: member.cli.extraArgs
  };
}

function renderContract(contract: BusinessContractDraft): string {
  const endpoints = contract.endpoints
    .map(
      (e) =>
        `  ${e.method} ${e.path}\n    request: ${e.request}\n    response: ${e.response}\n    errors: ${e.errors.join(", ")}`
    )
    .join("\n");
  return [
    `Contract: ${contract.title}`,
    `Providers: ${contract.providerSurfaceIds.join(", ") || "(none)"}`,
    `Consumers: ${contract.consumerSurfaceIds.join(", ") || "(none)"}`,
    endpoints ? `Endpoints:\n${endpoints}` : "",
    contract.dataRules.length
      ? `Data rules:\n${contract.dataRules.map((r) => `  - ${r}`).join("\n")}`
      : "",
    contract.permissionRules.length
      ? `Permission rules:\n${contract.permissionRules.map((r) => `  - ${r}`).join("\n")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPrompt(
  run: BusinessRequirementRun,
  surfaceRun: BusinessSurfaceRun
): string {
  const planItem = run.assignmentPlan?.surfaces.find(
    (s) => s.surfaceId === surfaceRun.surfaceId
  );
  const tasks = planItem?.tasks ?? [];
  const surface = run.workspaceSnapshot.surfaces.find(
    (s) => s.id === surfaceRun.surfaceId
  );
  const allowed = surface?.allowedPaths ?? [];
  const scope = allowed.length
    ? `STRICT SCOPE: only modify files under these relative paths: ${allowed.join(", ")}. Do not touch anything outside this list.`
    : "STRICT SCOPE: this surface has no allowedPaths declared; do not modify any files unless explicitly approved.";
  const contractNote = run.contractDraft
    ? `\n${renderContract(run.contractDraft)}\n`
    : "";
  return [
    `Business goal: ${run.goal}`,
    `Surface: ${surfaceRun.surfaceId}`,
    scope,
    ...tasks.map((task) => `- ${task}`),
    contractNote
  ].join("\n");
}

function updateSurfaceRun(
  runId: string,
  surfaceRunId: string,
  patch: Partial<BusinessSurfaceRun>,
  fallbackRuns: BusinessSurfaceRun[]
) {
  const current = getBusinessRequirementRun(runId);
  const runs = (current?.surfaceRuns ?? fallbackRuns).map((sr) =>
    sr.id === surfaceRunId ? { ...sr, ...patch } : sr
  );
  updateBusinessRequirementRun(runId, { surfaceRuns: runs });
}

export async function startBusinessRun(
  webContents: WebContents,
  runId: string
): Promise<
  | { ok: true; run: BusinessRequirementRun }
  | { ok: false; errors: string[] }
> {
  const run = getBusinessRequirementRun(runId);
  if (!run) return { ok: false, errors: ["run not found"] };

  const policy = run.workspaceSnapshot.policy;
  if (policy.requireCleanRepoBeforeRun) {
    for (const surfaceRun of run.surfaceRuns) {
      if (!path.isAbsolute(surfaceRun.repoPath)) continue;
      const status = await ensureCleanRepo(surfaceRun.repoPath);
      if (!status.ok) {
        updateBusinessRequirementRun(runId, {
          status: "failed",
          surfaceRuns: run.surfaceRuns.map((sr) =>
            sr.id === surfaceRun.id
              ? { ...sr, status: "blocked", riskSummary: status.summary }
              : sr
          )
        });
        return {
          ok: false,
          errors: [
            `surface ${surfaceRun.surfaceId} repo is not clean: ${status.summary}`
          ]
        };
      }
    }
  }

  const order = run.assignmentPlan
    ? surfaceDependencyOrder(run.assignmentPlan)
    : run.surfaceRuns.map((s) => s.surfaceId);

  for (const surfaceId of order) {
    const surfaceRun = run.surfaceRuns.find((s) => s.surfaceId === surfaceId);
    if (!surfaceRun) continue;

    const agent = resolveAgent(surfaceRun.agentId);
    if (!agent) {
      updateSurfaceRun(
        runId,
        surfaceRun.id,
        {
          status: "failed",
          riskSummary: `unknown agent ${surfaceRun.agentId}`
        },
        run.surfaceRuns
      );
      updateBusinessRequirementRun(runId, { status: "failed" });
      return { ok: false, errors: [`unknown agent: ${surfaceRun.agentId}`] };
    }

    updateSurfaceRun(runId, surfaceRun.id, { status: "running" }, run.surfaceRuns);

    const args: CliRunArgs = {
      sessionId: `${runId}:${surfaceRun.surfaceId}`,
      agentId: surfaceRun.agentId,
      agentName: agent.agentName,
      adapter: agent.adapter,
      binary: agent.binary,
      extraArgs: agent.extraArgs,
      cwd: surfaceRun.repoPath,
      prompt: buildPrompt(run, surfaceRun),
      approvalMode: "ask"
    };

    try {
      await cliRun(webContents, args);
    } catch (e) {
      updateSurfaceRun(
        runId,
        surfaceRun.id,
        {
          status: "failed",
          riskSummary: e instanceof Error ? e.message : String(e)
        },
        run.surfaceRuns
      );
      updateBusinessRequirementRun(runId, { status: "failed" });
      return {
        ok: false,
        errors: [
          `surface ${surfaceRun.surfaceId} failed: ${e instanceof Error ? e.message : String(e)}`
        ]
      };
    }

    updateSurfaceRun(runId, surfaceRun.id, { status: "verifying" }, run.surfaceRuns);

    const planItem = run.assignmentPlan?.surfaces.find(
      (s) => s.surfaceId === surfaceRun.surfaceId
    );
    const verifyCommands = planItem?.verifyCommands ?? [];
    const verificationResults: BusinessVerificationResult[] = [];
    for (const command of verifyCommands) {
      if (!command.trim()) continue;
      if (!path.isAbsolute(surfaceRun.repoPath)) {
        verificationResults.push({
          command,
          cwd: surfaceRun.repoPath,
          status: "skipped",
          summary: "repoPath is not absolute; verification skipped"
        });
        continue;
      }
      const result = await runVerifyCommand(surfaceRun.repoPath, command);
      verificationResults.push(result);
    }

    const anyVerifyFailed = verificationResults.some((v) => v.status === "failed");
    updateSurfaceRun(
      runId,
      surfaceRun.id,
      {
        status: anyVerifyFailed ? "failed" : "done",
        verificationResults,
        riskSummary: anyVerifyFailed
          ? "verification failed"
          : surfaceRun.riskSummary
      },
      run.surfaceRuns
    );
    if (anyVerifyFailed) {
      updateBusinessRequirementRun(runId, { status: "failed" });
      return {
        ok: false,
        errors: [`surface ${surfaceRun.surfaceId} verification failed`]
      };
    }
  }

  const finalRun = updateBusinessRequirementRun(runId, {
    status: "awaiting_commit_approval"
  });
  return { ok: true, run: finalRun ?? run };
}
