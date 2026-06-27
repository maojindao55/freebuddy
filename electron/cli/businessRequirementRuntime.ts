import { spawn } from "node:child_process";
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
import type {
  BusinessAssignmentPlan,
  BusinessContractDraft,
  BusinessRequirementRun,
  BusinessSurfaceRun,
  BusinessVerificationResult,
  BusinessWorkspace
} from "./businessWorkspaceTypes.js";

export interface CreateRunFromAssignmentInput {
  workspaceId: string;
  workspaceSnapshot: BusinessWorkspace;
  teamId?: string;
  goal: string;
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
      commitSha: undefined
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
  const surfaceRuns = buildSurfaceRuns(input.assignmentPlan, input.workspaceSnapshot);
  const now = new Date().toISOString();
  const run: BusinessRequirementRun = {
    id: nanoid(),
    workspaceId: input.workspaceId,
    workspaceSnapshot: input.workspaceSnapshot,
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

export function runVerifyCommand(
  cwd: string,
  command: string
): Promise<BusinessVerificationResult> {
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      resolve({
        command,
        cwd,
        status: "failed",
        summary: `failed to start: ${err.message}`,
        startedAt,
        endedAt: new Date().toISOString()
      });
    });
    child.on("close", (code) => {
      const tail = (stdout || stderr).trim().slice(-240);
      resolve({
        command,
        cwd,
        status: code === 0 ? "passed" : "failed",
        exitCode: code ?? undefined,
        summary: tail || `exit ${code}`,
        startedAt,
        endedAt: new Date().toISOString()
      });
    });
  });
}

export function ensureCleanRepo(repoPath: string): Promise<{ ok: boolean; summary: string }> {
  return new Promise((resolve) => {
    const child = spawn("git status --porcelain", {
      cwd: repoPath,
      shell: true
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => {
      resolve({ ok: false, summary: "git not available" });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, summary: `git status exited ${code}` });
        return;
      }
      const dirty = stdout.trim().length > 0;
      resolve({
        ok: !dirty,
        summary: dirty ? "repo has uncommitted changes" : "clean"
      });
    });
  });
}

function buildPrompt(
  run: BusinessRequirementRun,
  surfaceRun: BusinessSurfaceRun
): string {
  const planItem = run.assignmentPlan?.surfaces.find(
    (s) => s.surfaceId === surfaceRun.surfaceId
  );
  const tasks = planItem?.tasks ?? [];
  const contractNote = run.contractDraft
    ? `\nContract context: ${run.contractDraft.title} (providers: ${run.contractDraft.providerSurfaceIds.join(", ")}; consumers: ${run.contractDraft.consumerSurfaceIds.join(", ")}).`
    : "";
  return [
    `Business goal: ${run.goal}`,
    `Surface: ${surfaceRun.surfaceId}`,
    ...tasks.map((task) => `- ${task}`),
    contractNote
  ].join("\n");
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

  for (const surfaceRun of run.surfaceRuns) {
    const agent = resolveAgent(surfaceRun.agentId);
    if (!agent) {
      updateBusinessRequirementRun(runId, {
        status: "failed",
        surfaceRuns: run.surfaceRuns.map((sr) =>
          sr.id === surfaceRun.id
            ? { ...sr, status: "failed", riskSummary: `unknown agent ${surfaceRun.agentId}` }
            : sr
        )
      });
      return { ok: false, errors: [`unknown agent: ${surfaceRun.agentId}`] };
    }

    updateBusinessRequirementRun(runId, {
      surfaceRuns: run.surfaceRuns.map((sr) =>
        sr.id === surfaceRun.id ? { ...sr, status: "running" } : sr
      )
    });

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

    const latestBefore = getBusinessRequirementRun(runId);
    const currentRuns = (latestBefore ?? run).surfaceRuns;
    try {
      await cliRun(webContents, args);
      const verifyingRuns = currentRuns.map((sr) =>
        sr.id === surfaceRun.id ? { ...sr, status: "verifying" as const } : sr
      );
      updateBusinessRequirementRun(runId, { surfaceRuns: verifyingRuns });
    } catch (e) {
      const failedRuns = currentRuns.map((sr) =>
        sr.id === surfaceRun.id
          ? {
              ...sr,
              status: "failed" as const,
              riskSummary: e instanceof Error ? e.message : String(e)
            }
          : sr
      );
      updateBusinessRequirementRun(runId, { status: "failed", surfaceRuns: failedRuns });
      return {
        ok: false,
        errors: [
          `surface ${surfaceRun.surfaceId} failed: ${e instanceof Error ? e.message : String(e)}`
        ]
      };
    }

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

    const verifyingRun = getBusinessRequirementRun(runId);
    const runsAfterVerify = (verifyingRun ?? run).surfaceRuns.map((sr) =>
      sr.id === surfaceRun.id
        ? {
            ...sr,
            status: "done" as const,
            verificationResults,
            diffSummary: sr.diffSummary
          }
        : sr
    );
    updateBusinessRequirementRun(runId, { surfaceRuns: runsAfterVerify });
  }

  const finished = getBusinessRequirementRun(runId);
  const finalRun = updateBusinessRequirementRun(runId, {
    status: "awaiting_commit_approval"
  });
  return { ok: true, run: finalRun ?? (finished as BusinessRequirementRun) };
}
