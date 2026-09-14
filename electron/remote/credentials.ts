import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject
} from "node:crypto";
import {
  HOST_AUTH_CANONICAL_PREFIX,
  REMOTE_PROTOCOL_VERSION,
  buildHostAuthCanonicalPayload,
  type HostAuthFrame
} from "@freebuddy/protocol/remote";

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface HostCredentialRecord {
  hostId: string;
  keyId: string;
  publicKey: string;
  encryptedPrivateKey: string;
}

export interface HostCredentialStore {
  load(): HostCredentialRecord | undefined;
  save(record: HostCredentialRecord): void;
}

export class RemoteCredentialsUnavailableError extends Error {
  constructor(message = "OS credential encryption is unavailable") {
    super(message);
    this.name = "RemoteCredentialsUnavailableError";
  }
}

const base64url = (value: Buffer) => value.toString("base64url");

function requireSafeStorage(storage: SafeStoragePort): void {
  if (!storage.isEncryptionAvailable()) throw new RemoteCredentialsUnavailableError();
}

function privateKeyFromPkcs8(value: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(value, "base64"),
    format: "der",
    type: "pkcs8"
  });
}

export function createHostCredentials(
  storage: SafeStoragePort,
  store: HostCredentialStore,
  options: { hostId?: string } = {}
): HostCredentialRecord {
  requireSafeStorage(storage);
  const existing = store.load();
  if (existing) {
    // Decrypt now: a stale keychain entry must stop remote enablement, not fail later.
    decryptPrivateKey(storage, existing);
    return existing;
  }
  const pair = generateKeyPairSync("ed25519");
  const publicKey = base64url(pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  // A local dev Relay may pre-provision its test host ID. The private key is
  // still freshly generated and safeStorage-protected; production never passes
  // this option and keeps a locally generated ID.
  const hostId = options.hostId ?? `host_${base64url(randomBytes(18))}`;
  if (!/^host_[A-Za-z0-9_-]{1,123}$/.test(hostId)) throw new RemoteCredentialsUnavailableError("Development host ID is invalid");
  const keyId = `key_${base64url(createHash("sha256").update(publicKey).digest().subarray(0, 12))}`;
  const record = {
    hostId,
    keyId,
    publicKey,
    encryptedPrivateKey: storage.encryptString(privateKey).toString("base64")
  };
  store.save(record);
  return record;
}

export function decryptPrivateKey(storage: SafeStoragePort, record: HostCredentialRecord): KeyObject {
  requireSafeStorage(storage);
  try {
    return privateKeyFromPkcs8(storage.decryptString(Buffer.from(record.encryptedPrivateKey, "base64")));
  } catch {
    throw new RemoteCredentialsUnavailableError("Stored host credential cannot be decrypted");
  }
}

export function signHostChallenge(
  storage: SafeStoragePort,
  record: HostCredentialRecord,
  challenge: { challenge: string; connectionId: string; issuedAt: string; expiresAt: string },
  now = Date.now()
): HostAuthFrame {
  if (Date.parse(challenge.expiresAt) <= now) throw new RemoteCredentialsUnavailableError("Relay challenge has expired");
  const canonical = buildHostAuthCanonicalPayload({
    hostId: record.hostId,
    challenge: challenge.challenge,
    connectionId: challenge.connectionId,
    issuedAt: challenge.issuedAt
  });
  const signature = base64url(sign(null, Buffer.from(canonical, "utf8"), decryptPrivateKey(storage, record)));
  return {
    v: REMOTE_PROTOCOL_VERSION,
    type: "host.auth",
    id: `msg_${base64url(randomBytes(18))}`,
    hostId: record.hostId,
    sentAt: new Date(now).toISOString(),
    payload: {
      hostId: record.hostId,
      keyId: record.keyId,
      publicKey: record.publicKey,
      signature,
      clientVersion: "0.9.10",
      protocolVersion: REMOTE_PROTOCOL_VERSION
    }
  };
}

export function createHostChallengeResponder(
  storage: SafeStoragePort,
  record: HostCredentialRecord
): (challenge: { challenge: string; connectionId: string; issuedAt: string; expiresAt: string }) => HostAuthFrame {
  return challenge => signHostChallenge(storage, record, challenge);
}

// Keeps the protocol prefix referenced locally so accidental local canonicalization cannot drift silently.
export const hostAuthCanonicalPrefix = HOST_AUTH_CANONICAL_PREFIX;
