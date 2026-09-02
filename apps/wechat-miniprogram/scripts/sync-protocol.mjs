#!/usr/bin/env node
// Generates the mini program protocol binding from the single wire authority.
//
// `packages/protocol/src/remote.ts` is a binding of `protocol/remote/v1`. The WeChat
// devtools can only resolve files inside `miniprogramRoot`, so this script copies the
// binding instead of importing across the monorepo. The copy is generated, git-ignored
// and carries the source sha256, so it can never drift by hand edits.
//
// Never edit `miniprogram/protocol/remote.generated.ts` — re-run `npm run sync:protocol`.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "..", "..");

const SOURCE_RELATIVE = join("packages", "protocol", "src", "remote.ts");
const TARGET_RELATIVE = join("miniprogram", "protocol", "remote.generated.ts");

const sourcePath = join(repoRoot, SOURCE_RELATIVE);
const targetPath = join(appRoot, TARGET_RELATIVE);

let source;
try {
  source = readFileSync(sourcePath, "utf8");
} catch (error) {
  console.error(
    `[sync-protocol] cannot read ${SOURCE_RELATIVE}. Run this from the freebuddy monorepo.`
  );
  console.error(`[sync-protocol] ${error.message}`);
  process.exit(1);
}

// The copy must stay self-contained: devtools will not resolve monorepo-relative imports.
if (/^\s*import\s/m.test(source) || /\brequire\(/.test(source)) {
  console.error(
    `[sync-protocol] ${SOURCE_RELATIVE} imports another module. The generated copy would not resolve inside miniprogramRoot.`
  );
  process.exit(1);
}

const sha256 = createHash("sha256").update(source, "utf8").digest("hex");

// Frozen by the protocol owner: exactly four lines, with authority and regenerate on
// separate lines. The sha256 always covers the UTF-8 bytes of the source file, never the
// generated output.
const HEADER_LINE_COUNT = 4;
const header = [
  "// GENERATED FILE - DO NOT EDIT.",
  `// Source: ${SOURCE_RELATIVE.split(join.sep).join("/")} (sha256 ${sha256})`,
  "// Wire authority: protocol/remote/v1",
  "// Regenerate with: npm run sync:protocol"
];

if (header.length !== HEADER_LINE_COUNT) {
  throw new Error(`generated header must be ${HEADER_LINE_COUNT} lines, got ${header.length}`);
}

const output = `${header.join("\n")}\n${source}`;

mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, output, "utf8");

console.log(`[sync-protocol] ${TARGET_RELATIVE.split(join.sep).join("/")} <- ${SOURCE_RELATIVE.split(join.sep).join("/")} (sha256 ${sha256.slice(0, 12)})`);
