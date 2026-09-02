import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ENVIRONMENTS, type RelayEnvironment } from "../miniprogram/config/environments";
import {
  ENVIRONMENT_OVERRIDE_STORAGE_KEY,
  assertEnvironmentSafe,
  assertEnvironmentTable,
  getActiveEnvironment,
  parseEndpoint,
  policyForEnvVersion,
  resetActiveEnvironment,
  resolveEnvironment
} from "../miniprogram/config/runtimeConfig";
import { resetWechatApi, setWechatApi } from "../miniprogram/platform/wechatApiProvider";
import { createFakeWechatApi } from "./helpers/fakeWechatApi";

function environment(overrides: Partial<RelayEnvironment>): RelayEnvironment {
  return {
    name: "dev",
    httpBaseUrl: "https://relay-dev.example.com",
    wsBaseUrl: "wss://relay-dev.example.com",
    allowInsecureTransport: false,
    debugLogging: false,
    ...overrides
  };
}

describe("environment resolution", () => {
  test("release builds resolve to prod", () => {
    assert.equal(resolveEnvironment({ envVersion: "release" }).name, "prod");
  });

  test("release builds ignore every override", () => {
    const resolved = resolveEnvironment({ envVersion: "release", override: "local" });
    assert.equal(resolved.name, "prod");
    assert.equal(resolved.source, "policy");
  });

  test("unknown or missing env version falls back to the strictest policy", () => {
    assert.equal(resolveEnvironment({}).name, "prod");
    assert.equal(resolveEnvironment({ envVersion: "something-else" }).name, "prod");
  });

  test("develop and trial default to dev", () => {
    assert.equal(resolveEnvironment({ envVersion: "develop" }).name, "dev");
    assert.equal(resolveEnvironment({ envVersion: "trial" }).name, "dev");
  });

  test("non-release builds may pin another named environment", () => {
    const resolved = resolveEnvironment({ envVersion: "develop", override: "local" });
    assert.equal(resolved.name, "local");
    assert.equal(resolved.source, "override");
    assert.equal(resolved.wsBaseUrl, "ws://127.0.0.1:8080");
  });

  test("overrides can only select named environments", () => {
    const resolved = resolveEnvironment({ envVersion: "develop", override: "https://evil.example" });
    assert.equal(resolved.name, "dev");
  });

  test("policies are pinned per build type", () => {
    assert.deepEqual(policyForEnvVersion("release"), {
      defaultEnvironment: "prod",
      allowOverride: false
    });
    assert.deepEqual(policyForEnvVersion("develop"), {
      defaultEnvironment: "dev",
      allowOverride: true
    });
  });
});

describe("environment safety constraints", () => {
  test("the shipped table satisfies every constraint", () => {
    assert.doesNotThrow(() => assertEnvironmentTable(Object.values(ENVIRONMENTS)));
  });

  test("prod must use https and wss", () => {
    assert.throws(
      () => assertEnvironmentSafe(environment({ name: "prod", httpBaseUrl: "http://relay.example.com" })),
      /https\/wss/
    );
    assert.throws(
      () => assertEnvironmentSafe(environment({ name: "prod", wsBaseUrl: "ws://relay.example.com" })),
      /https\/wss/
    );
  });

  test("prod must not allow insecure transport or debug logging", () => {
    assert.throws(
      () => assertEnvironmentSafe(environment({ name: "prod", allowInsecureTransport: true })),
      /insecure/
    );
    assert.throws(
      () => assertEnvironmentSafe(environment({ name: "prod", debugLogging: true })),
      /debug/
    );
  });

  test("secure schemes are mandatory unless insecure transport is explicitly allowed", () => {
    assert.throws(
      () => assertEnvironmentSafe(environment({ httpBaseUrl: "http://relay-dev.example.com" })),
      /https\/wss/
    );
    assert.doesNotThrow(() =>
      assertEnvironmentSafe(environment({ allowInsecureTransport: true, httpBaseUrl: "http://127.0.0.1:8080", wsBaseUrl: "ws://127.0.0.1:8080" }))
    );
  });

  test("endpoints cannot smuggle user info, paths, queries or fragments", () => {
    const attacks = [
      "https://user:pass@relay.example.com",
      "https://relay.example.com/v1",
      "https://relay.example.com?token=abc",
      "https://relay.example.com#frag",
      "https://",
      "javascript:alert(1)",
      "https://relay example.com"
    ];
    for (const url of attacks) {
      assert.throws(() => parseEndpoint(url), /<scheme>:\/\/<host>/, `expected ${url} to be rejected`);
    }
  });

  test("parseEndpoint accepts a bare origin", () => {
    assert.deepEqual(parseEndpoint("https://relay.example.com"), {
      protocol: "https",
      host: "relay.example.com"
    });
    assert.deepEqual(parseEndpoint("wss://relay.example.com"), {
      protocol: "wss",
      host: "relay.example.com"
    });
  });

  test("secret-like fields are refused", () => {
    assert.throws(
      () => assertEnvironmentSafe({ ...environment({}), appSecret: "wx-secret" } as RelayEnvironment),
      /secret-like field/
    );
    assert.throws(
      () => assertEnvironmentSafe({ ...environment({}), accessToken: "t" } as RelayEnvironment),
      /secret-like field/
    );
  });

  test("the shipped table contains no secret-like field or credential", () => {
    const serialized = JSON.stringify(ENVIRONMENTS);
    assert.doesNotMatch(serialized, /secret|token|password|sessionkey/i);
    assert.doesNotMatch(serialized, /:\/\/[^/]*@/);
  });

  test("duplicate or unknown entries are refused", () => {
    assert.throws(
      () => assertEnvironmentTable([ENVIRONMENTS.dev, ENVIRONMENTS.dev]),
      /duplicate/
    );
    assert.throws(
      () => assertEnvironmentSafe({ name: "staging" } as unknown as RelayEnvironment),
      /unknown environment/
    );
  });
});

describe("getActiveEnvironment", () => {
  test("release builds never read the override slot", (t) => {
    t.after(() => {
      resetActiveEnvironment();
      resetWechatApi();
    });

    const api = createFakeWechatApi({ envVersion: "release" });
    setWechatApi(api);

    const resolved = getActiveEnvironment();
    assert.equal(resolved.name, "prod");
    assert.equal(api.calls.includes("getStorageSync"), false);
  });

  test("develop builds honour the override slot and memoise the result", (t) => {
    t.after(() => {
      resetActiveEnvironment();
      resetWechatApi();
    });

    const api = createFakeWechatApi({
      envVersion: "develop",
      storage: { [ENVIRONMENT_OVERRIDE_STORAGE_KEY]: "local" }
    });
    setWechatApi(api);

    const first = getActiveEnvironment();
    const second = getActiveEnvironment();
    assert.equal(first.name, "local");
    assert.equal(first, second, "resolution must be memoised");
    assert.equal(api.calls.filter((call) => call === "getEnvVersion").length, 1);
  });

  test("an unsafe override cannot disable prod constraints", (t) => {
    t.after(() => {
      resetActiveEnvironment();
      resetWechatApi();
    });

    setWechatApi(
      createFakeWechatApi({
        envVersion: "develop",
        storage: { [ENVIRONMENT_OVERRIDE_STORAGE_KEY]: "prod" }
      })
    );

    const resolved = getActiveEnvironment();
    assert.equal(resolved.name, "prod");
    assert.ok(resolved.wsBaseUrl.startsWith("wss://"));
    assert.equal(resolved.debugLogging, false);
  });
});
