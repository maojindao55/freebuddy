#!/usr/bin/env node
// Compiles the TypeScript sources and tests to CommonJS, then runs them with node:test.
// WeChat devtools cannot resolve imports outside miniprogramRoot, so tests compile the same
// sources into .tmp-test/ instead of importing them through a bundler.

import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(appRoot, ".tmp-test");
const tscPath = join(appRoot, "node_modules", "typescript", "bin", "tsc");

rmSync(outDir, { recursive: true, force: true });

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: appRoot, stdio: "inherit" });
  if (result.error) {
    console.error(`[test] failed to start: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

const compileStatus = run([tscPath, "-p", "tsconfig.test.json"]);
if (compileStatus !== 0) {
  process.exit(compileStatus);
}

const testDir = join(outDir, "tests");
const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(testDir, name));

if (testFiles.length === 0) {
  console.error(`[test] no compiled test files in ${testDir}`);
  process.exit(1);
}

// `--test-force-exit` is deliberately *not* used: it makes the runner exit while child TAP
// streams are still flushing, which silently drops whole tests from the report (observed as
// 176 vs 170 tests between identical runs). Every suite exits on its own; if one ever hangs,
// that hang is a real leak and must be fixed, not hidden.
process.exit(run(["--test", ...testFiles]));
