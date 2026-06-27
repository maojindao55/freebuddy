import path from "node:path";

import {
  getBusinessRequirementRun,
  updateBusinessRequirementRun
} from "./businessRequirementRuns.js";
import {
  createBranch,
  commitFiles,
  diffStat,
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

      const risks: string[] = [];
      if (allowedPaths.length === 0 && allChanged.length > 0) {
        risks.push("no allowedPaths configured; no files will be committed");
      } else if (allChanged.length > diffFiles.length) {
        risks.push(
          `${allChanged.length - diffFiles.length} file(s) outside allowedPaths excluded from commit`
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
        diffSummary,
        verificationResults: surfaceRun.verificationResults,
        risks,
        commitSha: surfaceRun.commitSha
      };
    })
  );

  const anyFailed = repositories.some((r) =>
    r.verificationResults.some((v) => v.status === "failed")
  );

  return {
    status: "pending",
    repositories,
    contractConsistency: {
      status: anyFailed ? "failed" : "passed",
      summary: anyFailed
        ? "one or more surfaces failed verification"
        : "all surfaces verified successfully"
    },
    allowCommitWithFailures
  };
}

export type CommitGatePatch = {
  repositories?: Array<{
    surfaceId: string;
    branchName?: string;
    commitMessage?: string;
  }>;
  allowCommitWithFailures?: boolean;
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

  if (!preview.allowCommitWithFailures) {
    const failedRepo = preview.repositories.find((r) =>
      r.verificationResults.some((v) => v.status === "failed")
    );
    if (failedRepo) {
      updateBusinessRequirementRun(runId, { commitGate: { ...preview, status: "rejected" } });
      return {
        ok: false,
        errors: ["verification failed; enable allowCommitWithFailures to commit anyway"]
      };
    }
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
