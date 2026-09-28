/**
 * Local DEV connection controller.
 *
 * This is a *fallback* path, not the administrator login. WeChat login lives in
 * `services/authSession.ts`; the DEV panel exists for the case where no WeChat session can be
 * obtained (no Relay deployment, no filed legal domain, offline device) and the operator supplies
 * the Relay's own DEV operator token instead.
 *
 * What this controller guarantees, and why it is a controller rather than page code:
 *
 * - The entry is only reachable in the `local` named environment inside a `develop`/`trial` build
 *   (`config/devAccess.ts`). A `release` build has no path to it at all: `visible` is false, the
 *   token setter refuses, and `connect()` never touches the transport.
 * - The endpoint is never operator input. It is read from the resolved environment table
 *   (`ws://127.0.0.1:8080` for `local`), and the same gate re-checks that it is a *literal*
 *   loopback address. There is deliberately no `setEndpoint`.
 * - The token lives in the in-memory `OperatorTokenSession` for the process lifetime only. This
 *   controller never writes WeChat storage, never logs, and never puts the value into the state
 *   it publishes — the UI only ever sees a fixed mask.
 * - `hostId` is operator input because the Relay exposes no host discovery endpoint
 *   (`config/hostTarget.ts`). Nothing here invents one.
 * - `signOut()` drops the credential, the host target, the entity caches and the persisted
 *   cursors, so a later connection cannot reuse any of them.
 *
 * A successful connection is **not** a WeChat identity, and the state carries the notice that
 * says so.
 */

import { WECHAT_AUTH_NOTICE, evaluateDevAccess, type DevAccessBlockedReason } from "../config/devAccess";
import type { EnvironmentName } from "../config/environments";
import type { MiniProgramEnvVersion } from "../platform/wechatApi";
import type { RemoteId } from "../protocol/remote.generated";
import { createStore, type Store } from "../stores/createStore";
import { maskSecret } from "../utils/view";
import type { SetTokenResult } from "./adminSession";

/** `RemoteId` is bounded by the protocol; the same bound is enforced before a frame is built. */
export const MAX_HOST_ID_CHARS = 128;

/** The minimum surface this controller drives. `AdminConnection` satisfies it as-is. */
export interface DevConnectTarget {
  setToken(raw: string | null | undefined): SetTokenResult;
  clearToken(): void;
  hasToken(): boolean;
  setHostId(hostId: RemoteId | null): unknown;
  getHostId(): RemoteId | null;
  connect(reason: string): void;
  signOut(reason: string): void;
}

export interface DevConnectState {
  readonly envName: EnvironmentName;
  readonly envVersion: MiniProgramEnvVersion;
  /** True when the DEV entry may be rendered at all (never in a release build). */
  readonly visible: boolean;
  /** True when the gate fully allows a connection (visible, local, loopback and armed). */
  readonly available: boolean;
  readonly armed: boolean;
  readonly blockReason: DevAccessBlockedReason | null;
  readonly blockMessage: string;
  /** Operator-entered identifier; an identifier, never a credential. */
  readonly hostId: string;
  readonly hasHostId: boolean;
  readonly hasToken: boolean;
  /** Fixed mask when a token is present, `null` otherwise. Never the value. */
  readonly tokenMask: string | null;
  /** Derived from the environment table; not operator input. */
  readonly socketUrl: string;
  readonly notice: string;
}

export interface HostIdResult {
  readonly accepted: boolean;
  readonly hostId: RemoteId | null;
  readonly reason?: string;
}

export interface ConnectResult {
  readonly connected: boolean;
  readonly reason?: string;
}

export interface DevConnectController {
  getState(): DevConnectState;
  subscribe(listener: (state: DevConnectState) => void): () => void;
  arm(): DevConnectState;
  disarm(): DevConnectState;
  setHostId(raw: string): HostIdResult;
  /** Validates and stores the token in memory. Never echoes the value back. */
  setToken(raw: string): SetTokenResult;
  connect(): ConnectResult;
  /** Clears credential, host target, caches and cursors: nothing survives it. */
  signOut(): void;
  /** True when the DEV entry may be rendered at all. */
  isVisible(): boolean;
  /** The notice that must be rendered so a DEV session is never mistaken for WeChat login. */
  readonly notice: string;
}

export interface DevConnectOptions {
  readonly target: DevConnectTarget;
  readonly envName: EnvironmentName;
  readonly envVersion: MiniProgramEnvVersion;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export const DEV_CONNECTION_NOTICE =
  "当前为本地 DEV 直连：使用的是 Relay 的 DEV 操作令牌，不是微信管理员登录，也不代表真实管理员身份。" +
  "断开后令牌、主机标识与本地缓存全部清空。" +
  WECHAT_AUTH_NOTICE;

export function createDevConnectController(options: DevConnectOptions): DevConnectController {
  const { target } = options;
  const store: Store<DevConnectState> =
    createStore<DevConnectState>({
      envName: options.envName,
      envVersion: options.envVersion,
      visible: visibilityOf(options.envVersion, options.envName),
      available: false,
      armed: false,
      blockReason: null,
      blockMessage: "",
      hostId: "",
      hasHostId: false,
      hasToken: target.hasToken(),
      tokenMask: target.hasToken() ? maskSecret() : null,
      socketUrl: `${options.wsBaseUrl}/v1/ws/admin`,
      notice: DEV_CONNECTION_NOTICE
    });

  let armed = false;

  // The first read is already derived from the gate: a release build must not need a mutation
  // before it reports why the DEV entry is unavailable.
  publish();

  function visibilityOf(envVersion: MiniProgramEnvVersion, envName: EnvironmentName): boolean {
    // A release build never renders the entry, and neither does a non-local environment.
    return envVersion !== "release" && envName === "local";
  }

  function availability(): { readonly available: boolean; readonly reason: DevAccessBlockedReason | null; readonly message: string } {
    const evaluated = evaluateDevAccess({
      envName: options.envName,
      httpBaseUrl: options.httpBaseUrl,
      wsBaseUrl: options.wsBaseUrl,
      envVersion: options.envVersion,
      armed
    });
    if (evaluated.allowed) {
      return { available: true, reason: null, message: "" };
    }
    return { available: false, reason: evaluated.reason, message: evaluated.message };
  }

  /** Single writer: every published state is derived, so it can never disagree with the gate. */
  function publish(hostIdOverride?: string): DevConnectState {
    const availabilityNow = availability();
    const rawHostId = hostIdOverride ?? store.getState().hostId;
    const hasToken = target.hasToken();
    const next: DevConnectState = {
      ...store.getState(),
      visible: visibilityOf(options.envVersion, options.envName),
      available: availabilityNow.available,
      armed,
      blockReason: availabilityNow.reason,
      blockMessage: availabilityNow.message,
      hostId: rawHostId,
      hasHostId: rawHostId.length > 0,
      hasToken,
      tokenMask: hasToken ? maskSecret() : null,
      socketUrl: `${options.wsBaseUrl}/v1/ws/admin`
    };
    store.setState(() => next);
    return next;
  }

  function blockedSetToken(message: string): SetTokenResult {
    // The gate, not the page, decides whether a credential may even be entered. Nothing is
    // stored when it is refused, so a release build cannot accumulate token material.
    return { accepted: false, length: 0, reason: message };
  }

  return {
    getState() {
      return store.getState();
    },

    subscribe(listener) {
      return store.subscribe(listener);
    },

    arm() {
      armed = true;
      return publish();
    },

    disarm() {
      armed = false;
      return publish();
    },

    setHostId(raw) {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (value.length === 0) {
        target.setHostId(null);
        publish("");
        return { accepted: false, hostId: null, reason: "请填写主机 ID" };
      }
      if (value.length > MAX_HOST_ID_CHARS) {
        target.setHostId(null);
        publish("");
        return { accepted: false, hostId: null, reason: `主机 ID 过长（≤${MAX_HOST_ID_CHARS}）` };
      }
      target.setHostId(value);
      publish(value);
      return { accepted: true, hostId: value };
    },

    setToken(raw) {
      const availabilityNow = availability();
      if (!availabilityNow.available) {
        return blockedSetToken(availabilityNow.message);
      }
      const result = target.setToken(raw);
      publish();
      return result;
    },

    connect() {
      const availabilityNow = availability();
      if (!availabilityNow.available) {
        return { connected: false, reason: availabilityNow.message };
      }
      const hostId = store.getState().hostId;
      if (hostId.length === 0) {
        // `rpc.request` must carry a hostId and the Relay has no discovery API: refusing here is
        // the honest behaviour, not a silently dropped request.
        return { connected: false, reason: "请先填写主机 ID：服务端没有主机发现接口" };
      }
      if (!target.hasToken()) {
        return { connected: false, reason: "请先填写 DEV 操作令牌" };
      }
      target.setHostId(hostId);
      target.connect("DEV 本地直连");
      publish();
      return { connected: true };
    },

    signOut() {
      // Isolation first: the credential goes away with the caches it authorised.
      target.signOut("DEV 操作员已退出");
      target.setHostId(null);
      armed = false;
      publish("");
    },

    isVisible() {
      return visibilityOf(options.envVersion, options.envName);
    },

    notice: DEV_CONNECTION_NOTICE
  };
}
