/**
 * Explicit host target configuration.
 *
 * `protocol/remote/v1` requires `hostId` on every `rpc.request` and on `rpc.response`,
 * `event`, `snapshot` and `resume`. The Relay offers **no** API to enumerate the hosts bound to
 * an administrator (there is no `/v1/hosts`, and pairing claim is W4+), so the client cannot
 * discover a host id and must not invent a discovery endpoint.
 *
 * Until such an interface exists the operator types the host id explicitly, which matches the
 * DEV operator token of this read-only substage. It is kept in memory for the session only:
 * nothing here is persisted, and nothing here is a secret (it is an identifier, not a
 * credential). When pairing ships the same slot is filled by the claim result.
 */

import type { RemoteId } from "../protocol/remote.generated";

export type HostTargetSource = "none" | "explicit";

export interface HostTargetState {
  readonly hostId: RemoteId | null;
  readonly source: HostTargetSource;
}

/** Server-side interfaces this client would need but that do not exist yet. */
export const MISSING_SERVER_INTERFACES: readonly string[] = [
  "POST /v1/auth/wechat — Relay 未实现管理员登录（无 code2Session 交换）",
  "GET /v1/hosts — Relay 未实现主机列表/发现接口，主机标识无法由服务端下发",
  "GET /v1/pairings — 配对列表尚未落地（W4）"
];

export const HOST_TARGET_LIMITATION =
  "rpc.request 必须携带 hostId，但服务端没有主机发现接口，因此本阶段只能由操作员显式配置 " +
  "hostId，不臆造接口。";

export interface HostTargetRegistry {
  setHostId(hostId: RemoteId | null): HostTargetState;
  getHostId(): RemoteId | null;
  getState(): HostTargetState;
  reset(): void;
}

export function createHostTargetRegistry(): HostTargetRegistry {
  let state: HostTargetState = { hostId: null, source: "none" };

  return {
    setHostId(hostId) {
      if (typeof hostId !== "string" || hostId.length === 0) {
        state = { hostId: null, source: "none" };
        return state;
      }
      state = { hostId, source: "explicit" };
      return state;
    },
    getHostId() {
      return state.hostId;
    },
    getState() {
      return state;
    },
    reset() {
      state = { hostId: null, source: "none" };
    }
  };
}

/** Process-wide registry used by the App session. Tests build isolated registries. */
let registry: HostTargetRegistry | null = null;

export function getHostTargetRegistry(): HostTargetRegistry {
  if (!registry) {
    registry = createHostTargetRegistry();
  }
  return registry;
}

export function resetHostTargetRegistry(): void {
  registry = null;
}
