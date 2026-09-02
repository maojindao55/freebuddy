/**
 * Contract test: the generated binding must agree with the frozen `protocol/remote/v1`
 * fixtures. The mini program only consumes the protocol; it never redefines it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { PROTOCOL_DIR } from "./helpers/paths";
import {
  HTTP_BODY_KINDS,
  MAX_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  PAIRING_SECRET_MIN_BYTES,
  READ_REMOTE_METHODS,
  assertProtocolBinding,
  buildPairingQrPayload,
  exceedsChunkLimit,
  exceedsFrameLimit,
  getMethodSpec,
  isForbiddenMethod,
  isRemoteMethod,
  isWriteMethod,
  parseHttpBody,
  parsePairingClaimRequest,
  parsePairingQrPayload,
  parsePairingStartRequest,
  parseRemoteFrame,
  utf8ByteLength,
  type HttpBodyKind,
  type PairingClaimRequest,
  type PairingStartRequest
} from "../miniprogram/protocol";

interface FixtureManifest {
  readonly valid: readonly string[];
  readonly invalid: readonly string[];
  readonly httpValid: readonly string[];
  readonly httpInvalid: readonly string[];
  readonly requiredFrameTypes: readonly string[];
}

interface RegistryMethod {
  readonly method: string;
  readonly kind: "read" | "write";
  readonly timeoutMs: number;
  readonly autoRetry: boolean;
  readonly idempotencyRequired: boolean;
  readonly expiresAtRequired: boolean;
  readonly events: readonly string[];
}

interface MethodRegistry {
  readonly methods: readonly RegistryMethod[];
}

interface InvalidFixture {
  readonly reason: string;
  readonly reject: "schema" | "parse" | "runtime" | "signature";
  readonly frame: unknown;
}

/** One-time pairing HTTP fixtures carry the body kind in `def` and the payload in `body`. */
interface HttpFixture {
  readonly def: string;
  readonly body: unknown;
}

function readFixture<T>(segments: readonly string[]): T {
  const path = join(PROTOCOL_DIR, ...segments);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function asHttpBodyKind(def: string): HttpBodyKind {
  assert.ok(
    (HTTP_BODY_KINDS as readonly string[]).includes(def),
    `fixture declares unknown HTTP body kind ${def}`
  );
  return def as HttpBodyKind;
}

function streamTextContent(frame: unknown): string {
  const payload = (frame as { payload?: { data?: { item?: { content?: unknown } } } }).payload;
  const content = payload?.data?.item?.content;
  assert.equal(typeof content, "string", "fixture payload.data.item.content must be a string");
  return content as string;
}

const manifest = readFixture<FixtureManifest>(["fixtures", "manifest.json"]);

describe("protocol binding", () => {
  test("generated binding matches the version this build targets", () => {
    assert.doesNotThrow(() => assertProtocolBinding());
  });

  test("forbidden methods are never routable", () => {
    assert.equal(isForbiddenMethod("ipc.invoke"), true);
    assert.equal(isForbiddenMethod("shell.exec"), true);
    assert.equal(isForbiddenMethod("process.spawn"), true);
    assert.equal(isRemoteMethod("ipc.invoke"), false);
    assert.equal(isRemoteMethod("terminal.create"), true);
  });

  test("method specs follow methods/registry.json, where terminal.snapshot is a write", () => {
    // `terminal.snapshot` was classified as a read method before the protocol owner
    // corrected it. The wire authority decides: read this from registry.json instead of
    // restating the values, so a future regeneration cannot silently drift.
    const registry = readFixture<MethodRegistry>(["methods", "registry.json"]);

    for (const entry of registry.methods) {
      const method = entry.method;
      assert.ok(isRemoteMethod(method), `binding is missing registry method ${method}`);
      const spec = getMethodSpec(method);
      assert.deepEqual(
        {
          kind: spec.kind,
          timeoutMs: spec.timeoutMs,
          autoRetry: spec.autoRetry,
          idempotencyRequired: spec.idempotencyRequired,
          expiresAtRequired: spec.expiresAtRequired,
          events: [...spec.events].sort()
        },
        {
          kind: entry.kind,
          timeoutMs: entry.timeoutMs,
          autoRetry: entry.autoRetry,
          idempotencyRequired: entry.idempotencyRequired,
          expiresAtRequired: entry.expiresAtRequired,
          events: [...entry.events].sort()
        },
        `binding spec drifted from methods/registry.json for ${method}`
      );
    }

    assert.equal(isWriteMethod("terminal.snapshot"), true);
    assert.equal(getMethodSpec("terminal.snapshot").kind, "write");
    assert.equal(getMethodSpec("terminal.snapshot").idempotencyRequired, true);
    assert.equal(getMethodSpec("terminal.snapshot").expiresAtRequired, true);
    assert.equal((READ_REMOTE_METHODS as readonly string[]).includes("terminal.snapshot"), false);
  });

  test("every required frame type has a valid fixture", () => {
    const types = new Set(
      manifest.valid.map((name) => {
        const frame = readFixture<{ type: string }>(["fixtures", "valid", name]);
        return frame.type;
      })
    );
    for (const type of manifest.requiredFrameTypes) {
      assert.ok(types.has(type), `missing valid fixture for frame type ${type}`);
    }
  });

  for (const name of manifest.valid) {
    test(`valid fixture parses: ${name}`, () => {
      const result = parseRemoteFrame(readFixture(["fixtures", "valid", name]));
      assert.equal(result.ok, true, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
    });
  }

  for (const name of manifest.invalid) {
    const fixture = readFixture<InvalidFixture>(["fixtures", "invalid", name]);

    if (fixture.reject === "runtime") {
      test(`runtime-refused fixture is schema-valid, refused by the host: ${name}`, () => {
        // `runtime` rejections (expired writes, duplicate execution) are decided by the host
        // or Relay against live state; the binding must still parse the envelope.
        assert.equal(parseRemoteFrame(fixture.frame).ok, true);
      });
      continue;
    }

    if (name === "oversized-chunk.json") {
      test("oversized chunk is caught by the chunk limit guard, not by parseRemoteFrame", () => {
        // parseRemoteFrame sees an already-parsed object, so byte ceilings are a transport
        // responsibility: W2 must call exceedsFrameLimit(rawFrame) before JSON.parse and
        // exceedsChunkLimit(text) before accepting a chunk.
        assert.equal(parseRemoteFrame(fixture.frame).ok, true);
        const content = streamTextContent(fixture.frame);
        assert.ok(
          utf8ByteLength(content) > MAX_CHUNK_BYTES,
          "fixture chunk must exceed MAX_CHUNK_BYTES"
        );
        assert.equal(exceedsChunkLimit(content), true);
        assert.equal(exceedsChunkLimit("short chunk"), false);

        const raw = JSON.stringify(fixture.frame);
        assert.equal(
          exceedsFrameLimit(raw),
          false,
          "this fixture is a chunk-limit case, not a frame-limit case"
        );
        assert.ok(utf8ByteLength(raw) < MAX_FRAME_BYTES);
        assert.equal(exceedsFrameLimit("x".repeat(MAX_FRAME_BYTES + 1)), true);
      });
      continue;
    }

    test(`invalid fixture is rejected: ${name}`, () => {
      const result = parseRemoteFrame(fixture.frame);
      assert.equal(result.ok, false, `expected ${name} to be rejected`);
      if (!result.ok) {
        assert.ok(result.error.message.length > 0);
        assert.ok(!/"?(token|secret)"?\s*[:=]\s*"/i.test(result.error.message));
      }
    });
  }
});

describe("one-time pairing http bodies", () => {
  for (const name of manifest.httpValid) {
    test(`valid http fixture parses: ${name}`, () => {
      const fixture = readFixture<HttpFixture>(["fixtures", "http", "valid", name]);
      const result = parseHttpBody(asHttpBodyKind(fixture.def), fixture.body);
      assert.equal(result.ok, true, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
    });
  }

  for (const name of manifest.httpInvalid) {
    test(`invalid http fixture is rejected: ${name}`, () => {
      const fixture = readFixture<HttpFixture>(["fixtures", "http", "invalid", name]);
      const result = parseHttpBody(asHttpBodyKind(fixture.def), fixture.body);
      assert.equal(result.ok, false, `expected ${name} to be rejected`);
      if (!result.ok) {
        assert.ok(result.error.message.length > 0);
        assert.ok(!/"?(token|secret)"?\s*[:=]\s*"/i.test(result.error.message));
      }
    });
  }

  test("PairingStart/PairingClaim types agree with the runtime parsers", () => {
    // Typing the fixture bodies as the exported interfaces is the compile-time half of the
    // contract: if the protocol owner renames or drops a field, this file stops compiling.
    const start = readFixture<{ body: PairingStartRequest }>([
      "fixtures",
      "http",
      "valid",
      "pairing.start.request.json"
    ]).body;
    const claim = readFixture<{ body: PairingClaimRequest }>([
      "fixtures",
      "http",
      "valid",
      "pairing.claim.request.json"
    ]).body;

    const startResult = parsePairingStartRequest(start);
    assert.equal(startResult.ok, true, startResult.ok ? "" : startResult.error.message);
    if (startResult.ok) {
      assert.equal(startResult.value.hostId, start.hostId);
      assert.equal(startResult.value.keyId, start.keyId);
      assert.equal(startResult.value.secretHash, start.secretHash);
      assert.equal(startResult.value.proof, start.proof);
      assert.equal(startResult.value.displayName, start.displayName);
    }

    const claimResult = parsePairingClaimRequest(claim);
    assert.equal(claimResult.ok, true, claimResult.ok ? "" : claimResult.error.message);
    if (claimResult.ok) {
      assert.equal(claimResult.value.pairingId, claim.pairingId);
      assert.equal(claimResult.value.secret, claim.secret);
    }
  });

  test("claim secret must be high entropy, never a display code", () => {
    const { secret } = readFixture<{ body: PairingClaimRequest }>([
      "fixtures",
      "http",
      "valid",
      "pairing.claim.request.json"
    ]).body;

    // 32 raw bytes is the protocol floor; base64url needs ceil(32 * 4 / 3) = 43 characters.
    const minSecretChars = Math.ceil((PAIRING_SECRET_MIN_BYTES * 4) / 3);
    assert.equal(PAIRING_SECRET_MIN_BYTES, 32);
    assert.ok(secret.length >= minSecretChars, "fixture secret must meet the entropy floor");

    const highEntropy = "A".repeat(minSecretChars);
    const oneCharShort = "A".repeat(minSecretChars - 1);

    assert.equal(parsePairingClaimRequest({ pairingId: "pair_x", secret: highEntropy }).ok, true);
    assert.equal(parsePairingClaimRequest({ pairingId: "pair_x", secret: oneCharShort }).ok, false);
    // A display code is guessable, so it is never accepted as the pairing credential.
    assert.equal(parsePairingClaimRequest({ pairingId: "pair_x", secret: "AB12CD34" }).ok, false);
  });

  test("pairing QR round-trips and cannot smuggle a Relay endpoint", () => {
    const { pairingId, secret } = readFixture<{ body: PairingClaimRequest }>([
      "fixtures",
      "http",
      "valid",
      "pairing.claim.request.json"
    ]).body;

    const parsed = parsePairingQrPayload(buildPairingQrPayload(pairingId, secret));
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error.message);
    if (parsed.ok) {
      assert.deepEqual(parsed.value, { pairingId, secret });
    }

    // W4 must only send pairingId/secret to the configured Relay: the QR payload is anchored,
    // so an appended endpoint, a foreign scheme or a bare code cannot reach the client.
    assert.equal(
      parsePairingQrPayload(`${buildPairingQrPayload(pairingId, secret)}&relay=https://evil.example`)
        .ok,
      false
    );
    assert.equal(
      parsePairingQrPayload(`https://evil.example/pair?pairingId=${pairingId}&secret=${secret}`).ok,
      false
    );
    assert.equal(parsePairingQrPayload(pairingId).ok, false);
    assert.equal(parsePairingQrPayload(undefined).ok, false);
  });
});
