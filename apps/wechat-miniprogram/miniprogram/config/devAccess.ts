/**
 * Local-only DEV access gate.
 *
 * The Relay does not implement `POST /v1/auth/wechat`: there is no `code2Session` exchange and
 * no server-side admin session yet, so *no WeChat-derived admin credential exists*. For this
 * read-only substage the only usable credential is the Relay's operator-supplied DEV token
 * (`DEV_AUTH_ADMIN_TOKEN`), which Relay compares to its own config value.
 *
 * Therefore this gate exists to make the compromise explicit and narrow:
 *
 * - only inside the `local` named environment, never `dev` or `prod`;
 * - only when both endpoints resolve to a *literal* loopback address;
 * - only for `develop`/`trial` builds; a `release` build never evaluates these paths;
 * - only after the operator explicitly arms the local panel during this session;
 * - the token itself lives in memory only (see `services/adminSession.ts`): it is never written
 *   to WeChat storage, never logged, never echoed into UI state and never committed.
 *
 * A successful DEV connection is **not** a WeChat identity: the client must never describe it
 * as an administrator login, and the Relay's static admin id carries no user identity.
 */

import { parseEndpoint } from "./runtimeConfig";
import type { EnvironmentName } from "./environments";
import type { MiniProgramEnvVersion } from "../platform/wechatApi";

/** Literal loopback only: no hostnames, no LAN addresses, no proxies, no tunnel services. */
const LITERAL_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "::1"]);

/**
 * `parseEndpoint` keeps the port inside the host (`127.0.0.1:8080`), so comparing raw hosts
 * would reject the loopback endpoints the `local` environment actually uses. Only the port is
 * removed — the address itself must still be a *literal* loopback address, never a hostname
 * such as `localhost` and never a LAN address.
 */
function withoutPort(host: string): string {
  if (host.startsWith("[")) {
    const closing = host.indexOf("]");
    return closing === -1 ? host : host.slice(0, closing + 1);
  }
  const lastColon = host.lastIndexOf(":");
  return lastColon === -1 ? host : host.slice(0, lastColon);
}

export type DevAccessBlockedReason =
  | "release_build"
  | "not_local_environment"
  | "non_loopback_endpoint"
  | "not_armed";

export type DevAccessAvailability =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DevAccessBlockedReason; readonly message: string };

export interface DevAccessInput {
  readonly envName: EnvironmentName;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly envVersion: MiniProgramEnvVersion;
  /** Operator explicitly opened the local DEV panel this session. Never persisted. */
  readonly armed: boolean;
}

const BLOCKED_MESSAGES: Readonly<Record<DevAccessBlockedReason, string>> = {
  release_build: "正式版不允许本地 DEV 直连入口。",
  not_local_environment: "DEV 直连只在 local 环境开放，且必须指向本机回路地址。",
  non_loopback_endpoint: "端点必须是字面回路地址（127.0.0.1 / [::1]），不接受主机名或局域网地址。",
  not_armed: "请先明确开启本地 DEV 入口。"
};

export function isLiteralLoopbackEndpoint(baseUrl: string): boolean {
  try {
    const host = parseEndpoint(baseUrl).host;
    return LITERAL_LOOPBACK_HOSTS.has(host) || LITERAL_LOOPBACK_HOSTS.has(withoutPort(host));
  } catch {
    return false;
  }
}

export function evaluateDevAccess(input: DevAccessInput): DevAccessAvailability {
  if (input.envVersion === "release") {
    return { allowed: false, reason: "release_build", message: BLOCKED_MESSAGES.release_build };
  }
  if (input.envName !== "local") {
    return { allowed: false, reason: "not_local_environment", message: BLOCKED_MESSAGES.not_local_environment };
  }
  if (!isLiteralLoopbackEndpoint(input.httpBaseUrl) || !isLiteralLoopbackEndpoint(input.wsBaseUrl)) {
    return { allowed: false, reason: "non_loopback_endpoint", message: BLOCKED_MESSAGES.non_loopback_endpoint };
  }
  if (!input.armed) {
    return { allowed: false, reason: "not_armed", message: BLOCKED_MESSAGES.not_armed };
  }
  return { allowed: true };
}

/**
 * Human-readable statement of why real WeChat login is unavailable. Rendered on the home page
 * so nobody mistakes a DEV connection for an administrator session.
 */
export const WECHAT_AUTH_LIMITATION =
  "服务端尚未提供 /v1/auth/wechat：Relay 只暴露 /v1/ws/admin、/v1/ws/host 与健康检查，" +
  "没有 code2Session 交换，因此当前不存在微信派生的管理员凭证。";
