import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packDir = path.join(root, ".build", "runtime-pack");
const currentPub = path.join(root, ".build", "runtime-keys", "current.pub");
const legacyPub = path.join(root, ".build", "runtime-keys", "runtime-dev.pub");
const pubPath = fs.existsSync(currentPub) ? currentPub : legacyPub;
const publicKey = fs.readFileSync(pubPath);
const { readRuntimePackDirectory, verifyRuntimePackFiles } = await import(
  "../packages/runtime-host/dist/runtimeVerifier.js"
);
const verified = verifyRuntimePackFiles({
  files: readRuntimePackDirectory(packDir),
  publicKey,
  expectedBundleId: "dev.freebuddy.runtime",
  hostApiVersion: "1.0.0",
  hostCapabilities: [
    "agent.execute.v1",
    "workflow.repository.v1",
    "delegation.repository.v1",
    "events.publish.v1"
  ]
});
if (!verified.ok) throw new Error(`runtime pack verification failed: ${verified.error}`);
console.log("verified runtime pack", verified.manifest.version);
