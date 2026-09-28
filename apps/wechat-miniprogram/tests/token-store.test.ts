/**
 * Token store tests.
 *
 * The store is the only place a server-issued credential is persisted, so these tests are about
 * containment as much as about round-tripping: a malformed, partial or drifted record must not
 * become a session, and a write that the platform refused must be *reported* rather than
 * swallowed (after a refresh rotation the old refresh token is already dead server-side).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AUTH_SESSION_STORAGE_KEY,
  createWechatAuthTokenStore,
  isOpaqueToken,
  recordFromAuthResponse,
  sanitizeAuthSession,
  type AuthSessionRecord
} from "../miniprogram/services/tokenStore";
import { createFakeAuthApi, authResponse, tokenPair } from "./helpers/fakeAuthApi";

const NOW = 1_700_000_000_000;

function record(label = "a"): AuthSessionRecord {
  const pair = tokenPair(label);
  return {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    accessExpiresAtMs: NOW + 3_600_000,
    refreshExpiresAtMs: NOW + 86_400_000
  };
}

describe("opaque token grammar", () => {
  test("agrees with the frozen binding's token pattern at its boundaries", () => {
    assert.equal(isOpaqueToken("a".repeat(32)), true);
    assert.equal(isOpaqueToken("a".repeat(512)), true);
    assert.equal(isOpaqueToken("a".repeat(31)), false, "32 是下界");
    assert.equal(isOpaqueToken("a".repeat(513)), false, "512 是上界");
    assert.equal(isOpaqueToken("has space 0123456789012345678901"), false);
    assert.equal(isOpaqueToken(""), false);
    assert.equal(isOpaqueToken(undefined), false);
    assert.equal(isOpaqueToken(42), false);
  });
});

describe("sanitizeAuthSession", () => {
  test("keeps a fully valid record", () => {
    const input = record();
    assert.deepEqual(sanitizeAuthSession(input), input);
  });

  test("drops anything partial or drifted instead of repairing it", () => {
    const base = record();
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["null", null],
      ["array", [base]],
      ["string", "session"],
      ["missing access", { ...base, accessToken: undefined }],
      ["short access", { ...base, accessToken: "short" }],
      ["missing refresh", { ...base, refreshToken: undefined }],
      ["non-integer expiry", { ...base, accessExpiresAtMs: 1.5 }],
      ["negative expiry", { ...base, accessExpiresAtMs: -1 }],
      ["zero expiry", { ...base, refreshExpiresAtMs: 0 }],
      ["refresh before access", { ...base, refreshExpiresAtMs: base.accessExpiresAtMs - 1 }]
    ];
    for (const [name, value] of cases) {
      assert.equal(sanitizeAuthSession(value), null, `${name} 必须被丢弃`);
    }
  });

  test("unknown fields are ignored rather than trusted", () => {
    const base = record();
    assert.deepEqual(sanitizeAuthSession({ ...base, sessionKey: "leak" }), base);
  });

  test("a sanitized record never carries an unknown field into storage", () => {
    const written = sanitizeAuthSession({ ...record(), sessionKey: "leak", openId: "oX" });
    assert.ok(written !== null);
    assert.deepEqual(Object.keys(written).sort(), [
      "accessExpiresAtMs",
      "accessToken",
      "refreshExpiresAtMs",
      "refreshToken"
    ]);
  });
});

describe("recordFromAuthResponse", () => {
  test("converts the schema's relative seconds into absolute expiries", () => {
    const converted = recordFromAuthResponse(authResponse("rt", 600, 7_200), NOW);
    assert.equal(converted.accessExpiresAtMs, NOW + 600_000);
    assert.equal(converted.refreshExpiresAtMs, NOW + 7_200_000);
    assert.equal(sanitizeAuthSession(converted) !== null, true);
  });
});

describe("wechat-backed token store", () => {
  test("round-trips through the platform store under a versioned key", () => {
    const api = createFakeAuthApi();
    const store = createWechatAuthTokenStore(api);
    assert.equal(store.read(), null, "空存储必须是 null");

    assert.equal(store.write(record()), true);
    assert.deepEqual(store.read(), record());
    assert.ok(api.storage.has(AUTH_SESSION_STORAGE_KEY), "必须写入约定的版本化键");
  });

  test("a refusal to persist is reported, not swallowed", () => {
    const api = createFakeAuthApi();
    const store = createWechatAuthTokenStore(api);
    api.failStorageWrites(true);
    assert.equal(store.write(record()), false);
    assert.equal(store.read(), null);
  });

  test("an invalid record is refused before it reaches storage", () => {
    const api = createFakeAuthApi();
    const store = createWechatAuthTokenStore(api);
    assert.equal(store.write({ ...record(), accessToken: "short" }), false);
    assert.equal(api.storage.size, 0);
  });

  test("clear removes the record and read tolerates an unusable value", () => {
    const api = createFakeAuthApi();
    const store = createWechatAuthTokenStore(api);
    store.write(record());
    store.clear();
    assert.equal(store.read(), null);
    assert.equal(api.storage.has(AUTH_SESSION_STORAGE_KEY), false);

    api.storage.set(AUTH_SESSION_STORAGE_KEY, { accessToken: 1 });
    assert.equal(store.read(), null, "损坏的记录必须视为无会话");
  });

  test("an exploding platform API degrades to no session instead of throwing", () => {
    const store = createWechatAuthTokenStore({
      getStorageSync() {
        throw new Error("boom");
      },
      setStorageSync() {
        throw new Error("boom");
      },
      removeStorageSync() {
        throw new Error("boom");
      }
    });
    assert.equal(store.read(), null);
    assert.equal(store.write(record()), false);
    assert.doesNotThrow(() => store.clear());
  });
});
