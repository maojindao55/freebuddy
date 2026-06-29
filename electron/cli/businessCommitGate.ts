import path from "node:path";

import {
  getBusinessRequirementRun,
  updateBusinessRequirementRun
} from "./businessRequirementRuns.js";
import {
  computeOutOfScopeFiles,
  createBranch,
  commitFiles,
  diffStat,
  evaluateCommitApproval,
  filterFilesByAllowedPaths,
  headSha,
  listChangedFiles,
  renderBranchName,
  slugify,
  stageFiles
} from "./businessGit.js";
import type {
  BusinessCommitGate,
  BusinessRequirementRun
} from "./businessWorkspaceTypes.js";

export { renderBranchName };

export async function previewBusinessCommitGate(
  run: BusinessRequirementRun
): Promise<BusinessCommitGate> {
  const branchTemplate = run.workspaceSnapshot.policy.branchNameTemplate;
  const runSlug = slugify(run.goal) || run.id.slice(0, 8);
  const allowCommitWithFailures = !run.workspaceSnapshot.policy.blockCommitOnVerificationFailure;

  const repositories = await Promise.all(
    run.surfaceRuns.map(async (surfaceRun) => {
      const surfaceKey = slugify(surfaceRun.surfaceId) || surfaceRun.surfaceId;
      const branchName = renderBranchName(branchTemplate, runSlug, surfaceKey);
      const surface = run.workspaceSnapshot.surfaces.find(
        (s) => s.id === surfaceRun.surfaceId
      );
      const allowedPaths = surface?.allowedPaths ?? [];

      let allChanged: string[] = [];
      let diffSummary = "";
      if (path.isAbsolute(surfaceRun.repoPath)) {
        const changed = await listChangedFiles(surfaceRun.repoPath);
        allChanged = changed.map((c) => c.path);
        diffSummary = await diffStat(surfaceRun.repoPath);
      }
      const diffFiles = filterFilesByAllowedPaths(allChanged, allowedPaths);
      const outOfScopeFiles = computeOutOfScopeFiles(allChanged, allowedPaths);

      const risks: string[] = [];
      if (allowedPaths.length === 0 && allChanged.length > 0) {
        risks.push("no allowedPaths configured; no files will be committed");
      }
      if (outOfScopeFiles.length > 0) {
        risks.push(
          `${outOfScopeFiles.length} out-of-scope file(s) will NOT be committed and require a decision`
        );
      }
      const failed = surfaceRun.verificationResults.filter(
        (r) => r.status === "failed"
      );
      if (failed.length > 0) {
        risks.push(`${failed.length} verification command(s) failed`);
      }
      if (!path.isAbsolute(surfaceRun.repoPath)) {
        risks.push("repoPath is not absolute");
      }

      return {
        surfaceId: surfaceRun.surfaceId,
        repoPath: surfaceRun.repoPath,
        branchName,
        commitMessage: `${run.goal} (${surfaceRun.surfaceId})`,
        diffFiles,
        outOfScopeFiles,
        diffSummary,
        verificationResults: surfaceRun.verificationResults,
        risks,
        commitSha: surfaceRun.commitSha
      };
    })
  );

  return {
    status: "pending",
    repositories,
    contractConsistency: assessContractConsistency(run),
    allowCommitWithFailures
  };
}

function assessContractConsistency(run: BusinessRequirementRun): {
  status: "passed" | "failed" | "unknown";
  summary: string;
} {
  // Structural check only: confirm every provider/consumer surface reached
  // `done`, and that a contract draft with at least one endpoint exists when
  // providers and consumers coexist. A semantic cross-repo interface
  // comparison (field/permission diff) is not implemented in this MVP.
  const surfaces = run.workspaceSnapshot.surfaces;
  const providerIds = new Set(
    surfaces
      .filter((s) => s.contractRole === "provider" || s.contractRole === "both")
      .map((s) => s.id)
  );
  const consumerIds = new Set(
    surfaces
      .filter((s) => s.contractRole === "consumer" || s.contractRole === "both")
      .map((s) => s.id)
  );
  const needsContract = providerIds.size > 0 && consumerIds.size > 0;

  if (!needsContract) {
    return {
      status: "passed",
      summary: "no provider/consumer contract pair; consistency check skipped"
    };
  }

  const incomplete = run.surfaceRuns.filter((sr) => {
    const isParty = providerIds.has(sr.surfaceId) || consumerIds.has(sr.surfaceId);
    return isParty && sr.status !== "done";
  });
  if (incomplete.length > 0) {
    return {
      status: "failed",
      summary: `${incomplete.length} contract party surface(s) did not reach done`
    };
  }

  const endpoints = run.contractDraft?.endpoints.length ?? 0;
  if (endpoints === 0) {
    return {
      status: "failed",
      summary: "contract draft has no endpoints defined"
    };
  }

  return {
    status: "passed",
    summary:
      "structural check passed (all parties done, endpoints declared); semantic interface comparison not implemented"
  };
}

export type CommitGatePatch = {
  repositories?: Array<{
    surfaceId: string;
    branchName?: string;
    commitMessage?: string;
  }>;
  allowCommitWithFailures?: boolean;
  allowOutOfScope?: boolean;
};

function applyPatch(
  gate: BusinessCommitGate,
  patch: CommitGatePatch
): BusinessCommitGate {
  let next = gate;
  if (patch.allowCommitWithFailures !== undefined) {
    next = { ...next, allowCommitWithFailures: patch.allowCommitWithFailures };
  }
  if (patch.repositories) {
    next = {
      ...next,
      repositories: next.repositories.map((repo) => {
        const p = patch.repositories!.find((r) => r.surfaceId === repo.surfaceId);
        if (!p) return repo;
        return {
          ...repo,
          branchName: p.branchName ?? repo.branchName,
          commitMessage: p.commitMessage ?? repo.commitMessage
        };
      })
    };
  }
  return next;
}

export async function approveBusinessCommitGate(
  runId: string,
  patch: CommitGatePatch = {}
): Promise<
  | { ok: true; run: BusinessRequirementRun }
  | { ok: false; errors: string[] }
> {
  const run = getBusinessRequirementRun(runId);
  if (!run) return { ok: false, errors: ["run not found"] };

  const preview = applyPatch(await previewBusinessCommitGate(run), patch);

  const approval = evaluateCommitApproval({
    repositories: preview.repositories,
    allowCommitWithFailures: preview.allowCommitWithFailures,
    allowOutOfScope: patch.allowOutOfScope ?? false
  });
  if (!approval.ok) {
    updateBusinessRequirementRun(runId, { commitGate: { ...preview, status: "rejected" } });
    return { ok: false, errors: [approval.reason ?? "commit blocked"] };
  }

  const committed: BusinessCommitGate = {
    ...preview,
    status: "approved",
    approvedAt: new Date().toISOString()
  };

  const surfaceRuns = [...run.surfaceRuns];
  for (const repo of committed.repositories) {
    if (!path.isAbsolute(repo.repoPath)) continue;
    if (repo.diffFiles.length === 0) continue;

    const branchOk = await createBranch(repo.repoPath, repo.branchName);
    if (!branchOk) {
      updateBusinessRequirementRun(runId, {
        commitGate: { ...committed, status: "rejected" },
        surfaceRuns: surfaceRuns.map((sr) =>
          sr.surfaceId === repo.surfaceId
            ? { ...sr, riskSummary: "branch creation failed" }
            : sr
        )
      });
      return { ok: false, errors: [`branch failed for ${repo.surfaceId}`] };
    }

    const addOk = await stageFiles(repo.repoPath, repo.diffFiles);
    if (!addOk) {
      return { ok: false, errors: [`git add failed for ${repo.surfaceId}`] };
    }

    const commitOk = await commitFiles(repo.repoPath, repo.commitMessage);
    if (!commitOk) {
      return { ok: false, errors: [`git commit failed for ${repo.surfaceId}`] };
    }

    const commitSha = await headSha(repo.repoPath);
    repo.commitSha = commitSha;
    const idx = surfaceRuns.findIndex((sr) => sr.surfaceId === repo.surfaceId);
    if (idx >= 0) {
      surfaceRuns[idx] = {
        ...surfaceRuns[idx],
        branchName: repo.branchName,
        commitMessage: repo.commitMessage,
        commitSha
      };
    }
  }

  committed.status = "committed";
  for (const repo of committed.repositories) {
    if (repo.outOfScopeFiles.length === 0) continue;
    const idx = surfaceRuns.findIndex((sr) => sr.surfaceId === repo.surfaceId);
    if (idx >= 0) {
      surfaceRuns[idx] = {
        ...surfaceRuns[idx],
        riskSummary: `${repo.outOfScopeFiles.length} out-of-scope file(s) left uncommitted (force-approved): ${repo.outOfScopeFiles.join(", ")}`
      };
    }
  }
  const finalRun = updateBusinessRequirementRun(runId, {
    status: "done",
    commitGate: committed,
    surfaceRuns
  });
  return { ok: true, run: finalRun ?? run };
}

export async function previewBusinessCommitGateForRun(
  runId: string
): Promise<
  | { ok: true; commitGate: BusinessCommitGate }
  | { ok: false; errors: string[] }
> {
  const run = getBusinessRequirementRun(runId);
  if (!run) return { ok: false, errors: ["run not found"] };
  const commitGate = await previewBusinessCommitGate(run);
  const updated = updateBusinessRequirementRun(runId, {
    status: "awaiting_commit_approval",
    commitGate
  });
  return { ok: true, commitGate: (updated ?? run).commitGate ?? commitGate };
}

export async function approveBusinessCommitGateForRun(
  runId: string,
  patch: CommitGatePatch = {}
): Promise<
  | { ok: true; run: BusinessRequirementRun }
  | { ok: false; errors: string[] }
> {
  return approveBusinessCommitGate(runId, patch);
}
