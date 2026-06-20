// Pure helpers for the release flow. No git/fs side effects — unit-testable.

export function bumpVersion(version, part) {
  const parts = version.split(".").map(Number);
  let major = parts[0] || 0;
  let minor = parts[1] || 0;
  let patch = parts[2] || 0;
  switch (part) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`无效的 bump 类型: ${part}`);
  }
}

export function validateSemver(version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error(`版本号格式无效: ${version}（应为 x.y.z）`);
  }
}

export function parseReleaseArgs(argv) {
  let bumpType = "patch";
  let explicitVersion = "";
  let dryRun = false;
  let skipConfirm = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "-y" || arg === "--yes") {
      skipConfirm = true;
    } else if (arg === "patch" || arg === "minor" || arg === "major") {
      bumpType = arg;
    } else if (/^v?[0-9]+\.[0-9]+\.[0-9]+$/.test(arg)) {
      explicitVersion = arg.replace(/^v/, "");
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else {
      throw new Error(`未知参数: ${arg}\n运行 node scripts/release.mjs --help 查看用法`);
    }
  }
  return { help, bumpType, explicitVersion, dryRun, skipConfirm };
}

export const RELEASE_HELP = `自动发布新版本：同步版本号 → 提交 → 打 tag → 推送到 origin

用法:
  node scripts/release.mjs              # 自动 patch 递增 (v1.0.5 → v1.0.6)
  node scripts/release.mjs patch        # 同上
  node scripts/release.mjs minor        # v1.0.5 → v1.1.0
  node scripts/release.mjs major        # v1.0.5 → v2.0.0
  node scripts/release.mjs 1.0.6        # 指定版本
  node scripts/release.mjs --dry-run    # 仅预览，不执行
  node scripts/release.mjs -y patch     # 跳过确认
`;
