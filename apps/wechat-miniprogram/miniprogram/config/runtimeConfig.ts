/**
 * Environment resolution and the safety constraints that bind it.
 *
 * The environment is chosen from `wx.getAccountInfoSync().miniProgram.envVersion`, not from
 * anything the user can type: a release build always resolves to `prod`, and release builds
 * ignore every override. Overrides can only switch between the named table entries, so no
 * QR code, deep link or storage value can point the release build at an arbitrary host.
 */

import { ENVIRONMENTS, type EnvironmentName, type RelayEnvironment } from "./environments";
import { getWechatApi } from "../platform/wechatApiProvider";

export type MiniProgramEnvVersion = "develop" | "trial" | "release";

export type EnvironmentSource = "policy" | "override";

export interface EnvironmentPolicy {
  readonly defaultEnvironment: EnvironmentName;
  readonly allowOverride: boolean;
}

export interface ResolvedEnvironment {
  readonly name: EnvironmentName;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly debugLogging: boolean;
  readonly source: EnvironmentSource;
}

export interface ResolveEnvironmentInput {
  readonly envVersion?: MiniProgramEnvVersion | string | null;
  readonly override?: unknown;
}

export const ENVIRONMENT_NAMES = ["local", "dev", "prod"] as const;

/** Storage slot used by devtools/QA to pin `local` or `dev`. Ignored on release builds. */
export const ENVIRONMENT_OVERRIDE_STORAGE_KEY = "freebuddy.environment.override";

/** Release builds are pinned to prod with overrides disabled; everything else may override. */
const RELEASE_POLICY: EnvironmentPolicy = {
  defaultEnvironment: "prod",
  allowOverride: false
};

const NON_RELEASE_POLICY: EnvironmentPolicy = {
  defaultEnvironment: "dev",
  allowOverride: true
};

/**
 * Field names that must never appear in an environment record. Keeping secrets out of the
 * bundle is a structural property, not a naming convention, so it is asserted at boot.
 */
const SECRET_FIELD_PATTERN = /(secret|token|password|passwd|credential|sessionkey|session_key|privatekey|private_key)/i;

const ENDPOINT_PATTERN = /^(http|https|ws|wss):\/\/([^/?#@\s]+)$/;

export interface ParsedEndpoint {
  readonly protocol: "http" | "https" | "ws" | "wss";
  readonly host: string;
}

/**
 * Base URLs must be `<scheme>://<host>` with no user info, path, query or fragment, so a
 * crafted value cannot smuggle credentials or rewrite the request target.
 */
export function parseEndpoint(url: unknown): ParsedEndpoint {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("endpoint must be a non-empty string");
  }
  const match = ENDPOINT_PATTERN.exec(url.trim());
  if (!match) {
    throw new Error("endpoint must be <scheme>://<host> without user info, path, query or fragment");
  }
  return { protocol: match[1] as ParsedEndpoint["protocol"], host: match[2] };
}

export function isEnvironmentName(value: unknown): value is EnvironmentName {
  return typeof value === "string" && (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

export function policyForEnvVersion(envVersion: MiniProgramEnvVersion | string | null | undefined): EnvironmentPolicy {
  return envVersion === "develop" || envVersion === "trial" ? NON_RELEASE_POLICY : RELEASE_POLICY;
}

function assertNoSecretFields(env: RelayEnvironment): void {
  for (const key of Object.keys(env)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      throw new Error(`environment "${env.name}" must not carry secret-like field "${key}"`);
    }
  }
}

/** Throws when an environment record would weaken transport security or carry secrets. */
export function assertEnvironmentSafe(env: RelayEnvironment): void {
  if (!isEnvironmentName(env.name)) {
    throw new Error(`unknown environment "${String(env.name)}"`);
  }
  assertNoSecretFields(env);

  const http = parseEndpoint(env.httpBaseUrl);
  const ws = parseEndpoint(env.wsBaseUrl);
  if (http.protocol !== "http" && http.protocol !== "https") {
    throw new Error(`environment "${env.name}" httpBaseUrl must use http or https`);
  }
  if (ws.protocol !== "ws" && ws.protocol !== "wss") {
    throw new Error(`environment "${env.name}" wsBaseUrl must use ws or wss`);
  }

  const secure = http.protocol === "https" && ws.protocol === "wss";
  if (!secure && !env.allowInsecureTransport) {
    throw new Error(`environment "${env.name}" must use https/wss or explicitly allow insecure transport`);
  }
  if (env.name === "prod") {
    if (!secure) {
      throw new Error("prod must use https/wss endpoints");
    }
    if (env.allowInsecureTransport) {
      throw new Error("prod must not allow insecure transport");
    }
    if (env.debugLogging) {
      throw new Error("prod must not enable debug logging");
    }
  }
}

export function assertEnvironmentTable(table: Iterable<RelayEnvironment>): void {
  const seen = new Set<string>();
  for (const env of table) {
    if (seen.has(String(env.name))) {
      throw new Error(`duplicate environment "${String(env.name)}"`);
    }
    seen.add(String(env.name));
    assertEnvironmentSafe(env);
  }
}

export function resolveEnvironment(input: ResolveEnvironmentInput = {}): ResolvedEnvironment {
  const policy = policyForEnvVersion(input.envVersion);
  const useOverride = policy.allowOverride && isEnvironmentName(input.override);
  const name = useOverride ? input.override : policy.defaultEnvironment;
  const env = ENVIRONMENTS[name];

  assertEnvironmentSafe(env);

  return {
    name: env.name,
    httpBaseUrl: env.httpBaseUrl,
    wsBaseUrl: env.wsBaseUrl,
    debugLogging: env.debugLogging,
    source: useOverride ? "override" : "policy"
  };
}

let activeEnvironment: ResolvedEnvironment | null = null;

/**
 * Resolves the environment for this launch and memoises it. The override slot is only read
 * when the build policy allows overrides, so release builds never consult storage for it.
 */
export function getActiveEnvironment(): ResolvedEnvironment {
  if (activeEnvironment) {
    return activeEnvironment;
  }
  const api = getWechatApi();
  const envVersion = api.getEnvVersion();
  const policy = policyForEnvVersion(envVersion);
  const override = policy.allowOverride ? api.getStorageSync(ENVIRONMENT_OVERRIDE_STORAGE_KEY) : null;

  activeEnvironment = resolveEnvironment({ envVersion, override });
  return activeEnvironment;
}

export function resetActiveEnvironment(): void {
  activeEnvironment = null;
}
