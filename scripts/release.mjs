#!/usr/bin/env node
// Cross-platform release runner (replaces scripts/release.sh).
// Syncs version numbers → commits → tags → pushes to origin.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

import { bumpVersion, validateSemver, parseReleaseArgs, RELEASE_HELP } from "./release-lib.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(rootDir);

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });
}

function gitQuiet(args) {
  git(args, { stdio: "ignore" });
}

function getLatestTagVersion() {
  const out = git(["tag", "-l", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"], { stdio: ["ignore", "pipe", "ignore"] });
  const latest = out.split(/\r?\n/).find((l) => l.trim().length > 0);
  return latest ? latest.replace(/^v/, "") : "0.0.0";
}

function updateVersionFiles(version) {
  const writeJson = (filePath, value) =>
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);

  const packageJsonPath = path.join(rootDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  packageJson.version = version;
  writeJson(packageJsonPath, packageJson);

  const packageLockPath = path.join(rootDir, "package-lock.json");
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
  if ("version" in packageLock) packageLock.version = version;
  if (packageLock.packages && packageLock.packages[""]) packageLock.packages[""].version = version;
  writeJson(packageLockPath, packageLock);

  const infoPlistPath = path.join(rootDir, "desktop/macos/Info.plist");
  let infoPlist = fs.readFileSync(infoPlistPath, "utf8");
  const versionPattern = /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/;
  if (!versionPattern.test(infoPlist)) {
    throw new Error("desktop/macos/Info.plist 缺少 CFBundleShortVersionString");
  }
  infoPlist = infoPlist.replace(versionPattern, `$1${version}$2`);
  fs.writeFileSync(infoPlistPath, infoPlist);
}

async function confirm(question) {
  const rl = readline.createInterface({ input, output });
  try {
    const reply = await rl.question(question);
    return /^[Yy]$/.test(reply.trim());
  } finally {
    rl.close();
  }
}

function run(steps, dryRun) {
  for (const [label, fn] of steps) {
    if (dryRun) {
      console.log(`[dry-run] ${label}`);
    } else {
      console.log(`→ ${label}`);
      fn();
    }
  }
}

async function main() {
  const opts = parseReleaseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(RELEASE_HELP);
    process.exit(0);
  }

  // --- 前置检查 ---
  try {
    git(["rev-parse", "--git-dir"], { stdio: "ignore" });
  } catch {
    console.error("当前目录不是 git 仓库");
    process.exit(1);
  }

  const porcelain = git(["status", "--porcelain"], { stdio: ["ignore", "pipe", "ignore"] });
  if (porcelain.trim().length > 0) {
    console.error("工作区有未提交的改动，请先 commit 或 stash：");
    console.error(git(["status", "--short"]));
    process.exit(1);
  }

  const currentBranch = git(["branch", "--show-current"], { stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (currentBranch !== "main") {
    console.error(`警告: 当前分支是 '${currentBranch}'，通常应在 main 分支发布`);
    if (!opts.skipConfirm && !opts.dryRun) {
      if (!(await confirm("是否继续? [y/N] "))) process.exit(1);
    }
  }

  gitQuiet(["fetch", "origin", "--tags", "--quiet"]);

  const latestVersion = getLatestTagVersion();
  const newVersion = opts.explicitVersion || bumpVersion(latestVersion, opts.bumpType);
  validateSemver(newVersion);
  const newTag = `v${newVersion}`;

  try {
    git(["rev-parse", newTag], { stdio: "ignore" });
    console.error(`tag ${newTag} 已存在`);
    process.exit(1);
  } catch {
    /* tag does not exist — expected */
  }

  if (newVersion === latestVersion) {
    console.error(`新版本与最新 tag 相同: ${newVersion}`);
    process.exit(1);
  }

  console.log("");
  console.log("发布预览");
  console.log(`  当前最新 tag : v${latestVersion}`);
  console.log(`  新版本       : ${newVersion}`);
  console.log(`  新 tag       : ${newTag}`);
  console.log(`  分支         : ${currentBranch}`);
  console.log("  将更新文件   : package.json, package-lock.json, desktop/macos/Info.plist");
  console.log("");

  if (!opts.skipConfirm && !opts.dryRun) {
    if (!(await confirm(`确认发布 ${newTag}? [y/N] `))) {
      console.log("已取消");
      process.exit(0);
    }
  }

  const steps = [
    ["git add package.json package-lock.json desktop/macos/Info.plist", () => gitQuiet(["add", "package.json", "package-lock.json", "desktop/macos/Info.plist"])],
    [`git commit -m "chore: release ${newTag}"`, () => gitQuiet(["commit", "-m", `chore: release ${newTag}`])],
    [`git tag ${newTag}`, () => gitQuiet(["tag", newTag])],
    [`git push origin ${currentBranch}`, () => gitQuiet(["push", "origin", currentBranch])],
    [`git push origin ${newTag}`, () => gitQuiet(["push", "origin", newTag])]
  ];

  if (opts.dryRun) {
    console.log(`[dry-run] 将更新 package.json, package-lock.json, desktop/macos/Info.plist → ${newVersion}`);
    run(steps, true);
    console.log("");
    console.log("--dry-run 完成，未实际修改仓库。");
  } else {
    updateVersionFiles(newVersion);
    run(steps, false);
    console.log("");
    console.log(`发布完成: ${newTag}`);
    console.log("GitHub Actions 将自动构建并上传安装包。");
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
