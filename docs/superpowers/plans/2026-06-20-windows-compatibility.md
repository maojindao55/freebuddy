# Windows Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FreeBuddy's runtime (agent spawn, kill, window chrome) and maintainer release flow work correctly on Windows, with zero behavior change on macOS/Linux.

**Architecture:** (1) Replace every `spawn` from `node:child_process` with `cross-spawn`, which resolves Windows `.cmd` shims and escapes args without a shell. (2) Add a `killProcessTree` helper that uses `taskkill /T /F` on Windows and signals on Unix. (3) Branch window-chrome options by platform. (4) Rewrite the bash release script as pure Node.

**Tech Stack:** Electron 39, TypeScript (NodeNext), Vite, node:test, cross-spawn, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-06-20-windows-compatibility-design.md`

**Verification commands (run often):**
- Typecheck: `npm run typecheck`
- Full test suite: `npm test` (builds electron, then runs `node --test tests/*.mjs`)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | Add `cross-spawn` dep + `@types/cross-spawn` dev dep; update release scripts |
| `electron/cli/process-kill.ts` | Create | `killProcessTree(child, mode)` + pure `taskkillArgs(pid)` |
| `electron/cli/runtime.ts` | Modify | Use cross-spawn; use `killProcessTree` in `cliKill` |
| `electron/cli/acpRuntime.ts` | Modify | Use `killProcessTree` in `cancel()` |
| `electron/cli/legacyRuntime.ts` | Modify | Use `killProcessTree` in timeout |
| `electron/cli/check.ts` | Modify | Use cross-spawn for `which`/`runVersion`/`cliInstall` |
| `electron/main.ts` | Modify | Branch window chrome by platform |
| `scripts/dev-electron.mjs` | Modify | Use cross-spawn |
| `scripts/start-electron.mjs` | Modify | Use cross-spawn |
| `scripts/release-lib.mjs` | Create | Pure release helpers (bump/validate/parseArgs) |
| `scripts/release.mjs` | Create | Node release runner (git via `execFileSync`) |
| `scripts/release.sh` | Delete | Replaced by `release.mjs` |
| `tests/process-kill.test.mjs` | Create | Test `taskkillArgs` |
| `tests/release-script.test.mjs` | Modify | Test new release lib + script wiring |

---

### Task 1: Add cross-spawn dependency

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install runtime dependency**

Run:
```bash
npm install cross-spawn
```
Expected: `cross-spawn` appears under `dependencies` in `package.json`; `package-lock.json` updated.

- [ ] **Step 2: Install TypeScript types**

Run:
```bash
npm install -D @types/cross-spawn
```
Expected: `@types/cross-spawn` appears under `devDependencies`.

- [ ] **Step 3: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: PASS (no errors). cross-spawn is not imported anywhere yet, so nothing changes — this just confirms the baseline is green.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add cross-spawn for cross-platform spawn"
```

---

### Task 2: Create process-kill helper (TDD)

**Files:**
- Create: `electron/cli/process-kill.ts`
- Test: `tests/process-kill.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/process-kill.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

// dist-electron is produced by `npm run build:electron`, which `npm test` runs first.
const { taskkillArgs } = await import("../dist-electron/cli/process-kill.js");

test("taskkillArgs builds a forceful tree-kill command for a pid", () => {
  assert.deepEqual(taskkillArgs(123), ["/PID", "123", "/T", "/F"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:electron && node --test tests/process-kill.test.mjs`
Expected: FAIL — `Cannot find module '.../dist-electron/cli/process-kill.js'` (file does not exist yet).

- [ ] **Step 3: Create the module**

Create `electron/cli/process-kill.ts`:

```ts
import spawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";

type Killable = Pick<ChildProcess, "pid" | "kill">;

/** Args for `taskkill` that force-kill a whole process tree. Pure/testable. */
export function taskkillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

/**
 * Terminate a child process and (on Windows) its entire descendant tree.
 * - win32: `taskkill /T /F` (no graceful/forceful distinction).
 * - unix: `child.kill(SIGTERM | SIGKILL)` depending on `mode`.
 */
export function killProcessTree(child: Killable, mode: "term" | "force"): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", taskkillArgs(pid), { stdio: "ignore" });
    return;
  }
  child.kill(mode === "force" ? "SIGKILL" : "SIGTERM");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:electron && node --test tests/process-kill.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add electron/cli/process-kill.ts tests/process-kill.test.mjs
git commit -m "feat: add cross-platform process-tree kill helper"
```

---

### Task 3: Wire killProcessTree into the runtime

**Files:**
- Modify: `electron/cli/runtime.ts` (`cliKill`, lines ~185-206; imports line ~1)
- Modify: `electron/cli/acpRuntime.ts` (`cancel()`, lines ~116-131; imports line ~4)
- Modify: `electron/cli/legacyRuntime.ts` (timeout, lines ~62-71; imports line ~3)

- [ ] **Step 1: Update `runtime.ts` import**

In `electron/cli/runtime.ts`, add the import. The file's import block starts at line 1; add a new line after the existing `runtimeShared.js` import group. Insert this line alongside the other `./...js` imports (e.g. immediately after the `runtimeShared.js` import block, before `export type`):

```ts
import { killProcessTree } from "./process-kill.js";
```

- [ ] **Step 2: Rewrite `cliKill` in `runtime.ts`**

Replace the body of `cliKill` (the `try { r.cancel?.(); r.child.kill("SIGTERM"); setTimeout(...) }` block) so that the kill goes through `killProcessTree`, and the SIGKILL escalation only runs on non-Windows (Windows `taskkill /F` already ends the tree). Replace the whole `cliKill` function with:

```ts
export function cliKill(sessionId: string): boolean {
  const r = running.get(sessionId);
  if (!r) return false;
  try {
    r.cancel?.();
    killProcessTree(r.child, "term");
    if (process.platform !== "win32") {
      setTimeout(() => {
        const still = running.get(sessionId);
        if (still) {
          try {
            killProcessTree(still.child, "force");
          } catch {
            /* noop */
          }
        }
      }, 2000);
    }
    updateTaskStatus(sessionId, "killed");
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Update `acpRuntime.ts` cancel()**

In `electron/cli/acpRuntime.ts`, add the import near the other `./...js` imports:

```ts
import { killProcessTree } from "./process-kill.js";
```

Inside the `running.set(args.sessionId, { ..., cancel: () => { ... } })` block, replace the line `still.child.kill("SIGTERM");` with:

```ts
            killProcessTree(still.child, "term");
```

- [ ] **Step 4: Update `legacyRuntime.ts` timeout**

In `electron/cli/legacyRuntime.ts`, add the import near the other `./...js` imports:

```ts
import { killProcessTree } from "./process-kill.js";
```

In the timeout handler, replace `child.kill("SIGKILL");` with:

```ts
        killProcessTree(child, "force");
```

- [ ] **Step 5: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: typecheck PASS; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/cli/runtime.ts electron/cli/acpRuntime.ts electron/cli/legacyRuntime.ts
git commit -m "fix: kill whole agent process tree on Windows via taskkill"
```

---

### Task 4: Switch electron-main spawn to cross-spawn

**Files:**
- Modify: `electron/cli/check.ts` (import line ~1)
- Modify: `electron/cli/runtime.ts` (import line ~1, spawn usage line ~125)

- [ ] **Step 1: Update `check.ts` import**

In `electron/cli/check.ts`, change line 1:

Before:
```ts
import { spawn } from "node:child_process";
```
After:
```ts
import spawn from "cross-spawn";
```

- [ ] **Step 2: Update `runtime.ts` import**

In `electron/cli/runtime.ts`, the first line is:

```ts
import { spawn, type ChildProcessByStdio } from "node:child_process";
```

Split it so `spawn` comes from `cross-spawn` and the type stays from node. Replace that line with:

```ts
import { type ChildProcessByStdio } from "node:child_process";
import spawn from "cross-spawn";
```

(The existing `spawn(built.bin, built.args, { ... }) as ChildProcessByStdio<...>` cast still compiles.)

- [ ] **Step 3: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add electron/cli/check.ts electron/cli/runtime.ts
git commit -m "fix: spawn agent binaries via cross-spawn for Windows .cmd shims"
```

---

### Task 5: Switch dev/start scripts to cross-spawn

**Files:**
- Modify: `scripts/dev-electron.mjs` (import line ~1)
- Modify: `scripts/start-electron.mjs` (import line ~1)

- [ ] **Step 1: Update `dev-electron.mjs` import**

In `scripts/dev-electron.mjs`, change line 1:

Before:
```js
import { spawn } from "node:child_process";
```
After:
```js
import spawn from "cross-spawn";
```

- [ ] **Step 2: Update `start-electron.mjs` import**

In `scripts/start-electron.mjs`, change line 1:

Before:
```js
import { spawn } from "node:child_process";
```
After:
```js
import spawn from "cross-spawn";
```

- [ ] **Step 3: Verify tests**

Run: `npm test`
Expected: PASS (covers `electron-shell.test.mjs` which imports from `scripts/`). No `.mjs` typecheck exists; `node --check` confirms syntax.

Run: `node --check scripts/dev-electron.mjs && node --check scripts/start-electron.mjs`
Expected: no output (syntax OK).

- [ ] **Step 4: Commit**

```bash
git add scripts/dev-electron.mjs scripts/start-electron.mjs
git commit -m "fix: run dev/start electron via cross-spawn on Windows"
```

---

### Task 6: Branch window chrome by platform

**Files:**
- Modify: `electron/main.ts` (`createWindow`, lines ~82-98)

- [ ] **Step 1: Replace the unconditional macOS chrome options**

In `electron/main.ts`, the `BrowserWindow` options currently contain (around lines 89-90):

```ts
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
```

First, add a helper just above `createWindow()` (after `loadAppIcon`), so the options are computed once:

```ts
function windowChromeOptions() {
  return process.platform === "darwin"
    ? {
        titleBarStyle: "hiddenInset" as const,
        trafficLightPosition: { x: 14, y: 14 }
      }
    : {};
}
```

Then, inside the `new BrowserWindow({ ... })` call, replace the two lines (`titleBarStyle` + `trafficLightPosition`) with a single spread:

```ts
    ...windowChromeOptions(),
```

The surrounding `...(appIcon ? { icon: appIcon } : {})` spread stays unchanged.

- [ ] **Step 2: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add electron/main.ts
git commit -m "fix: use native window chrome on Windows/Linux, macOS inset on darwin"
```

---

### Task 7: Rewrite release script as Node (TDD for pure helpers)

**Files:**
- Create: `scripts/release-lib.mjs`
- Create: `scripts/release.mjs`
- Delete: `scripts/release.sh`
- Modify: `package.json` (release script entries)
- Modify: `tests/release-script.test.mjs`

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `tests/release-script.test.mjs` with:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { bumpVersion, validateSemver, parseReleaseArgs } from "../scripts/release-lib.mjs";

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
const releaseScriptPath = new URL("../scripts/release.mjs", import.meta.url);
const releaseScript = fs.existsSync(releaseScriptPath)
  ? fs.readFileSync(releaseScriptPath, "utf8")
  : "";

test("package exposes node-based release script shortcuts", () => {
  assert.equal(packageJson.scripts?.release, "node scripts/release.mjs");
  assert.equal(packageJson.scripts?.["release:patch"], "node scripts/release.mjs patch");
  assert.equal(packageJson.scripts?.["release:minor"], "node scripts/release.mjs minor");
  assert.equal(packageJson.scripts?.["release:major"], "node scripts/release.mjs major");
});

test("bumpVersion increments the requested part and zeros the rest", () => {
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(bumpVersion("0.0.0", "patch"), "0.0.1");
});

test("bumpVersion throws on an invalid part", () => {
  assert.throws(() => bumpVersion("1.2.3", "bogus"), /无效的 bump 类型/);
});

test("validateSemver accepts valid and rejects invalid versions", () => {
  validateSemver("1.2.3");
  assert.throws(() => validateSemver("1.2"), /版本号格式无效/);
  assert.throws(() => validateSemver("1.2.3.4"), /版本号格式无效/);
});

test("parseReleaseArgs parses bump, explicit version, dry-run, yes, help", () => {
  assert.deepEqual(parseReleaseArgs(["minor"]), {
    help: false, bumpType: "minor", explicitVersion: "", dryRun: false, skipConfirm: false
  });
  assert.deepEqual(parseReleaseArgs(["1.2.3"]), {
    help: false, bumpType: "patch", explicitVersion: "1.2.3", dryRun: false, skipConfirm: false
  });
  assert.deepEqual(parseReleaseArgs(["v2.0.0", "--dry-run", "-y"]), {
    help: false, bumpType: "patch", explicitVersion: "2.0.0", dryRun: true, skipConfirm: true
  });
  assert.equal(parseReleaseArgs(["--help"]).help, true);
  assert.throws(() => parseReleaseArgs(["--nope"]), /未知参数/);
});

test("release runner updates Electron version files and performs git ops", () => {
  assert.ok(releaseScript.includes("package.json"));
  assert.ok(releaseScript.includes("package-lock.json"));
  assert.ok(releaseScript.includes("desktop/macos/Info.plist"));
  assert.match(releaseScript, /CFBundleShortVersionString/);
  assert.match(releaseScript, /--dry-run/);
  assert.match(releaseScript, /git/);
  assert.match(releaseScript, /tag/);
  assert.match(releaseScript, /push/);
  assert.match(releaseScript, /GitHub Actions/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/release-script.test.mjs`
Expected: FAIL — `Cannot find module '.../scripts/release-lib.mjs'`, and the package.json assertions still expect `bash scripts/release.sh`.

- [ ] **Step 3: Create the pure helper library**

Create `scripts/release-lib.mjs`:

```js
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
```

- [ ] **Step 4: Verify pure-helper tests pass**

Run: `node --test tests/release-script.test.mjs`
Expected: the bump/validate/parse tests PASS; the package.json + releaseScript assertions still FAIL (release.mjs not created, package.json not updated).

- [ ] **Step 5: Create the release runner**

Create `scripts/release.mjs`:

```js
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
    console.log("dry-run 完成，未实际修改仓库。");
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
```

- [ ] **Step 6: Update package.json release scripts**

In `package.json`, replace these four lines:

```json
    "release": "bash scripts/release.sh",
    "release:patch": "bash scripts/release.sh patch",
    "release:minor": "bash scripts/release.sh minor",
    "release:major": "bash scripts/release.sh major",
```

with:

```json
    "release": "node scripts/release.mjs",
    "release:patch": "node scripts/release.mjs patch",
    "release:minor": "node scripts/release.mjs minor",
    "release:major": "node scripts/release.mjs major",
```

- [ ] **Step 7: Delete the old bash script**

Run: `git rm scripts/release.sh`

- [ ] **Step 8: Verify all tests pass**

Run: `npm test`
Expected: PASS (all release-script assertions now green, plus the rest of the suite).

- [ ] **Step 9: Verify the new script's --help and --dry-run exit cleanly**

Run: `node scripts/release.mjs --help`
Expected: prints usage text (Chinese), exit code 0.

Run: `node scripts/release.mjs --dry-run patch`
Expected: prints a dry-run preview using the latest tag; exit code 0. (If the working tree is dirty because of in-progress edits, this will print the "工作区有未提交的改动" error — that's correct behavior; either stash first or trust the test coverage.)

- [ ] **Step 10: Syntax-check the new scripts**

Run: `node --check scripts/release.mjs && node --check scripts/release-lib.mjs`
Expected: no output (syntax OK).

- [ ] **Step 11: Commit**

```bash
git add scripts/release.mjs scripts/release-lib.mjs package.json tests/release-script.test.mjs
git commit -m "refactor: rewrite release script in Node for cross-platform support"
```

(Note: `scripts/release.sh` deletion was staged by `git rm` and will be in this commit too.)

---

### Task 8: Final verification

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: PASS (all three tsconfig projects: root, electron, preload).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all `tests/*.mjs` PASS.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: `vite build` + both `tsc` invocations succeed; `dist/` and `dist-electron/` produced.

- [ ] **Step 4: Confirm no stray references to the old script**

Run: `rg -n "release\.sh" --glob '!docs/superpowers/**'`
Expected: no matches outside `docs/superpowers/` (the spec/plan legitimately mention the old name).

- [ ] **Step 5: Document the Windows-only manual verification (cannot run on macOS)**

Append a short note to the spec's Testing section is not required; instead leave this checklist item as the record:

> Manual verification on Windows (CI or VM): run `npm run dev`, launch an agent (codex/claude/opencode), click Stop, and confirm via Task Manager that the agent and its child processes are gone. Confirm the window shows the standard Windows title bar.

- [ ] **Step 6: Final commit if any cleanup remains**

If steps 1-4 required no code changes, this step is a no-op. Otherwise commit the cleanup.

---

## Self-Review Notes

- **Spec coverage:** §1 spawn (Tasks 1,4,5) ✓ · §2 kill (Tasks 2,3) ✓ · §3 chrome (Task 6) ✓ · §4 release (Task 7) ✓.
- **Type consistency:** `killProcessTree(child, "term" | "force")` signature is identical across Tasks 2 & 3. `taskkillArgs(pid)` matches the test. `bumpVersion/validateSemver/parseReleaseArgs` names match between Task 7's lib and test.
- **Testability honesty:** cross-spawn and titlebar changes are verified via `typecheck` + existing suite (they touch electron modules not unit-testable in this repo's harness); release helpers and `taskkillArgs` get real TDD.
