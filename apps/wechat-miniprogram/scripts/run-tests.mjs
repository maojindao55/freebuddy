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

process.exit(run(["--test", "--test-force-exit", ...testFiles]));
