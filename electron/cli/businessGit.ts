import { execFile, spawn } from "node:child_process";
import path from "node:path";
import type {
  BusinessAssignmentPlan,
  BusinessVerificationResult
} from "./businessWorkspaceTypes.js";

export type GitResult = { code: number; stdout: string; stderr: string };

export function gitExec(
  repoPath: string,
  args: string[]
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoPath, ...args], (err, stdout, stderr) => {
      const rawCode = err ? (err as NodeJS.ErrnoException).code : 0;
      const code = typeof rawCode === "number" ? rawCode : 1;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

export function renderBranchName(
  template: string,
  runSlug: string,
  surfaceKey: string
): string {
  return template
    .replace(/{{runSlug}}/g, runSlug)
    .replace(/{{surfaceKey}}/g, surfaceKey);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export interface ChangedFile {
  path: string;
  untracked: boolean;
}

function parsePorcelain(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const status = line.slice(0, 2);
    let rest = line.slice(3);
    if (rest.startsWith('"') && rest.endsWith('"')) {
      rest = rest.slice(1, -1);
    }
    let filePath = rest;
    if (rest.includes(" -> ")) {
      filePath = rest.split(" -> ")[1];
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }
    }
    files.push({ path: filePath, untracked: status === "??" });
  }
  return files;
}

export async function listChangedFiles(
  repoPath: string
): Promise<ChangedFile[]> {
  const result = await gitExec(repoPath, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain",
    "--untracked-files=all"
  ]);
  if (result.code !== 0) return [];
  return parsePorcelain(result.stdout);
}

export async function diffStat(repoPath: string): Promise<string> {
  const result = await gitExec(repoPath, ["diff", "--stat"]);
  return result.code === 0 ? result.stdout.trim() : "";
}

export function filterFilesByAllowedPaths(
  files: string[],
  allowedPaths: string[]
): string[] {
  if (!allowedPaths || allowedPaths.length === 0) return [];
  const matchers = allowedPaths.map((p) =>
    path.normalize(p).replace(/\/+$/, "")
  );
  return files.filter((file) => {
    const norm = path.normalize(file);
    return matchers.some((m) => norm === m || norm.startsWith(m + path.sep));
  });
}

export async function ensureCleanRepo(
  repoPath: string
): Promise<{ ok: boolean; summary: string }> {
  const result = await gitExec(repoPath, ["status", "--porcelain"]);
  if (result.code !== 0) {
    return { ok: false, summary: `git status exited ${result.code}` };
  }
  const dirty = result.stdout.trim().length > 0;
  return {
    ok: !dirty,
    summary: dirty ? "repo has uncommitted changes" : "clean"
  };
}

export async function createBranch(
  repoPath: string,
  branchName: string
): Promise<boolean> {
  const result = await gitExec(repoPath, ["checkout", "-b", branchName]);
  return result.code === 0;
}

export async function stageFiles(
  repoPath: string,
  files: string[]
): Promise<boolean> {
  if (files.length === 0) return true;
  const result = await gitExec(repoPath, ["add", "--", ...files]);
  return result.code === 0;
}

export async function commitFiles(
  repoPath: string,
  message: string
): Promise<boolean> {
  const result = await gitExec(repoPath, ["commit", "-m", message]);
  return result.code === 0;
}

export async function headSha(repoPath: string): Promise<string | undefined> {
  const result = await gitExec(repoPath, ["rev-parse", "HEAD"]);
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export function runVerifyCommand(
  cwd: string,
  command: string
): Promise<BusinessVerificationResult> {
  const startedAt = new Date().toISOString();
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

export interface OrderedSurface {
  surfaceId: string;
  dependsOnSurfaceIds: string[];
}

export function orderSurfacesByDependency<T extends OrderedSurface>(
  surfaces: T[]
): T[] {
  const remaining = [...surfaces];
  const done = new Set<string>();
  const result: T[] = [];
  let guard = surfaces.length * surfaces.length + 1;
  while (remaining.length > 0 && guard-- > 0) {
    let progressed = false;
    for (let i = 0; i < remaining.length; i++) {
      const surface = remaining[i];
      const deps = surface.dependsOnSurfaceIds.filter(
        (d) => surfaces.some((s) => s.surfaceId === d)
      );
      if (deps.every((d) => done.has(d))) {
        result.push(surface);
        done.add(surface.surfaceId);
        remaining.splice(i, 1);
        progressed = true;
        break;
      }
    }
    if (!progressed) {
      const surface = remaining.shift()!;
      result.push(surface);
      done.add(surface.surfaceId);
    }
  }
  return result;
}

export function surfaceDependencyOrder(
  plan: BusinessAssignmentPlan
): string[] {
  return orderSurfacesByDependency(plan.surfaces).map((s) => s.surfaceId);
}
