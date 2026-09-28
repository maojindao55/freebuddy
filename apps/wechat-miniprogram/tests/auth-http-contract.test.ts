/**
 * Contract test against the authoritative companion HTTP schema.
 *
 * The mini program does not own the protocol, and a hand-written copy of a regexp or a bound is
 * exactly how a client drifts. So this test reads `protocol/remote/v1/http.schema.json` and
 * `common.schema.json` itself, evaluates a tiny subset of JSON Schema (the keywords those
 * definitions actually use) and asserts two directions:
 *
 * - what the production client *sends* satisfies the schema's request definitions;
 * - what the production client *accepts* agrees with the schema — a body the schema rejects must
 *   not be accepted by the generated binding, and one it admits must be.
 *
 * The subset validator is intentionally minimal: it exists to prove parity on these definitions,
 * not to be a general JSON Schema engine (the relay and protocol packages own that role).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { REMOTE_ERROR_CODES, parseHttpBody } from "../miniprogram/protocol/index";
import { resolveEnvironment, type ResolvedEnvironment } from "../miniprogram/config/runtimeConfig";
import { createAuthClient } from "../miniprogram/services/authClient";
import { PROTOCOL_DIR } from "./helpers/paths";
import { AUTH_PATHS, authResponse, createFakeAuthApi, tokenPair } from "./helpers/fakeAuthApi";

type Json = unknown;
type Schema = Record<string, Json>;

const COMMON_URL = "https://freebuddy.dev/protocol/remote/v1/common.schema.json";

function readJson(path: string): Schema {
  return JSON.parse(readFileSync(join(PROTOCOL_DIR, path), "utf8")) as Schema;
}

const COMMON = readJson("common.schema.json");
const HTTP = readJson("http.schema.json");
const ERRORS = readJson("errors.json") as { errors: ReadonlyArray<{ code: string }> };

interface ValidationResult {
  readonly valid: boolean;
  readonly reason: string;
}

function defOf(url: string, pointer: string): Schema {
  const target = url === COMMON_URL ? COMMON : HTTP;
  assert.equal(typeof target.$id, "string");
  const parts = pointer.replace(/^#\//, "").split("/");
  let node: Json = target;
  for (const part of parts) {
    assert.ok(node !== null && typeof node === "object", `无法解析 ${url}#/${parts.join("/")}`);
    node = (node as Record<string, Json>)[part];
  }
  assert.ok(node !== null && typeof node === "object", `无法解析 ${url}#/${parts.join("/")}`);
  return node as Schema;
}

/** Minimal evaluator for the keywords used by the auth/completion definitions. */
function validate(schema: Schema, value: Json, path = "#"): ValidationResult {
  const fail = (reason: string): ValidationResult => ({ valid: false, reason: `${path} ${reason}` });

  if (typeof schema.$ref === "string") {
    const [url, pointer] = schema.$ref.split("#");
    return validate(defOf(url, `#${pointer}`), value, path);
  }

  if (schema.const !== undefined && value !== schema.const) {
    return fail(`必须等于 ${String(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !(schema.enum as Json[]).includes(value)) {
    return fail(`必须属于枚举 ${JSON.stringify(schema.enum)}`);
  }

  if (schema.type !== undefined) {
    const expected = schema.type as string;
    const matches =
      expected === "integer"
        ? typeof value === "number" && Number.isInteger(value)
        : expected === "object"
          ? value !== null && typeof value === "object" && !Array.isArray(value)
          : expected === "boolean"
            ? typeof value === "boolean"
            : expected === "string"
              ? typeof value === "string"
              : expected === "number"
                ? typeof value === "number"
                : false;
    if (!matches) {
      return fail(`类型必须是 ${expected}`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return fail(`长度必须 >= ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return fail(`长度必须 <= ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern as string).test(value)) {
      return fail(`必须匹配 ${String(schema.pattern)}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return fail(`必须 >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return fail(`必须 <= ${schema.maximum}`);
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, Json>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const required of (schema.required ?? []) as string[]) {
      if (!(required in record)) {
        return fail(`缺少必填字段 ${required}`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          return fail(`包含未知字段 ${key}`);
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in record) {
        const result = validate(child, record[key], `${path}.${key}`);
        if (!result.valid) {
          return result;
        }
      }
    }
  }

  return { valid: true, reason: "" };
}

function validateDef(name: string, value: Json): ValidationResult {
  const defs = HTTP.$defs as Record<string, Schema>;
  assert.ok(defs[name], `http.schema.json 缺少 $defs.${name}`);
  return validate(defs[name], value);
}

describe("schema shape", () => {
  test("the auth definitions we consume are closed and required as documented", () => {
    const defs = HTTP.$defs as Record<string, Record<string, Json>>;
    for (const name of [
      "WeChatAuthRequest",
      "WeChatAuthResponse",
      "RefreshRequest",
      "RefreshResponse",
      "LogoutRequest",
      "HttpError"
    ]) {
      assert.ok(defs[name], `http.schema.json 缺少 $defs.${name}`);
    }
    assert.deepEqual(defs.WeChatAuthRequest.required, ["code", "clientVersion"]);
    assert.deepEqual(defs.WeChatAuthResponse.required, [
      "accessToken",
      "refreshToken",
      "expiresIn",
      "refreshExpiresIn"
    ]);
    assert.deepEqual(defs.RefreshRequest.required, ["refreshToken"]);
    assert.equal(defs.LogoutRequest.additionalProperties, false);
    assert.equal(defs.WeChatAuthRequest.additionalProperties, false);
    assert.equal(defs.WeChatAuthResponse.additionalProperties, false);
  });

  test("the error catalogue is one enum, agreed by schema, catalogue and binding", () => {
    const commonDefs = COMMON.$defs as Record<string, Record<string, Json>>;
    const enumCodes = commonDefs.ErrorCode.enum as string[];
    const catalogue = ERRORS.errors.map((entry) => entry.code);
    assert.deepEqual([...enumCodes].sort(), [...catalogue].sort());
    assert.deepEqual([...enumCodes].sort(), [...REMOTE_ERROR_CODES].sort());
  });
});

describe("requests satisfy the schema", () => {
  test("the WeChat auth body the client sends is schema-valid", async () => {
    const api = createFakeAuthApi();
    const auth = createAuthClient({ api, environment: env("dev") });
    api.route(AUTH_PATHS.wechat, { statusCode: 200, data: authResponse("one") });
    await auth.requestWeChatAuth({ code: "login-code", clientVersion: "0.9.10", deviceLabel: "iPhone" });

    const request = api.requests[0];
    const result = validateDef("WeChatAuthRequest", request.data);
    assert.equal(result.valid, true, result.reason);
  });

  test("a request without deviceLabel is still schema-valid", async () => {
    const api = createFakeAuthApi();
    const auth = createAuthClient({ api, environment: env("dev") });
    api.route(AUTH_PATHS.wechat, { statusCode: 200, data: authResponse("one") });
    await auth.requestWeChatAuth({ code: "login-code", clientVersion: "0.9.10" });
    assert.equal(validateDef("WeChatAuthRequest", api.requests[0].data).valid, true);
  });

  test("the refresh and logout bodies are schema-valid", async () => {
    const api = createFakeAuthApi();
    const auth = createAuthClient({ api, environment: env("dev") });
    const refreshToken = tokenPair("rt").refreshToken;
    api.route(AUTH_PATHS.refresh, { statusCode: 200, data: authResponse("rotated") });
    api.route(AUTH_PATHS.logout, { statusCode: 200, data: {} });

    await auth.refresh(refreshToken);
    await auth.logout(tokenPair("at").accessToken);

    assert.equal(validateDef("RefreshRequest", api.requests[0].data).valid, true);
    assert.equal(validateDef("LogoutRequest", api.requests[1].data).valid, true);
  });

  test("every bound the binding enforces is the bound the schema declares", () => {
    const defs = HTTP.$defs as Record<string, Record<string, Record<string, unknown>>>;
    const ok = authResponse("bounds");
    const matrix: ReadonlyArray<readonly [string, unknown, boolean]> = [
      ["token below minLength", { ...ok, accessToken: "a".repeat(31) }, false],
      ["token at minLength", { ...ok, accessToken: "a".repeat(32) }, true],
      ["token at maxLength", { ...ok, accessToken: "a".repeat(512) }, true],
      ["token above maxLength", { ...ok, accessToken: "a".repeat(513) }, false],
      ["token with illegal character", { ...ok, accessToken: `${"a".repeat(31)}!` }, false],
      ["expiresIn below minimum", { ...ok, expiresIn: 59 }, false],
      ["expiresIn at minimum", { ...ok, expiresIn: 60 }, true],
      ["expiresIn above maximum", { ...ok, expiresIn: 86_401 }, false],
      ["refreshExpiresIn below minimum", { ...ok, refreshExpiresIn: 59 }, false],
      ["refreshExpiresIn above maximum", { ...ok, refreshExpiresIn: 7_776_001 }, false],
      ["non-integer expiry", { ...ok, expiresIn: 60.5 }, false],
      ["unknown field", { ...ok, sessionKey: "x" }, false]
    ];

    const responseProps = (defs.WeChatAuthResponse.properties ?? {}) as Record<string, Record<string, unknown>>;
    assert.equal(responseProps.expiresIn.minimum, 60);
    assert.equal(responseProps.expiresIn.maximum, 86_400);
    assert.equal(responseProps.refreshExpiresIn.maximum, 7_776_000);
    for (const [name, value, expected] of matrix) {
      const schemaVerdict = validateDef("WeChatAuthResponse", value).valid;
      const bindingVerdict = parseHttpBody("WeChatAuthResponse", value).ok;
      assert.equal(schemaVerdict, expected, `${name}: schema 判定`);
      assert.equal(bindingVerdict, expected, `${name}: binding 判定`);
    }
  });

  test("the auth paths are the contract's fixed three, not caller input", () => {
    assert.deepEqual(
      Object.values(AUTH_PATHS).sort(),
      ["/v1/auth/refresh", "/v1/auth/wechat", "/v1/sessions/logout"].sort()
    );
  });
});

function env(name: "dev" | "local"): ResolvedEnvironment {
  return resolveEnvironment({ envVersion: "develop", override: name });
}
