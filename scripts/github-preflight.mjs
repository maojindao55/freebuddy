#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tokenEnvNames = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN"
];

export function parseGitHost(remoteUrl) {
  const value = remoteUrl.trim();
  const scpStyle = value.match(/^[^@\s]+@([^:\s]+):/);
  if (scpStyle) return canonicalApiHost(scpStyle[1]);

  try {
    return canonicalApiHost(new URL(value).hostname);
  } catch {
    return "";
  }
}

function canonicalApiHost(host) {
  // GitHub documents ssh.github.com:443 as an alternate SSH transport for
  // networks that block port 22. Its REST/GraphQL and gh auth host remains
  // github.com, so API preflight must not query the SSH-only endpoint.
  return host.toLowerCase() === "ssh.github.com" ? "github.com" : host;
}

export function isSshRemote(remoteUrl) {
  const value = remoteUrl.trim();
  return /^[^@\s]+@[^:\s]+:/.test(value) || /^ssh:\/\//i.test(value);
}

export function configuredTokenEnvNames(env = process.env) {
  return tokenEnvNames.filter((name) => Boolean(env[name]?.trim()));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}

function outputOf(result) {
  return [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function printFailure(label, result) {
  console.error(`✗ ${label}`);
  const output = outputOf(result);
  if (output) console.error(output);
}

function printRecovery(host, envOverrides) {
  if (process.env.CODEX_SANDBOX) {
    console.error("\n检测到 Codex 受限环境，当前错误可能是沙箱无法访问 macOS 钥匙串或网络。");
    console.error("请先允许在系统权限环境中重新运行 npm run github:preflight；");
    console.error("只有系统权限环境也失败时，才执行新的网页登录，避免反复签发 OAuth Token。");
    return;
  }

  console.error("\n修复后重新运行预检：");
  if (envOverrides.length > 0) {
    console.error(`  unset ${envOverrides.join(" ")}`);
    console.error("  同时从 shell 配置文件中移除这些长期 Token 环境变量");
  }
  console.error(`  gh auth login --hostname ${host} --web --git-protocol ssh`);
  console.error("  npm run github:preflight");
}

export function main() {
  const gitVersion = run("git", ["--version"]);
  if (gitVersion.status !== 0) {
    printFailure("未找到 git", gitVersion);
    return 1;
  }

  const repository = run("git", ["rev-parse", "--show-toplevel"]);
  if (repository.status !== 0) {
    printFailure("当前目录不是 Git 仓库", repository);
    return 1;
  }

  const origin = run("git", ["remote", "get-url", "origin"]);
  if (origin.status !== 0) {
    printFailure("当前仓库没有 origin 远程", origin);
    return 1;
  }

  const originUrl = origin.stdout.trim();
  const host = parseGitHost(originUrl) || "github.com";
  const envOverrides = configuredTokenEnvNames();

  console.log("GitHub 发布预检");
  console.log(`  仓库远程: ${originUrl}`);
  console.log(`  GitHub 主机: ${host}`);

  if (isSshRemote(originUrl)) {
    console.log("✓ Git push 使用 SSH，与 GitHub API Token 相互独立");
  } else {
    console.warn("! origin 不是 SSH 地址；建议改用 SSH，避免 Git push 依赖 API Token");
  }

  if (envOverrides.length > 0) {
    console.warn(`! 检测到 Token 环境变量覆盖系统钥匙串: ${envOverrides.join(", ")}`);
    console.warn("  不会显示变量值；本地长期使用时建议从 shell 配置中移除");
  } else {
    console.log("✓ 未发现覆盖系统钥匙串的 GitHub Token 环境变量");
  }

  const ghVersion = run("gh", ["--version"]);
  if (ghVersion.status !== 0) {
    printFailure("未找到 GitHub CLI（gh）", ghVersion);
    console.error("  安装说明: https://cli.github.com/");
    return 1;
  }

  const auth = run("gh", ["auth", "status", "--hostname", host]);
  if (auth.status !== 0) {
    printFailure("GitHub CLI 登录无效", auth);
    printRecovery(host, envOverrides);
    return 1;
  }
  console.log("✓ GitHub CLI 登录状态有效");

  const apiUser = run("gh", ["api", "--hostname", host, "user", "--jq", ".login"]);
  if (apiUser.status !== 0 || !apiUser.stdout.trim()) {
    printFailure("GitHub API 实际调用失败", apiUser);
    printRecovery(host, envOverrides);
    return 1;
  }
  console.log(`✓ GitHub API 可用，当前账号: ${apiUser.stdout.trim()}`);

  const repositoryAccess = run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner"
  ]);
  if (repositoryAccess.status !== 0 || !repositoryAccess.stdout.trim()) {
    printFailure("当前仓库的 GitHub API 权限不足", repositoryAccess);
    printRecovery(host, envOverrides);
    return 1;
  }
  console.log(`✓ 当前仓库 API 权限可用: ${repositoryAccess.stdout.trim()}`);
  console.log("\n预检通过，可以 push 并创建 PR。注意：GitHub App Connector 仍是独立授权层。");
  return 0;
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  process.exitCode = main();
}
