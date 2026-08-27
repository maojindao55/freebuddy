import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packDir = path.join(root, ".build", "runtime-pack");
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-runtime-probe-"));
const isolatedPack = path.join(probeRoot, "runtime-pack");
const dataDir = path.join(probeRoot, "host-data");

const { createNodeRuntimeProcessLauncher, probeRuntimeVersion } = await import(
  "../packages/runtime-host/dist/index.js"
);

try {
  fs.cpSync(packDir, isolatedPack, { recursive: true });
  const result = await probeRuntimeVersion(
    {
      hostId: "freebuddy-cli",
      hostVersion: "0.0.0-probe",
      hostApiVersion: "1.0.0",
      hostCapabilities: [
        "agent.execute.v1",
        "workflow.repository.v1",
        "delegation.repository.v1",
        "events.publish.v1"
      ],
      dataDir,
      bundledRuntimePath: isolatedPack,
      allowUnsignedDevelopmentRuntime: false,
      launcher: createNodeRuntimeProcessLauncher(),
      http: { fetch },
      trustedKeys: { get: () => undefined, list: () => [] },
      clock: { now: () => new Date(), nowIso: () => new Date().toISOString() }
    },
    "bundled"
  );
  if (!result.ok) throw new Error(result.reason ?? "runtime probe failed");
  console.log("runtime pack probe passed");
} finally {
  fs.rmSync(probeRoot, { recursive: true, force: true });
}
