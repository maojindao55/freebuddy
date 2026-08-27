import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packDir = path.join(root, ".build", "runtime-pack");
const keyDir = path.join(root, ".build", "runtime-keys");
fs.mkdirSync(keyDir, { recursive: true });
const { runtimePackSignaturePayload } = await import(
  "../packages/runtime-host/dist/runtimeVerifier.js"
);

const privPath = path.join(keyDir, "runtime-dev.pem");
const pubPath = path.join(keyDir, "current.pub");
const legacyPubPath = path.join(keyDir, "runtime-dev.pub");

function loadPrivateKey() {
  const fromEnv = process.env.RUNTIME_SIGNING_PRIVATE_KEY;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.replace(/\\n/g, "\n");
  }
  const fromFile = process.env.RUNTIME_SIGNING_PRIVATE_KEY_FILE;
  if (fromFile && fromFile.trim()) {
    return fs.readFileSync(path.resolve(fromFile));
  }
  if (process.env.CI && /^runtime-v\d+\.\d+\.\d+$/.test(process.env.GITHUB_REF_NAME ?? "")) {
    throw new Error(
      "RUNTIME_SIGNING_PRIVATE_KEY or RUNTIME_SIGNING_PRIVATE_KEY_FILE is required to sign tagged runtime releases"
    );
  }
  if (!fs.existsSync(privPath)) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    fs.writeFileSync(legacyPubPath, publicKey.export({ type: "spki", format: "pem" }));
  }
  return fs.readFileSync(privPath);
}

const privateKey = loadPrivateKey();
const publicKeyPem = createPublicKey(privateKey)
  .export({ type: "spki", format: "pem" })
  .toString();
fs.writeFileSync(pubPath, publicKeyPem);
if (!fs.existsSync(legacyPubPath)) fs.writeFileSync(legacyPubPath, publicKeyPem);

const manifest = fs.readFileSync(path.join(packDir, "manifest.json"));
const checksums = fs.readFileSync(path.join(packDir, "checksums.json"));
const signaturePayload = runtimePackSignaturePayload(manifest, checksums);
const signature = sign(null, signaturePayload, privateKey);
fs.writeFileSync(path.join(packDir, "manifest.sig"), signature);
const ok = verify(null, signaturePayload, publicKeyPem, signature);
if (!ok) throw new Error("failed to sign runtime manifest");
console.log("signed", path.join(packDir, "manifest.sig"));
