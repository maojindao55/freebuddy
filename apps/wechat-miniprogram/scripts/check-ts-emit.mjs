#!/usr/bin/env node
// Proves the TypeScript sources actually *emit* valid JavaScript.
//
// This is not what ships: the WeChat devtools' `typescript` compiler plugin compiles the sources
// into the package it builds, previews and uploads. But `tsc --noEmit` alone would not catch a
// source that typechecks yet cannot be emitted (a stray decorator, a syntax the target rejects), so
// this script emits the same `miniprogram/**` sources to a temporary directory, checks that each
// declared page registered itself with `Page(...)` and that the app entry registers `App(...)`,
// and then removes the output. Nothing is written inside `miniprogramRoot`, so the devtools can
// never pick up a stale hand-built artifact.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const miniprogramRoot = join(appRoot, "miniprogram");
const outDir = join(appRoot, ".tmp-js");
const tscPath = join(appRoot, "node_modules", "typescript", "bin", "tsc");

function fail(message) {
  console.error(`[emit:check] ${message}`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });

const compile = spawnSync(process.execPath, [tscPath, "-p", join(appRoot, "tsconfig.emit.json")], {
  cwd: appRoot,
  stdio: "inherit"
});
if (compile.error) {
  fail(`failed to start tsc: ${compile.error.message}`);
}
if ((compile.status ?? 1) !== 0) {
  fail("tsc emit failed");
}

const appJson = JSON.parse(readFileSync(join(miniprogramRoot, "app.json"), "utf8"));
const pages = Array.isArray(appJson.pages) ? appJson.pages : [];

function assertRegisters(relativeJs, marker) {
  const file = join(outDir, relativeJs);
  if (!existsSync(file)) {
    fail(`expected emitted file ${relativeJs}`);
  }
  const source = readFileSync(file, "utf8");
  if (!source.includes(marker)) {
    fail(`${relativeJs} does not register ${marker.trim()}`);
  }
}

assertRegisters("app.js", "App(");
for (const page of pages) {
  // `pages/home/home` -> `.tmp-js/pages/home/home.js`
  assertRegisters(`${page}.js`, "Page(");
}

const emitted = readdirSync(join(outDir, "pages"));
console.log(`[emit:check] emitted ${emitted.length} page directories and app.js to .tmp-js/`);
console.log(`[emit:check] pages registering Page(...): ${pages.join(", ")}`);

rmSync(outDir, { recursive: true, force: true });
console.log("[emit:check] ok (temporary output removed; the devtools produce the shipped JS)");
