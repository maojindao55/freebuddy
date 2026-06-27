import { spawn } from "node:child_process";
import path from "node:path";

import {
  getBusinessRequirementRun,
  updateBusinessRequirementRun
} from "./businessRequirementRuns.js";
import type {
  BusinessCommitGate,
  BusinessRequirementRun
} from "./businessWorkspaceTypes.js";

export function renderBranchName(
  template: string,
  runSlug: string,
  surfaceKey: string
): string {
  return template
    .replace(/{{runSlug}}/g, runSlug)
    .replace(/{{surfaceKey}}/g, surfaceKey);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function runShell(cwd: string, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => resolve({ code: 1, stdout, stderr: "spawn error" }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function changedFiles(repoPath: string): Promise<string[]> {
  const { code, stdout } = await runShell(repoPath, "git diff --name-only");
  if (code !== 0) return [];
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function diffStat(repoPath: string): Promise<string> {
  const { stdout } = await runShell(repoPath, "git diff --stat");
  return stdout.trim();
}

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
      const diffFiles = path.isAbsolute(surfaceRun.repoPath)
        ? await changedFiles(surfaceRun.repoPath)
        : [];
      const diffSummary = path.isAbsolute(surfaceRun.repoPath)
        ? await diffStat(surfaceRun.repoPath)
        : "";
      const risks: string[] = [];
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

async function createBranch(repoPath: string, branchName: string): Promise<boolean> {
  const { code } = await runShell(repoPath, `git checkout -b ${branchName}`);
  return code === 0;
}

async function stageFiles(repoPath: string, files: string[]): Promise<boolean> {
  const list = files.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(" ");
  const { code } = await runShell(repoPath, `git add -- ${list}`);
  return code === 0;
}

async function commitFiles(repoPath: string, message: string): Promise<boolean> {
  const { code } = await runShell(repoPath, `git commit -m "${message.replace(/"/g, '\\"')}"`);
  return code === 0;
}

async function headSha(repoPath: string): Promise<string | undefined> {
  const { code, stdout } = await runShell(repoPath, "git rev-parse HEAD");
  if (code !== 0) return undefined;
  return stdout.trim() || undefined;
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
