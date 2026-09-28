/**
 * Local-only DEV access gate.
 *
 * WeChat administrator login is implemented in `services/authSession.ts` and needs no local gate:
 * it is the production path. What does need a gate is the *fallback* used when no WeChat session
 * can be obtained (no Relay deployment, no filed domain, offline device): the Relay's own
 * operator-supplied DEV token (`DEV_AUTH_ADMIN_TOKEN`), which Relay compares to its own config
 * value. That token is not a WeChat identity and must never be reachable in a release build.
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
 * Statement of what real WeChat login still depends on. Rendered alongside the login entry so a
 * successful DEV connection is never mistaken for a WeChat administrator session, and so nobody
 * reads "the client implements login" as "login has been verified end to end".
 */
export const WECHAT_AUTH_NOTICE =
  "微信管理员登录按 protocol/remote/v1 的 POST /v1/auth/wechat 完成，客户端只提交 wx.login 的短时 code，" +
  "身份由 Relay 服务端判定。真实联调还需要 Relay 部署、已备案的 HTTPS/WSS 合法域名与真机验证；" +
  "本构建未包含这些验证，DEV 直连令牌也不是微信身份。";
