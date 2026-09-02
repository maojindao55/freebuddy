import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";

import {
  REMOTE_FRAME_TYPES,
  REMOTE_METHODS,
  READ_REMOTE_METHODS,
  WRITE_REMOTE_METHODS,
  REMOTE_METHOD_SPECS,
  REMOTE_EVENT_NAMES,
  REMOTE_ERROR_CODES,
  FORBIDDEN_REMOTE_METHODS,
  MAX_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  HTTP_BODY_KINDS,
  HTTP_SCHEMA_ID,
  PAIRING_TTL_MS,
  PAIRING_SECRET_MIN_BYTES,
  buildHostAuthCanonicalPayload,
  buildPairingStartCanonicalPayload,
  buildPairingQrPayload,
  parsePairingQrPayload,
  parseHttpBody,
  parsePairingStartRequest,
  parsePairingClaimRequest,
  getMethodSpec,
  isForbiddenMethod,
  isRemoteMethod,
  isWriteMethod,
  parseRemoteFrame,
  exceedsChunkLimit,
  exceedsFrameLimit,
  utf8ByteLength
} from "../dist/remote.js";

function v1Url(rel) {
  return new URL(`../../../protocol/remote/v1/${rel}`, import.meta.url);
}

function loadV1Json(rel) {
  return JSON.parse(readFileSync(fileURLToPath(v1Url(rel)), "utf8"));
}

const manifest = loadV1Json("fixtures/manifest.json");

function valuesEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => valuesEqual(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && valuesEqual(a[key], b[key]))
    );
  }
  return false;
}

function classifyWriteReplayResponse(originalResult, replayRequestId, response) {
  const payload = response.payload;
  if (payload.requestId !== replayRequestId) return "invalid";
  if (payload.ok === true) {
    return valuesEqual(payload.result, originalResult) ? "original_result" : "re_execute";
  }
  if (payload.ok === false) {
    const error = payload.error;
    if (error?.code === "duplicate_request" && error.retryable === false) return "duplicate_request";
  }
  return "invalid";
}

const schemaManifest = loadV1Json("schema-manifest.json");
const registry = loadV1Json("methods/registry.json");
const errorCatalog = loadV1Json("errors.json");

const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: false
});
for (const rel of schemaManifest.schemas) {
  ajv.addSchema(loadV1Json(rel));
}
const validateEnvelope = ajv.compile({ $ref: schemaManifest.envelopeId });

function utf8(text) {
  return Buffer.from(text, "utf8");
}

test("every v1 frame type has at least one valid fixture", () => {
  const types = new Set();
  for (const file of manifest.valid) {
    const frame = loadV1Json(`fixtures/valid/${file}`);
    types.add(frame.type);
  }
  for (const type of REMOTE_FRAME_TYPES) {
    assert.ok(types.has(type), `missing valid fixture for ${type}`);
  }
  assert.deepEqual([...manifest.requiredFrameTypes].sort(), [...REMOTE_FRAME_TYPES].sort());
});

test("valid fixtures schema-validate, parse, and stay under the frame size limit", () => {
  for (const file of manifest.valid) {
    const frame = loadV1Json(`fixtures/valid/${file}`);
    const encoded = JSON.stringify(frame);
    assert.ok(
      Buffer.byteLength(encoded, "utf8") <= MAX_FRAME_BYTES,
      `${file} exceeds max frame bytes`
    );
    assert.equal(
      validateEnvelope(frame),
      true,
      `${file} failed schema: ${JSON.stringify(validateEnvelope.errors, null, 2)}`
    );
    const parsed = parseRemoteFrame(frame);
    assert.equal(parsed.ok, true, `${file} failed parse: ${JSON.stringify(parsed)}`);
  }
});

test("invalid fixtures fail the declared reject path", () => {
  for (const file of manifest.invalid) {
    const item = loadV1Json(`fixtures/invalid/${file}`);
    const schemaOk = validateEnvelope(item.frame);
    const parsed = parseRemoteFrame(item.frame);
    if (item.reject === "runtime") {
      assert.equal(schemaOk, true, `${file} should remain schema-valid`);
      assert.equal(parsed.ok, true, `${file} should remain parseable`);
      continue;
    }
    if (item.reject === "schema") {
      assert.equal(schemaOk, false, `${file} should fail schema`);
    }
    if (item.reject === "parse") {
      assert.equal(parsed.ok, false, `${file} should fail parse`);
    }
    if (!schemaOk || !parsed.ok) continue;
    assert.fail(`${file} was expected to fail ${item.reject}`);
  }
});

test("method registry matches TypeScript specs and schema defs", () => {
  assert.deepEqual(
    registry.methods.map((entry) => entry.method),
    [...REMOTE_METHODS]
  );
  assert.deepEqual(schemaManifest.forbiddenMethods, [...FORBIDDEN_REMOTE_METHODS]);

  for (const entry of registry.methods) {
    assert.equal(isRemoteMethod(entry.method), true, entry.method);
    const spec = getMethodSpec(entry.method);
    assert.equal(spec.kind, entry.kind);
    assert.equal(spec.timeoutMs, entry.timeoutMs);
    assert.equal(spec.autoRetry, entry.autoRetry);
    assert.equal(spec.idempotencyRequired, entry.idempotencyRequired);
    assert.equal(spec.expiresAtRequired, entry.expiresAtRequired);
    assert.deepEqual([...spec.events], entry.events);
    assert.equal(isWriteMethod(spec.method), entry.kind === "write");

    const schema = loadV1Json(entry.schema);
    assert.ok(schema.$defs[`${entry.method}.params`], `${entry.method}.params missing`);
    assert.ok(schema.$defs[`${entry.method}.result`], `${entry.method}.result missing`);
  }
});

test("event names, error codes, and method maps stay aligned with schema catalogs", () => {
  const common = loadV1Json("common.schema.json");
  assert.deepEqual(common.$defs.EventName.enum, [...REMOTE_EVENT_NAMES]);
  assert.deepEqual(common.$defs.ErrorCode.enum, [...REMOTE_ERROR_CODES]);
  assert.deepEqual(common.$defs.FrameType.enum, [...REMOTE_FRAME_TYPES]);
  assert.deepEqual(common.$defs.ReadMethodName.enum, [...READ_REMOTE_METHODS]);
  assert.deepEqual(common.$defs.WriteMethodName.enum, [...WRITE_REMOTE_METHODS]);
  assert.deepEqual(
    errorCatalog.errors.map((entry) => entry.code),
    [...REMOTE_ERROR_CODES]
  );
  assert.equal(Object.keys(REMOTE_METHOD_SPECS).length, REMOTE_METHODS.length);
});

test("forbidden generic IPC and shell methods are rejected", () => {
  for (const method of FORBIDDEN_REMOTE_METHODS) {
    assert.equal(isForbiddenMethod(method), true);
    assert.equal(isRemoteMethod(method), false);
    const parsed = parseRemoteFrame({
      v: 1,
      type: "rpc.request",
      id: "msg_forbidden",
      hostId: "host_fixture_001",
      sentAt: "2026-09-01T10:00:00.000Z",
      expiresAt: "2026-09-01T10:00:30.000Z",
      idempotencyKey: "idem_fixture_aaaaaaaaaaaaaaaa",
      payload: { method, params: {} }
    });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.error.code, "method_not_allowed");
  }
});

test("terminal.snapshot is a write method and requires idempotency and expiry", () => {
  const spec = getMethodSpec("terminal.snapshot");
  assert.equal(spec.kind, "write");
  assert.equal(spec.timeoutMs, 30_000);
  assert.equal(spec.autoRetry, false);
  assert.equal(spec.idempotencyRequired, true);
  assert.equal(spec.expiresAtRequired, true);
  assert.equal(isWriteMethod("terminal.snapshot"), true);

  const base = {
    v: 1,
    type: "rpc.request",
    id: "msg_term_snapshot",
    hostId: "host_fixture_001",
    sentAt: "2026-09-01T10:00:00.000Z",
    payload: {
      method: "terminal.snapshot",
      params: { terminalId: "term_fixture_001" }
    }
  };
  const complete = {
    ...base,
    expiresAt: "2026-09-01T10:00:30.000Z",
    idempotencyKey: "idem_fixture_dddddddddddddddd"
  };

  assert.equal(validateEnvelope(complete), true, JSON.stringify(validateEnvelope.errors, null, 2));
  assert.equal(parseRemoteFrame(complete).ok, true);

  assert.equal(validateEnvelope(base), false);
  assert.equal(parseRemoteFrame(base).ok, false);
  assert.equal(
    validateEnvelope({ ...base, expiresAt: complete.expiresAt }),
    false
  );
  assert.equal(
    parseRemoteFrame({ ...base, expiresAt: complete.expiresAt }).ok,
    false
  );
  assert.equal(
    validateEnvelope({ ...base, idempotencyKey: complete.idempotencyKey }),
    false
  );
  assert.equal(
    parseRemoteFrame({ ...base, idempotencyKey: complete.idempotencyKey }).ok,
    false
  );
});

test("write RPC parse requires idempotency and rejects cwd/env/binary", () => {
  const base = {
    v: 1,
    type: "rpc.request",
    id: "msg_write",
    hostId: "host_fixture_001",
    sentAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2026-09-01T10:00:30.000Z",
    payload: {
      method: "terminal.create",
      params: { projectId: "proj_fixture_001", cwd: "/tmp" }
    }
  };
  const missingKey = parseRemoteFrame(base);
  assert.equal(missingKey.ok, false);
  const withCwd = parseRemoteFrame({
    ...base,
    idempotencyKey: "idem_fixture_aaaaaaaaaaaaaaaa"
  });
  assert.equal(withCwd.ok, false);
});

test("runtime write replay goldens freeze original_result or duplicate_request and forbid re-execution", () => {
  assert.deepEqual(manifest.runtime, ["write-idempotency-replay.json"]);
  for (const file of manifest.runtime) {
    const scenario = loadV1Json(`fixtures/runtime/${file}`);
    assert.equal(scenario.scenario, "write_idempotency_replay");
    assert.equal(scenario.mustNotExecuteAgain, true);
    assert.equal(scenario.executeCount, 1);

    const frames = [
      scenario.first.request,
      scenario.first.response,
      scenario.replay.request,
      ...scenario.replay.allowedOutcomes.map((outcome) => outcome.response),
      ...scenario.replay.forbiddenOutcomes.map((outcome) => outcome.response)
    ];
    for (const frame of frames) {
      assert.equal(
        validateEnvelope(frame),
        true,
        `${file} envelope failed schema: ${JSON.stringify(validateEnvelope.errors, null, 2)}`
      );
      const parsed = parseRemoteFrame(frame);
      assert.equal(parsed.ok, true, `${file} envelope failed parse: ${JSON.stringify(parsed)}`);
    }

    const firstRequest = scenario.first.request;
    const replayRequest = scenario.replay.request;
    assert.equal(isWriteMethod(firstRequest.payload.method), true);
    assert.equal(firstRequest.hostId, scenario.scope.hostId);
    assert.equal(firstRequest.payload.method, scenario.scope.method);
    assert.equal(firstRequest.idempotencyKey, scenario.scope.idempotencyKey);
    assert.equal(replayRequest.hostId, firstRequest.hostId);
    assert.equal(replayRequest.payload.method, firstRequest.payload.method);
    assert.equal(replayRequest.idempotencyKey, firstRequest.idempotencyKey);
    assert.deepEqual(replayRequest.payload.params, firstRequest.payload.params);
    assert.notEqual(replayRequest.id, firstRequest.id);

    const originalResult = scenario.first.response.payload.result;
    assert.equal(scenario.first.response.payload.ok, true);
    assert.equal(scenario.first.response.payload.requestId, firstRequest.id);

    const allowedKinds = scenario.replay.allowedOutcomes.map((outcome) => outcome.kind).sort();
    assert.deepEqual(allowedKinds, ["duplicate_request", "original_result"]);
    for (const outcome of scenario.replay.allowedOutcomes) {
      assert.equal(
        classifyWriteReplayResponse(originalResult, replayRequest.id, outcome.response),
        outcome.kind
      );
      assert.equal(outcome.response.payload.requestId, replayRequest.id);
    }

    assert.ok(scenario.replay.forbiddenOutcomes.length >= 1);
    for (const outcome of scenario.replay.forbiddenOutcomes) {
      assert.equal(outcome.kind, "re_execute");
      assert.equal(
        classifyWriteReplayResponse(originalResult, replayRequest.id, outcome.response),
        "re_execute"
      );
      assert.equal(valuesEqual(outcome.response.payload.result, originalResult), false);
    }
  }
});

test("signing docs and goldens use canonicalUtf8 and canonicalHex", () => {
  const canonicalDoc = readFileSync(fileURLToPath(v1Url("signing/canonical.md")), "utf8");
  const pairingDoc = readFileSync(fileURLToPath(v1Url("signing/pairing-start.md")), "utf8");
  const protocolReadme = readFileSync(fileURLToPath(v1Url("README.md")), "utf8");
  for (const text of [canonicalDoc, pairingDoc, protocolReadme]) {
    assert.match(text, /canonicalUtf8/);
    assert.match(text, /canonicalHex/);
  }

  for (const file of ["canonical.json", "pairing-start-canonical.json"]) {
    const canonical = loadV1Json(`fixtures/signing/${file}`);
    assert.equal(typeof canonical.canonicalUtf8, "string");
    assert.equal(typeof canonical.canonicalHex, "string");
    assert.equal(Object.hasOwn(canonical, "utf8"), false);
    assert.equal(Object.hasOwn(canonical, "hex"), false);
    assert.equal(Object.hasOwn(canonical, "canonical.utf8"), false);
    assert.equal(Object.hasOwn(canonical, "canonical.hex"), false);
  }
});

test("Ed25519 canonical payload and golden signatures match Node crypto", () => {
  const canonical = loadV1Json("fixtures/signing/canonical.json");
  const keys = loadV1Json("fixtures/signing/keys.json");
  const built = buildHostAuthCanonicalPayload(canonical);
  assert.equal(built, canonical.canonicalUtf8);
  assert.equal(Buffer.from(built, "utf8").toString("hex"), canonical.canonicalHex);
  assert.equal(Buffer.byteLength(built, "utf8"), canonical.utf8ByteLength);
  assert.match(built, /\n$/);
  assert.equal(built.includes(" "), false);

  const publicKey = createPublicKey({
    key: Buffer.from(keys.publicKeySpkiDerBase64, "base64"),
    format: "der",
    type: "spki"
  });
  const privateKey = createPrivateKey({
    key: Buffer.from(keys.privateKeyPkcs8DerBase64, "base64"),
    format: "der",
    type: "pkcs8"
  });

  const valid = loadV1Json("fixtures/signing/valid-signature.json");
  assert.equal(
    verify(null, utf8(valid.canonicalUtf8), publicKey, Buffer.from(valid.signatureBase64url, "base64url")),
    true
  );
  const resigned = sign(null, utf8(built), privateKey);
  assert.equal(verify(null, utf8(built), publicKey, resigned), true);

  for (const file of ["tampered-hostId.json", "extra-whitespace.json"]) {
    const caseFile = loadV1Json(`fixtures/signing/${file}`);
    assert.equal(caseFile.expect, "verify_fail");
    assert.equal(
      verify(
        null,
        utf8(caseFile.canonicalUtf8),
        publicKey,
        Buffer.from(caseFile.signatureBase64url, "base64url")
      ),
      false
    );
  }
});

test("chunk length limit is 32 KiB", () => {
  assert.equal(MAX_CHUNK_BYTES, 32768);
  const oversize = loadV1Json("fixtures/invalid/oversized-chunk.json");
  assert.equal(validateEnvelope(oversize.frame), false);
  const parsed = parseRemoteFrame(oversize.frame);
  assert.equal(parsed.ok, true, "parseRemoteFrame does not enforce chunk bytes");
  assert.equal(exceedsChunkLimit(oversize.frame.payload.data.item.content), true);
  assert.equal(exceedsChunkLimit("x".repeat(MAX_CHUNK_BYTES)), false);
  assert.equal(utf8ByteLength("你"), 3);
  assert.equal(exceedsFrameLimit("a".repeat(MAX_FRAME_BYTES)), false);
  assert.equal(exceedsFrameLimit("a".repeat(MAX_FRAME_BYTES + 1)), true);
});

const HTTP_SCHEMA_REF_PREFIX = `${HTTP_SCHEMA_ID}#/$defs/`;

function validateHttpDef(def, body) {
  const validate = ajv.compile({ $ref: `${HTTP_SCHEMA_REF_PREFIX}${def}` });
  return validate(body) === true;
}

test("HTTP body kinds match http.schema.json $defs", () => {
  const httpSchema = loadV1Json("http.schema.json");
  assert.deepEqual(Object.keys(httpSchema.$defs).sort(), [...HTTP_BODY_KINDS].sort());
  assert.equal(PAIRING_TTL_MS, 300_000);
  assert.equal(PAIRING_SECRET_MIN_BYTES, 32);
});

test("HTTP valid pairing fixtures schema-validate and parse", () => {
  assert.ok(manifest.httpValid.length >= 4);
  for (const file of manifest.httpValid) {
    const item = loadV1Json(`fixtures/http/valid/${file}`);
    assert.ok(HTTP_BODY_KINDS.includes(item.def), `${file} unknown def`);
    assert.equal(
      validateHttpDef(item.def, item.body),
      true,
      `${file} failed schema`
    );
    const parsed = parseHttpBody(item.def, item.body);
    assert.equal(parsed.ok, true, `${file} failed parse: ${JSON.stringify(parsed)}`);
  }
});

test("HTTP invalid pairing fixtures fail schema and parse", () => {
  assert.ok(manifest.httpInvalid.length >= 8);
  for (const file of manifest.httpInvalid) {
    const item = loadV1Json(`fixtures/http/invalid/${file}`);
    assert.equal(item.reject, "schema");
    assert.equal(
      validateHttpDef(item.def, item.body),
      false,
      `${file} should fail schema`
    );
    const parsed = parseHttpBody(item.def, item.body);
    assert.equal(parsed.ok, false, `${file} should fail parse`);
  }
});

test("pairing claim rejects short codes and requires pairingId plus high-entropy secret", () => {
  assert.equal(parsePairingClaimRequest({ code: "AB12CD34" }).ok, false);
  assert.equal(parsePairingClaimRequest({ pairingId: "pair_fixture_001" }).ok, false);
  assert.equal(
    parsePairingClaimRequest({
      pairingId: "pair_fixture_001",
      secret: "AB12CD34"
    }).ok,
    false
  );
  const valid = loadV1Json("fixtures/http/valid/pairing.claim.request.json");
  assert.equal(parsePairingClaimRequest(valid.body).ok, true);
});

test("pairing start rejects missing hash/proof and plaintext secret", () => {
  const valid = loadV1Json("fixtures/http/valid/pairing.start.request.json");
  const body = valid.body;
  const withoutHash = {
    hostId: body.hostId,
    keyId: body.keyId,
    publicKey: body.publicKey,
    displayName: body.displayName,
    proof: body.proof
  };
  const withoutProof = {
    hostId: body.hostId,
    keyId: body.keyId,
    publicKey: body.publicKey,
    displayName: body.displayName,
    secretHash: body.secretHash
  };
  assert.equal(parsePairingStartRequest(withoutHash).ok, false);
  assert.equal(parsePairingStartRequest(withoutProof).ok, false);
  assert.equal(parsePairingStartRequest({ ...body, secret: "x".repeat(43) }).ok, false);
  assert.equal(parsePairingStartRequest(body).ok, true);
});

test("pairing-start secretHash, canonical payload, and proof match Node crypto", () => {
  const pairing = loadV1Json("fixtures/signing/pairing-start-canonical.json");
  const keys = loadV1Json("fixtures/signing/keys.json");

  const digest = createHash("sha256").update(pairing.secret, "utf8").digest("base64url");
  assert.equal(digest, pairing.secretHash);
  assert.equal(digest.length, 43);
  assert.equal(Buffer.from(pairing.secret, "base64url").byteLength, PAIRING_SECRET_MIN_BYTES);

  const built = buildPairingStartCanonicalPayload(pairing);
  assert.equal(built, pairing.canonicalUtf8);
  assert.equal(Buffer.from(built, "utf8").toString("hex"), pairing.canonicalHex);
  assert.equal(Buffer.byteLength(built, "utf8"), pairing.utf8ByteLength);
  assert.match(built, /\n$/);
  assert.equal(built.startsWith("freebuddy-remote-pairing-start-v1\n"), true);

  const publicKey = createPublicKey({
    key: Buffer.from(keys.publicKeySpkiDerBase64, "base64"),
    format: "der",
    type: "spki"
  });
  const privateKey = createPrivateKey({
    key: Buffer.from(keys.privateKeyPkcs8DerBase64, "base64"),
    format: "der",
    type: "pkcs8"
  });
  assert.equal(verify(null, utf8(built), publicKey, Buffer.from(pairing.proof, "base64url")), true);
  const resigned = sign(null, utf8(built), privateKey);
  assert.equal(verify(null, utf8(built), publicKey, resigned), true);
  assert.equal(
    verify(null, utf8(built.replace("host_fixture_001", "host_tampered_001")), publicKey, Buffer.from(pairing.proof, "base64url")),
    false
  );

  const startFixture = loadV1Json("fixtures/http/valid/pairing.start.request.json");
  assert.equal(startFixture.body.secretHash, pairing.secretHash);
  assert.equal(startFixture.body.proof, pairing.proof);

  const claimFixture = loadV1Json("fixtures/http/valid/pairing.claim.request.json");
  assert.equal(claimFixture.body.secret, pairing.secret);
});

test("pairing QR payload is host-local pairingId plus secret", () => {
  const qr = buildPairingQrPayload("pair_fixture_001", "cGFpcmluZy1zZWNyZXQtZml4dHVyZS1ieXRlcy0zMiE");
  assert.equal(
    qr,
    "freebuddy-remote://pair/v1?pairingId=pair_fixture_001&secret=cGFpcmluZy1zZWNyZXQtZml4dHVyZS1ieXRlcy0zMiE"
  );
  const parsed = parsePairingQrPayload(qr);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.pairingId, "pair_fixture_001");
    assert.equal(parsed.value.secret, "cGFpcmluZy1zZWNyZXQtZml4dHVyZS1ieXRlcy0zMiE");
  }
  assert.equal(parsePairingQrPayload("freebuddy-remote://pair/v1?pairingId=pair_fixture_001").ok, false);
  assert.equal(parsePairingQrPayload("https://evil.example/pair?pairingId=pair_fixture_001&secret=cGFpcmluZy1zZWNyZXQtZml4dHVyZS1ieXRlcy0zMiE").ok, false);
});
