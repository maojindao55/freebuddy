import fs from "node:fs";
import path from "node:path";
import { sign, createPrivateKey } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createDeterministicZipBuffer,
  resolveRuntimePackVersion,
  runtimeReleaseRepo,
  runtimeReleaseTag,
  sha256Buffer
} from "./runtime-release-lib.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packDir = path.join(root, ".build", "runtime-pack");
const outDir = path.join(root, ".build", "runtime-release");
const version = resolveRuntimePackVersion();
const repo = runtimeReleaseRepo();
const tag = runtimeReleaseTag(version);
const zipName = `freebuddy-runtime-${version}.zip`;
const channel = process.env.RUNTIME_RELEASE_CHANNEL || "stable";

if (!fs.existsSync(path.join(packDir, "runtime", "index.mjs"))) {
  throw new Error("runtime pack missing; run npm run runtime:build first");
}
if (!fs.existsSync(path.join(packDir, "manifest.sig"))) {
  throw new Error("runtime pack is unsigned; run npm run runtime:sign first");
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const zipFiles = {};
for (const file of ["manifest.json", "manifest.sig", "checksums.json", "LICENSES.txt", "runtime/index.mjs"]) {
  const full = path.join(packDir, file);
  if (!fs.existsSync(full)) throw new Error(`missing pack file: ${file}`);
  zipFiles[file] = fs.readFileSync(full);
}
const zipBytes = createDeterministicZipBuffer(zipFiles);
fs.writeFileSync(path.join(outDir, zipName), zipBytes);

const manifest = JSON.parse(fs.readFileSync(path.join(packDir, "manifest.json"), "utf8"));
const descriptor = {
  schemaVersion: 1,
  channel,
  bundleId: "dev.freebuddy.runtime",
  version,
  hostApi: ">=1.0.0 <2.0.0",
  archiveUrl: `https://github.com/${repo}/releases/download/${tag}/${zipName}`,
  archiveSha256: sha256Buffer(zipBytes),
  archiveBytes: zipBytes.byteLength,
  publishedAt: manifest.publishedAt || process.env.RUNTIME_PACK_PUBLISHED_AT || "1970-01-01T00:00:00.000Z",
  keyId: process.env.RUNTIME_SIGNING_KEY_ID || manifest.keyId || "runtime-dev"
};
const descriptorText = `${JSON.stringify(descriptor, null, 2)}\n`;
fs.writeFileSync(path.join(outDir, `${channel}.json`), descriptorText);

const fromEnv = process.env.RUNTIME_SIGNING_PRIVATE_KEY?.replace(/\\n/g, "\n")?.trim();
const fromFile = process.env.RUNTIME_SIGNING_PRIVATE_KEY_FILE?.trim();
if (
  !fromEnv &&
  !fromFile &&
  process.env.CI &&
  /^runtime-v\d+\.\d+\.\d+$/.test(process.env.GITHUB_REF_NAME ?? "")
) {
  throw new Error(
    "RUNTIME_SIGNING_PRIVATE_KEY or RUNTIME_SIGNING_PRIVATE_KEY_FILE is required to package tagged runtime releases"
  );
}
const localPem = path.join(root, ".build", "runtime-keys", "runtime-dev.pem");
if (!fromEnv && !fromFile && !fs.existsSync(localPem)) {
  throw new Error("missing Runtime signing key and local development key");
}
const keyPem =
  fromEnv ||
  (fromFile
    ? fs.readFileSync(path.resolve(fromFile), "utf8")
    : fs.readFileSync(localPem, "utf8"));
const signature = sign(null, Buffer.from(descriptorText), createPrivateKey(keyPem));
fs.writeFileSync(path.join(outDir, `${channel}.json.sig`), signature);

console.log(`runtime release staged at ${outDir}`);
console.log(`  ${zipName}`);
console.log(`  ${channel}.json (${descriptor.archiveSha256})`);
