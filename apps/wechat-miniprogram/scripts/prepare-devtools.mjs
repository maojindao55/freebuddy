#!/usr/bin/env node
// Prepares this directory so the WeChat devtools can import and compile it.
//
// The devtools resolve files *only* inside `miniprogramRoot` and compile the TypeScript itself, so
// "prepared" means exactly:
//
//   1. the generated protocol binding exists (`npm run sync:protocol`) — it is git-ignored, so a
//      fresh clone has no `miniprogram/protocol/remote.generated.ts` and the project would not
//      compile without this step;
//   2. every page `app.json` declares has its `.ts` and `.wxml` present (a missing file is a
//      devtools compile error that is much cheaper to catch here);
//   3. `tsc --noEmit` passes for the same sources the devtools will compile.
//
// It deliberately does NOT produce the shipped JS: the devtools' `typescript` compiler plugin does
// that when it builds/previews/uploads the project. `npm run emit:check` is the separate proof
// that these sources do emit valid JS.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const miniprogramRoot = join(appRoot, "miniprogram");
const tscPath = join(appRoot, "node_modules", "typescript", "bin", "tsc");

function fail(message) {
  console.error(`[prepare-devtools] ${message}`);
  process.exit(1);
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: appRoot, stdio: "inherit" });
  if (result.error) {
    fail(`failed to start ${args[0]}: ${result.error.message}`);
  }
  return result.status ?? 1;
}

// 1. Generated protocol binding.
if (run([join(appRoot, "scripts", "sync-protocol.mjs")]) !== 0) {
  fail("sync:protocol failed");
}

// 2. Declared pages exist on disk.
const appJsonPath = join(miniprogramRoot, "app.json");
if (!existsSync(appJsonPath)) {
  fail(`missing ${appJsonPath}`);
}
let appJson;
try {
  appJson = JSON.parse(readFileSync(appJsonPath, "utf8"));
} catch (error) {
  fail(`app.json is not valid JSON: ${error.message}`);
}
const pages = Array.isArray(appJson.pages) ? appJson.pages : [];
if (pages.length === 0) {
  fail("app.json declares no pages");
}
for (const page of pages) {
  for (const extension of [".ts", ".wxml", ".json"]) {
    const file = join(miniprogramRoot, `${page}${extension}`);
    if (!existsSync(file)) {
      fail(`app.json declares "${page}" but ${file} is missing`);
    }
  }
}

// 3. The sources the devtools will compile must typecheck.
if (run([tscPath, "-p", join(appRoot, "tsconfig.json")]) !== 0) {
  fail("typecheck failed");
}

const projectConfig = join(appRoot, "project.config.json");
console.log("[prepare-devtools] ready");
console.log(`[prepare-devtools]   project: ${projectConfig}`);
console.log(`[prepare-devtools]   pages:   ${pages.join(", ")}`);
console.log("[prepare-devtools] next: npm run devtools   (opens the project in WeChat devtools)");
