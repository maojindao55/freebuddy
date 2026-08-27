import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

const {
  runtimePackSignaturePayload,
  verifyRuntimeArtifact,
  verifyRuntimePackFiles,
  sha256
} = await import(
  "../packages/runtime-host/dist/runtimeVerifier.js"
);

function runtimeManifest() {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      bundleId: "dev.freebuddy.runtime",
      version: "1.0.0",
      rpcVersion: 1,
      engine: { node: ">=22.0.0" },
      hostApi: ">=1.0.0 <2.0.0",
      entry: "runtime/index.mjs",
      keyId: "k",
      publishedAt: "2026-08-26T00:00:00.000Z",
      providesCapabilities: [],
      requiresHostCapabilities: []
    })
  );
}

function runtimeChecksums(manifestBytes, entryBytes) {
  return Buffer.from(
    JSON.stringify({
      files: {
        "manifest.json": sha256(manifestBytes),
        "runtime/index.mjs": sha256(entryBytes)
      }
    })
  );
}

test("valid signature verifies", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifestBytes = runtimeManifest();
  const checksumBytes = runtimeChecksums(manifestBytes, Buffer.from("entry"));
  const archiveBytes = Buffer.from("archive");
  const signature = sign(
    null,
    runtimePackSignaturePayload(manifestBytes, checksumBytes),
    privateKey
  );
  const result = verifyRuntimeArtifact({
    manifestBytes,
    checksumBytes,
    signature,
    publicKey,
    archiveSha256: sha256(archiveBytes),
    archiveBytes,
    expectedBundleId: "dev.freebuddy.runtime",
    hostApiVersion: "1.0.0"
  });
  assert.equal(result.ok, true);
});

test("modified archive is rejected", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifestBytes = runtimeManifest();
  const checksumBytes = runtimeChecksums(manifestBytes, Buffer.from("entry"));
  const archiveBytes = Buffer.from("archive");
  const signature = sign(
    null,
    runtimePackSignaturePayload(manifestBytes, checksumBytes),
    privateKey
  );
  const result = verifyRuntimeArtifact({
    manifestBytes,
    checksumBytes,
    signature,
    publicKey,
    archiveSha256: sha256(archiveBytes),
    archiveBytes: Buffer.from("tampered"),
    expectedBundleId: "dev.freebuddy.runtime",
    hostApiVersion: "1.0.0"
  });
  assert.equal(result.ok, false);
});

test("rewriting runtime bytes and checksums cannot preserve a valid pack signature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifestBytes = runtimeManifest();
  const originalEntry = Buffer.from("export const trusted = true;\n");
  const originalChecksums = runtimeChecksums(manifestBytes, originalEntry);
  const signature = sign(
    null,
    runtimePackSignaturePayload(manifestBytes, originalChecksums),
    privateKey
  );
  const tamperedEntry = Buffer.from("export const trusted = false;\n");
  const rewrittenChecksums = runtimeChecksums(manifestBytes, tamperedEntry);
  const result = verifyRuntimePackFiles({
    files: {
      "manifest.json": manifestBytes,
      "manifest.sig": signature,
      "checksums.json": rewrittenChecksums,
      "runtime/index.mjs": tamperedEntry
    },
    publicKey,
    expectedBundleId: "dev.freebuddy.runtime",
    hostApiVersion: "1.0.0"
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid signature/);
});

test("sanitized runtime env drops secrets and debug flags", async () => {
  const { sanitizedRuntimeProcessEnv } = await import(
    "../packages/runtime-host/dist/runtimeProcessEnv.js"
  );
  const env = sanitizedRuntimeProcessEnv("1.0.0", {
    PATH: "/bin",
    HOME: "/home/user",
    GITHUB_TOKEN: "secret",
    NPM_TOKEN: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    API_KEY: "secret",
    NODE_OPTIONS: "--require ./evil.js",
    DEBUG: "1",
    FB_RUNTIME_DEBUG: "1"
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.FB_RUNTIME_VERSION, "1.0.0");
  assert.equal(env.FB_RUNTIME_PROCESS, "1");
  assert.equal(env.FB_RUNTIME_DEBUG, "1");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.DEBUG, undefined);
});
