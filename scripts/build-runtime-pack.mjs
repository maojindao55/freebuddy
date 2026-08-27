import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { resolveRuntimePackVersion } from "./runtime-release-lib.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, ".build", "runtime-pack");
const packVersion = resolveRuntimePackVersion();
const keyId = process.env.RUNTIME_SIGNING_KEY_ID || "runtime-dev";
const publishedAt = process.env.RUNTIME_PACK_PUBLISHED_AT || new Date().toISOString();

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "runtime"), { recursive: true });

const buildResult = await build({
  absWorkingDir: root,
  entryPoints: ["packages/runtime-entry/src/bootstrap.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: ".build/runtime-pack/runtime/index.mjs",
  metafile: true,
  logLevel: "info"
});

const builtins = new Set(
  builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name : `node:${name}`])
);
const externalImports = Object.values(buildResult.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((item) => item.external && !builtins.has(item.path));
if (externalImports.length > 0) {
  throw new Error(
    `runtime pack contains external package imports: ${externalImports
      .map((item) => item.path)
      .join(", ")}`
  );
}
const forbiddenInputs = Object.keys(buildResult.metafile.inputs).filter(
  (name) => /(^|\/)electron\//.test(name) || /(^|\/)better-sqlite3(\/|$)/.test(name)
);
if (forbiddenInputs.length > 0) {
  throw new Error(`runtime pack contains forbidden host inputs: ${forbiddenInputs.join(", ")}`);
}

const bundle = fs.readFileSync(path.join(outDir, "runtime/index.mjs"), "utf8");
if (bundle.includes('from "electron"') || bundle.includes("better-sqlite3")) {
  throw new Error("runtime pack contains forbidden host imports");
}

const manifest = {
  schemaVersion: 1,
  bundleId: "dev.freebuddy.runtime",
  version: packVersion,
  rpcVersion: 1,
  engine: { node: ">=22.0.0" },
  hostApi: ">=1.0.0 <2.0.0",
  entry: "runtime/index.mjs",
  keyId,
  publishedAt,
  providesCapabilities: ["workflow", "delegation", "cli-stream"],
  requiresHostCapabilities: [
    "agent.execute.v1",
    "workflow.repository.v1",
    "delegation.repository.v1",
    "events.publish.v1"
  ]
};

const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
fs.writeFileSync(path.join(outDir, "manifest.json"), manifestText);
const licensesText = "FreeBuddy runtime pack. See repository LICENSE.\n";
fs.writeFileSync(path.join(outDir, "LICENSES.txt"), licensesText);
const checksums = {
  files: {
    "LICENSES.txt": createHash("sha256").update(licensesText).digest("hex"),
    "manifest.json": createHash("sha256").update(manifestText).digest("hex"),
    "runtime/index.mjs": createHash("sha256")
      .update(fs.readFileSync(path.join(outDir, "runtime/index.mjs")))
      .digest("hex")
  }
};
fs.writeFileSync(path.join(outDir, "checksums.json"), `${JSON.stringify(checksums, null, 2)}\n`);
console.log(`runtime pack written to ${outDir}`);
