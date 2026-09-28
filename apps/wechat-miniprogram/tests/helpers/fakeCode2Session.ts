/**
 * Local fake WeChat `code2Session` endpoint for the M4 formal-auth cross-end test.
 *
 * The Relay's production `auth.WeChatClient` calls `GET {base}/sns/jscode2session`. To exercise
 * the *real* production HTTP handler, the *real* auth service and the *real* session/token store
 * without reaching Tencent, the integration test points the Relay's `WECHAT_API_BASE_URL` at this
 * loopback server. It is a server-side stand-in for WeChat only — it says nothing about the Relay
 * or the mini program, both of which stay production code.
 *
 * It validates `appid`/`secret` against the values the test generated (proving the Relay sent the
 * configured credentials) and maps `js_code` to an OpenID or a WeChat error. It never echoes the
 * secret back, and it never writes anything to disk: the only record is the in-memory probe list,
 * which deliberately keeps non-secret facts (the code and whether the credentials matched).
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type Code2SessionOutcome =
  | { readonly openid: string }
  | { readonly errcode: number; readonly errmsg: string };

export interface FakeCode2SessionOptions {
  readonly appId: string;
  readonly appSecret: string;
  /** `js_code` -> outcome. An unknown code gets WeChat's 40029 "invalid code". */
  readonly outcomes: Readonly<Record<string, Code2SessionOutcome>>;
}

export interface Code2SessionProbe {
  /** The `js_code` the Relay presented. Never logged; asserted in memory only. */
  readonly jsCode: string;
  readonly appIdMatched: boolean;
  readonly secretMatched: boolean;
}

export interface FakeCode2Session {
  readonly baseUrl: string;
  requests(): readonly Code2SessionProbe[];
  close(): Promise<void>;
}

export function startFakeCode2Session(options: FakeCode2SessionOptions): Promise<FakeCode2Session> {
  const probes: Code2SessionProbe[] = [];

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/sns/jscode2session") {
      response.writeHead(404).end();
      return;
    }

    const appIdMatched = url.searchParams.get("appid") === options.appId;
    const secretMatched = url.searchParams.get("secret") === options.appSecret;
    const jsCode = url.searchParams.get("js_code") ?? "";
    probes.push({ jsCode, appIdMatched, secretMatched });

    response.setHeader("Content-Type", "application/json; charset=utf-8");

    if (!appIdMatched || !secretMatched) {
      // WeChat itself answers 200 with a business errcode for bad credentials; mirror that shape.
      response.end(JSON.stringify({ errcode: 40125, errmsg: "invalid appsecret" }));
      return;
    }

    const outcome = options.outcomes[jsCode];
    if (outcome === undefined) {
      response.end(JSON.stringify({ errcode: 40029, errmsg: "invalid code" }));
      return;
    }
    if ("errcode" in outcome) {
      response.end(JSON.stringify({ errcode: outcome.errcode, errmsg: outcome.errmsg }));
      return;
    }
    // `session_key` is intentionally present (as WeChat sends it) but never retained by the Relay.
    response.end(JSON.stringify({ openid: outcome.openid, session_key: "discarded", errcode: 0 }));
  });

  return new Promise<FakeCode2Session>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests: () => [...probes],
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          })
      });
    });
  });
}
