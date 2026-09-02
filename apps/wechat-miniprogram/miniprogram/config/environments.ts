/**
 * Named Relay environments for the mini program.
 *
 * Rules enforced by `config/runtimeConfig.ts`:
 * - only these three named environments exist; there is no free-form endpoint input;
 * - `prod` must use HTTPS/WSS and must not enable debug logging;
 * - this file holds endpoints and flags only. AppSecret, session keys and tokens never
 *   belong here: AppSecret lives in the Relay, tokens live in the token store (W2).
 */

export type EnvironmentName = "local" | "dev" | "prod";

export interface RelayEnvironment {
  readonly name: EnvironmentName;
  /** Base URL for HTTP endpoints such as `/v1/auth/wechat` (W2). No trailing slash. */
  readonly httpBaseUrl: string;
  /** Base URL for the Relay WebSocket (`wss://` outside local development). */
  readonly wsBaseUrl: string;
  /** Permits `http://` / `ws://`. Only acceptable for the local Relay. */
  readonly allowInsecureTransport: boolean;
  readonly debugLogging: boolean;
}

/**
 * TODO(W8): replace the `dev` and `prod` hosts with the ICP-filed domain configured in the
 * WeChat console before release. `project.config.json` keeps `urlCheck` enabled, so an
 * unregistered host cannot reach the network in the devtools or on a real device.
 */
export const ENVIRONMENTS: Readonly<Record<EnvironmentName, RelayEnvironment>> = {
  local: {
    name: "local",
    httpBaseUrl: "http://127.0.0.1:8080",
    wsBaseUrl: "ws://127.0.0.1:8080",
    allowInsecureTransport: true,
    debugLogging: true
  },
  dev: {
    name: "dev",
    httpBaseUrl: "https://relay-dev.example.com",
    wsBaseUrl: "wss://relay-dev.example.com",
    allowInsecureTransport: false,
    debugLogging: true
  },
  prod: {
    name: "prod",
    httpBaseUrl: "https://relay.example.com",
    wsBaseUrl: "wss://relay.example.com",
    allowInsecureTransport: false,
    debugLogging: false
  }
};
