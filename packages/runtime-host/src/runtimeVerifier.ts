import fs from "node:fs";
import path from "node:path";
import { createHash, verify } from "node:crypto";
import {
  RUNTIME_MANIFEST_SCHEMA_VERSION,
  RUNTIME_RPC_VERSION,
  type RuntimeManifest
} from "@freebuddy/protocol/runtime";
import { hostApiCompatible, hostCapabilitiesSatisfied } from "./hostApiRange.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_CHECKSUM_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const SIGNATURE_DOMAIN = "freebuddy-runtime-pack-signature-v1";

export interface VerifyInput {
  manifestBytes: Buffer;
  checksumBytes: Buffer;
  signature: Buffer;
  publicKey: Buffer | string;
  archiveSha256: string;
  archiveBytes: Buffer;
  expectedBundleId: string;
  hostApiVersion: string;
}

export interface VerifyPackFilesInput {
  files: Record<string, Buffer>;
  publicKey?: Buffer | string;
  allowUnsigned?: boolean;
  expectedBundleId: string;
  hostApiVersion: string;
  hostCapabilities?: readonly string[];
}

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function runtimePackSignaturePayload(
  manifestBytes: Buffer,
  checksumBytes: Buffer
): Buffer {
  const header = Buffer.from(
    `${SIGNATURE_DOMAIN}\n${manifestBytes.byteLength}\n${checksumBytes.byteLength}\n`,
    "utf8"
  );
  return Buffer.concat([header, manifestBytes, checksumBytes]);
}

function isSafePackPath(name: string): boolean {
  if (!name || name.includes("\\") || name.startsWith("/") || path.isAbsolute(name)) {
    return false;
  }
  const normalized = path.posix.normalize(name);
  return normalized === name && normalized !== ".." && !normalized.startsWith("../");
}

export function readRuntimePackDirectory(dir: string): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  const walk = (current: string, prefix: string) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files[rel.replaceAll("\\", "/")] = fs.readFileSync(full);
    }
  };
  walk(dir, "");
  return files;
}

export function verifyRuntimePackFiles(
  input: VerifyPackFilesInput
): { ok: true; manifest: RuntimeManifest } | { ok: false; error: string } {
  const manifestBytes = input.files["manifest.json"];
  const signature = input.files["manifest.sig"];
  const checksumBytes = input.files["checksums.json"];
  if (!manifestBytes) return { ok: false, error: "missing manifest.json" };
  if (!checksumBytes) return { ok: false, error: "missing checksums.json" };
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    return { ok: false, error: "manifest too large" };
  }
  if (checksumBytes.byteLength > MAX_CHECKSUM_BYTES) {
    return { ok: false, error: "checksums too large" };
  }
  if (signature && signature.byteLength > MAX_SIGNATURE_BYTES) {
    return { ok: false, error: "signature too large" };
  }

  if (!signature) {
    if (!input.allowUnsigned) return { ok: false, error: "missing manifest.sig" };
  } else {
    if (!input.publicKey) return { ok: false, error: "unknown pack key" };
    if (
      !verify(
        null,
        runtimePackSignaturePayload(manifestBytes, checksumBytes),
        input.publicKey,
        signature
      )
    ) {
      return { ok: false, error: "invalid signature" };
    }
  }

  let checksums: { files?: Record<string, string> };
  try {
    checksums = JSON.parse(checksumBytes.toString("utf8")) as { files?: Record<string, string> };
  } catch {
    return { ok: false, error: "invalid checksums json" };
  }
  if (!checksums.files || typeof checksums.files !== "object") {
    return { ok: false, error: "missing checksum files" };
  }

  let manifest: RuntimeManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as RuntimeManifest;
  } catch {
    return { ok: false, error: "invalid manifest json" };
  }
  if (manifest.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION) {
    return { ok: false, error: "unsupported manifest schema" };
  }
  if (manifest.rpcVersion !== RUNTIME_RPC_VERSION) {
    return { ok: false, error: "incompatible runtime rpc" };
  }
  if (!isSafePackPath(manifest.entry) || manifest.entry !== "runtime/index.mjs") {
    return { ok: false, error: "invalid runtime entry" };
  }
  if (!input.files[manifest.entry]) {
    return { ok: false, error: `missing ${manifest.entry}` };
  }
  if (!checksums.files["manifest.json"] || !checksums.files[manifest.entry]) {
    return { ok: false, error: "required file missing from checksums" };
  }

  for (const [name, expected] of Object.entries(checksums.files)) {
    if (!isSafePackPath(name)) return { ok: false, error: `illegal checksum path ${name}` };
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      return { ok: false, error: `invalid checksum ${name}` };
    }
    const bytes = input.files[name];
    if (!bytes) return { ok: false, error: `missing checksum file ${name}` };
    if (sha256(bytes) !== expected) return { ok: false, error: `checksum mismatch ${name}` };
  }

  for (const name of Object.keys(input.files)) {
    if (name === "checksums.json" || name === "manifest.sig") continue;
    if (!checksums.files[name]) {
      return { ok: false, error: `unchecked pack file ${name}` };
    }
  }
  if (manifest.bundleId !== input.expectedBundleId) {
    return { ok: false, error: "bundle id mismatch" };
  }
  if (!hostApiCompatible(manifest.hostApi, input.hostApiVersion)) {
    return { ok: false, error: "incompatible host api" };
  }
  const missing = hostCapabilitiesSatisfied(
    manifest.requiresHostCapabilities,
    input.hostCapabilities ?? []
  );
  if (missing.length > 0) {
    return { ok: false, error: `missing host capabilities: ${missing.join(",")}` };
  }
  return { ok: true, manifest };
}

export function verifyRuntimeArtifact(input: VerifyInput): { ok: true } | { ok: false; error: string } {
  if (input.archiveBytes.byteLength > 80 * 1024 * 1024) {
    return { ok: false, error: "archive too large" };
  }
  const archiveHash = sha256(input.archiveBytes);
  if (archiveHash !== input.archiveSha256) {
    return { ok: false, error: "archive hash mismatch" };
  }
  const valid = verify(
    null,
    runtimePackSignaturePayload(input.manifestBytes, input.checksumBytes),
    input.publicKey,
    input.signature
  );
  if (!valid) return { ok: false, error: "invalid signature" };
  let manifest: RuntimeManifest;
  try {
    manifest = JSON.parse(input.manifestBytes.toString("utf8")) as RuntimeManifest;
  } catch {
    return { ok: false, error: "invalid manifest json" };
  }
  if (manifest.bundleId !== input.expectedBundleId) {
    return { ok: false, error: "bundle id mismatch" };
  }
  if (!hostApiCompatible(manifest.hostApi, input.hostApiVersion)) {
    return { ok: false, error: "incompatible host api" };
  }
  return { ok: true };
}
