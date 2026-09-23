#!/usr/bin/env node
// Proves the TypeScript sources actually *emit* valid JavaScript.
//
// This is not what ships: the WeChat devtools' `typescript` compiler plugin compiles the sources
// into the package it builds, previews and uploads. But `tsc --noEmit` alone would not catch a
// source that typechecks yet cannot be emitted (a stray decorator, a syntax the target rejects), so
// this script emits the same `miniprogram/**` sources to a temporary directory, checks that each
// declared page registered itself with `Page(...)`, that the app entry registers `App(...)`, and
// that every relative `require()` the emit produces resolves to an explicit file, and then removes
// the output. Nothing is written inside `miniprogramRoot`, so the devtools can never pick up a
// stale hand-built artifact.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

// Every relative `require()` in the emitted JS must point at an explicit file.
//
// The WeChat loader appends `.js` to a relative specifier and does **not** fall back to a
// directory's `index.js` the way Node does. A source that writes `import x from "./protocol"`
// emits `require("./protocol")`, which Node happily resolves to `protocol/index.js` but the
// devtools reject at runtime (`module 'protocol.js' is not defined`, app boot then fails and no
// page registers). This check resolves each specifier strictly — `<dir>/<spec>.js` must exist —
// deliberately without Node's implicit index lookup, so it catches exactly the sources Node
// would silently accept.
function listEmittedJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listEmittedJs(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

// Parse the emit instead of scanning text: a text regex would also match a `require("./x")`
// written inside a comment or string literal (there is one in `app.ts` explaining this very bug).
function collectRelativeSpecifiers(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers.filter((specifier) => specifier.startsWith("."));
}

const nonPortable = [];
for (const file of listEmittedJs(outDir)) {
  const source = readFileSync(file, "utf8");
  for (const specifier of collectRelativeSpecifiers(file, source)) {
    const target = `${resolve(dirname(file), specifier)}.js`;
    if (!existsSync(target)) {
      nonPortable.push(
        `${file.slice(outDir.length + 1)} requires "${specifier}" but ${target.slice(outDir.length + 1)} does not exist`
      );
    }
  }
}
if (nonPortable.length > 0) {
  fail(
    [
      "emitted JS has relative requires the WeChat loader cannot resolve (it appends .js and does",
      "not resolve directories to index.js). Import the explicit file, e.g. `./protocol/index`:"
    ].join("\n") + "\n" + nonPortable.map((line) => `  - ${line}`).join("\n")
  );
}

const emitted = readdirSync(join(outDir, "pages"));
console.log(`[emit:check] emitted ${emitted.length} page directories and app.js to .tmp-js/`);
console.log(`[emit:check] pages registering Page(...): ${pages.join(", ")}`);
console.log("[emit:check] relative requires resolve to explicit files (no directory-index imports)");

rmSync(outDir, { recursive: true, force: true });
console.log("[emit:check] ok (temporary output removed; the devtools produce the shipped JS)");
