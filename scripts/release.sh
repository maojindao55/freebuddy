#!/usr/bin/env bash
# 自动发布新版本：同步版本号 → 提交 → 打 tag → 推送到 origin
#
# 用法:
#   ./scripts/release.sh              # 自动 patch 递增 (v1.0.5 → v1.0.6)
#   ./scripts/release.sh patch        # 同上
#   ./scripts/release.sh minor        # v1.0.5 → v1.1.0
#   ./scripts/release.sh major        # v1.0.5 → v2.0.0
#   ./scripts/release.sh 1.0.6        # 指定版本
#   ./scripts/release.sh --dry-run    # 仅预览，不执行
#   ./scripts/release.sh -y patch     # 跳过确认

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DRY_RUN=false
SKIP_CONFIRM=false
BUMP_TYPE="patch"
EXPLICIT_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -y|--yes)
      SKIP_CONFIRM=true
      shift
      ;;
    patch|minor|major)
      BUMP_TYPE="$1"
      shift
      ;;
    v[0-9]*|[0-9]*.[0-9]*.[0-9]*)
      EXPLICIT_VERSION="${1#v}"
      shift
      ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed -E 's/^# ?//'
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      echo "运行 ./scripts/release.sh --help 查看用法" >&2
      exit 1
      ;;
  esac
done

log() {
  echo "→ $*"
}

run() {
  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] $*"
  else
    log "$*"
    eval "$@"
  fi
}

get_latest_tag_version() {
  local latest
  latest="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1 || true)"
  if [[ -z "$latest" ]]; then
    echo "0.0.0"
  else
    echo "${latest#v}"
  fi
}

bump_version() {
  local version="$1"
  local part="$2"
  local major minor patch

  IFS='.' read -r major minor patch <<< "$version"
  major="${major:-0}"
  minor="${minor:-0}"
  patch="${patch:-0}"

  case "$part" in
    major)
      echo "$((major + 1)).0.0"
      ;;
    minor)
      echo "${major}.$((minor + 1)).0"
      ;;
    patch)
      echo "${major}.${minor}.$((patch + 1))"
      ;;
    *)
      echo "无效的 bump 类型: $part" >&2
      exit 1
      ;;
  esac
}

validate_semver() {
  local version="$1"
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "版本号格式无效: $version（应为 x.y.z）" >&2
    exit 1
  fi
}

update_version_files() {
  local version="$1"

  RELEASE_VERSION="$version" RELEASE_ROOT="$ROOT_DIR" node <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const version = process.env.RELEASE_VERSION;
const root = process.env.RELEASE_ROOT;

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const packageJsonPath = path.join(root, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
packageJson.version = version;
writeJson(packageJsonPath, packageJson);

const packageLockPath = path.join(root, "package-lock.json");
const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
if ("version" in packageLock) {
  packageLock.version = version;
}
if (packageLock.packages && packageLock.packages[""]) {
  packageLock.packages[""].version = version;
}
writeJson(packageLockPath, packageLock);

const infoPlistPath = path.join(root, "desktop/macos/Info.plist");
let infoPlist = fs.readFileSync(infoPlistPath, "utf8");
const versionPattern = /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/;
if (!versionPattern.test(infoPlist)) {
  throw new Error("desktop/macos/Info.plist 缺少 CFBundleShortVersionString");
}
infoPlist = infoPlist.replace(versionPattern, `$1${version}$2`);
fs.writeFileSync(infoPlistPath, infoPlist);
EOF
}

# --- 前置检查 ---

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "当前目录不是 git 仓库" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "工作区有未提交的改动，请先 commit 或 stash：" >&2
  git status --short >&2
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "警告: 当前分支是 '$CURRENT_BRANCH'，通常应在 main 分支发布" >&2
  if [[ "$SKIP_CONFIRM" != true && "$DRY_RUN" != true ]]; then
    read -r -p "是否继续? [y/N] " reply
    [[ "$reply" =~ ^[Yy]$ ]] || exit 1
  fi
fi

run "git fetch origin --tags --quiet"

LATEST_VERSION="$(get_latest_tag_version)"

if [[ -n "$EXPLICIT_VERSION" ]]; then
  NEW_VERSION="$EXPLICIT_VERSION"
else
  NEW_VERSION="$(bump_version "$LATEST_VERSION" "$BUMP_TYPE")"
fi

validate_semver "$NEW_VERSION"

NEW_TAG="v${NEW_VERSION}"

if git rev-parse "$NEW_TAG" >/dev/null 2>&1; then
  echo "tag $NEW_TAG 已存在" >&2
  exit 1
fi

if [[ "$NEW_VERSION" == "$LATEST_VERSION" ]]; then
  echo "新版本与最新 tag 相同: $NEW_VERSION" >&2
  exit 1
fi

echo ""
echo "发布预览"
echo "  当前最新 tag : v${LATEST_VERSION}"
echo "  新版本       : ${NEW_VERSION}"
echo "  新 tag       : ${NEW_TAG}"
echo "  分支         : ${CURRENT_BRANCH}"
echo "  将更新文件   : package.json, package-lock.json, desktop/macos/Info.plist"
echo ""

if [[ "$SKIP_CONFIRM" != true && "$DRY_RUN" != true ]]; then
  read -r -p "确认发布 ${NEW_TAG}? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "已取消"; exit 0; }
fi

# --- 执行发布 ---

if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] 将更新 package.json, package-lock.json, desktop/macos/Info.plist → ${NEW_VERSION}"
  run "git add package.json package-lock.json desktop/macos/Info.plist"
  run "git commit -m \"chore: release ${NEW_TAG}\""
  run "git tag \"${NEW_TAG}\""
  run "git push origin \"${CURRENT_BRANCH}\""
  run "git push origin \"${NEW_TAG}\""
  echo ""
  echo "dry-run 完成，未实际修改仓库。"
else
  update_version_files "$NEW_VERSION"

  run "git add package.json package-lock.json desktop/macos/Info.plist"
  run "git commit -m \"chore: release ${NEW_TAG}\""
  run "git tag \"${NEW_TAG}\""
  run "git push origin \"${CURRENT_BRANCH}\""
  run "git push origin \"${NEW_TAG}\""

  echo ""
  echo "发布完成: ${NEW_TAG}"
  echo "GitHub Actions 将自动构建并上传安装包。"
fi
