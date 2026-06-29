import path from "node:path";

import { builtinCliMembers } from "./members.js";
import {
  applySurfacePatch,
  executeSurfaceWaves,
  groupSurfacesByLevel
} from "./businessGit.js";
import type { CliRunArgs } from "./runtimeShared.js";
import type {
  BusinessContractDraft,
  BusinessRequirementRun,
  BusinessSurfaceRun,
  BusinessVerificationResult
} from "./businessWorkspaceTypes.js";

/**
 * This module contains the business-run scheduling logic with all side effects
 * (agent run, verification, persistence) injected. It deliberately has NO
 * electron/db imports so it can be unit-tested in plain Node with mocks.
 */

export interface BusinessRunDeps {
  cliRun: (args: CliRunArgs) => Promise<void>;
  ensureCleanRepo: (repoPath: string) => Promise<{ ok: boolean; summary: string }>;
  runVerifyCommand: (
    cwd: string,
    command: string
  ) => Promise<BusinessVerificationResult>;
  patchSurfaceRuns: (
    updater: (runs: BusinessSurfaceRun[]) => BusinessSurfaceRun[]
  ) => void;
  setStatus: (status: BusinessRequirementRun["status"]) => void;
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
  const verifyCommands = planItem?.verifyCommands ?? [];
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
  const verificationNote = verifyCommands.length
    ? `Verification: after implementation, FreeBuddy will run these fixed commands: ${verifyCommands.join(", ")}. You may also run focused checks while working.`
    : [
        "Verification: no fixed verification commands are configured.",
        "Before finishing, inspect project files such as package.json, composer.json, go.mod, Cargo.toml, Makefile, README, or framework docs, then run the most appropriate checks yourself.",
        "Report exactly which checks you ran and anything you could not run."
      ].join(" ");
  return [
    `Business goal: ${run.goal}`,
    `Surface: ${surfaceRun.surfaceId}`,
    scope,
    verificationNote,
    ...tasks.map((task) => `- ${task}`),
    contractNote
  ].join("\n");
}

export async function startBusinessRunCore(
  run: BusinessRequirementRun,
  deps: BusinessRunDeps
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const patchSurface = (
    surfaceRunId: string,
    patch: Partial<BusinessSurfaceRun>
  ) => {
    deps.patchSurfaceRuns((runs) => applySurfacePatch(runs, surfaceRunId, patch));
  };

  const policy = run.workspaceSnapshot.policy;
  if (policy.requireCleanRepoBeforeRun) {
    for (const surfaceRun of run.surfaceRuns) {
      if (!path.isAbsolute(surfaceRun.repoPath)) continue;
      const status = await deps.ensureCleanRepo(surfaceRun.repoPath);
      if (!status.ok) {
        patchSurface(surfaceRun.id, {
          status: "blocked",
          riskSummary: status.summary
        });
        deps.setStatus("failed");
        return {
          ok: false,
          errors: [
            `surface ${surfaceRun.surfaceId} repo is not clean: ${status.summary}`
          ]
        };
      }
    }
  }

  const items = run.surfaceRuns.map((sr) => ({
    surfaceId: sr.surfaceId,
    dependsOnSurfaceIds:
      run.assignmentPlan?.surfaces.find((p) => p.surfaceId === sr.surfaceId)
        ?.dependsOnSurfaceIds ?? [],
    surfaceRun: sr
  }));
  const levels = groupSurfacesByLevel(items);

  const runOneSurface = async (
    surfaceRun: BusinessSurfaceRun
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    const agent = resolveAgent(surfaceRun.agentId);
    if (!agent) {
      patchSurface(surfaceRun.id, {
        status: "failed",
        riskSummary: `unknown agent ${surfaceRun.agentId}`
      });
      return { ok: false, error: `unknown agent: ${surfaceRun.agentId}` };
    }

    patchSurface(surfaceRun.id, { status: "running" });

    const args: CliRunArgs = {
      sessionId: `${run.id}:${surfaceRun.surfaceId}`,
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
      await deps.cliRun(args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      patchSurface(surfaceRun.id, { status: "failed", riskSummary: msg });
      return { ok: false, error: `surface ${surfaceRun.surfaceId} failed: ${msg}` };
    }

    patchSurface(surfaceRun.id, { status: "verifying" });

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
      const result = await deps.runVerifyCommand(surfaceRun.repoPath, command);
      verificationResults.push(result);
    }

    const anyVerifyFailed = verificationResults.some(
      (v) => v.status === "failed"
    );
    patchSurface(surfaceRun.id, {
      status: anyVerifyFailed ? "failed" : "done",
      verificationResults,
      riskSummary: anyVerifyFailed ? "verification failed" : surfaceRun.riskSummary
    });
    return anyVerifyFailed
      ? { ok: false, error: `surface ${surfaceRun.surfaceId} verification failed` }
      : { ok: true };
  };

  // Run surfaces in dependency waves: independent surfaces (e.g. separate
  // client/server/admin repos with no dependency) execute concurrently within
  // a wave; dependents wait for their providers' wave to finish.
  const result = await executeSurfaceWaves({
    levels: levels.map((level) => level.map((item) => item.surfaceRun)),
    runSurface: runOneSurface
  });
  if (!result.ok) {
    deps.setStatus("failed");
    return result;
  }

  deps.setStatus("awaiting_commit_approval");
  return { ok: true };
}
