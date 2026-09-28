/**
 * M4 formal-auth cross-end integration: WeChat mini program ⇄ real Go Relay ⇄ fake WeChat.
 *
 * Every other auth test in this directory substitutes one end. `auth-client` / `auth-session`
 * drive the production auth client against a scripted `WechatApi`; `relay-integration` drives the
 * production transport against a real Relay but only with the Relay's DEV operator token. Neither
 * shows that a real `wx.login` code, exchanged by the real Relay handler calling a real
 * `code2Session` HTTP endpoint, yields a server-issued credential that then authenticates the real
 * admin WebSocket.
 *
 * This file closes that gap and nothing else. It assembles the production path end to end:
 *
 *   createAppSession (real auth session + real transport)
 *     -> wx.login code -> POST /v1/auth/wechat      (real Relay HTTP handler)
 *     -> Relay's auth.Service -> auth.WeChatClient -> fake code2Session on loopback
 *     -> Relay's SQLite session store (hashes only)
 *     -> the issued access token -> /v1/ws/admin admin.auth (real Relay WebSocket handler)
 *     -> real read-only RPC (`host.status`) through the real Relay
 *
 * and it exercises the credential lifecycle: non-admin rejection, refresh rotation with replay
 * revocation, and logout revoking the session while the Relay drops the live admin socket.
 *
 * Scope of the substitution (all on the mini program side, none on the Relay):
 * - the Relay runs on a loopback DEV harness, which is the only external seam the frozen Relay
 *   offers for a fake `code2Session` (config.LoadFromEnv pins `WECHAT_API_BASE_URL` to the
 *   official HTTPS endpoint when `DEV_AUTH_MODE=false`) and the only mode in which a stand-in
 *   host may connect. The mini program still takes the **formal token path**: it uses the token
 *   the Relay issued, never the DEV operator token.
 * - the code2Session upstream, and the desktop host that answers `host.status`, are stand-ins.
 *   The Relay handler, auth service, token/session store, WebSocket transport and the mini
 *   program's auth client/session/token store are all production code.
 *
 * Secrets: `WECHAT_APP_ID` / `WECHAT_APP_SECRET` / `ADMIN_OPENID` / `TOKEN_HASH_PEPPER` and the
 * DEV tokens are crypto-random, generated in this process, passed to the Relay child only through
 * its environment block, and asserted absent from the Relay's output, its SQLite file and the mini
 * program's own non-credential state. No token value is ever printed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { resetHostTargetRegistry } from "../miniprogram/config/hostTarget";
import type { ResolvedEnvironment } from "../miniprogram/config/runtimeConfig";
import { parseHttpBody } from "../miniprogram/protocol/index";
import type { HostStatus } from "../miniprogram/protocol/remote.generated";
import { createAppSession, type AppSession } from "../miniprogram/services/appSession";
import { createOperatorTokenSession, resetOperatorTokenSession } from "../miniprogram/services/adminSession";
import { AUTH_SESSION_STORAGE_KEY, type AuthSessionRecord } from "../miniprogram/services/tokenStore";
import { resetAdminStores } from "../miniprogram/stores/adminStores";

import { startFakeCode2Session, type FakeCode2Session } from "./helpers/fakeCode2Session";
import { connectFakeHost, type FakeRelayHost } from "./helpers/fakeRelayHost";
import { snapshotPayload } from "./helpers/fakeTransport";
import { createRealWechatApi, postJson, type RealWechatApi } from "./helpers/realWechatApi";
import { cleanupRelayBuild, startRelay, type RelayInstance } from "./helpers/relayProcess";
import { waitFor } from "./helpers/wait";

const CLIENT_VERSION = "0.0.0-auth-e2e";
const ADMIN_CODE = "code_admin_e2e";
const NON_ADMIN_CODE = "code_non_admin_e2e";
const HOST_DISPLAY_NAME = "M4 formal-auth host";

function hasGoToolchain(): boolean {
  try {
    return spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const SKIP = hasGoToolchain() ? false : "the go toolchain is not on PATH; the Relay is built from services/remote-relay";

interface Secrets {
  readonly appId: string;
  readonly appSecret: string;
  readonly adminOpenId: string;
  readonly pepper: string;
}

function randomSecrets(): Secrets {
  return {
    appId: `wx${randomBytes(8).toString("hex")}`,
    appSecret: randomBytes(24).toString("base64url"),
    adminOpenId: `openid_admin_${randomBytes(8).toString("hex")}`,
    pepper: randomBytes(24).toString("base64url")
  };
}

function wsBaseUrlOf(relay: RelayInstance): string {
  return `ws://${new URL(relay.httpBaseUrl).host}`;
}

/**
 * The environment is injected as a value, not read from `config/environments.ts`: the table has
 * no free-form endpoint (by design), so it cannot carry this run's random loopback port. The
 * production policy is untouched — `prod` still resolves to fixed https/wss and `createAuthClient`
 * still refuses a plaintext base URL under `prod` (covered by `runtime-config`/`auth-client`).
 */
function injectedEnvironment(relay: RelayInstance): ResolvedEnvironment {
  return {
    name: "local",
    httpBaseUrl: relay.httpBaseUrl,
    wsBaseUrl: wsBaseUrlOf(relay),
    debugLogging: true,
    source: "policy"
  };
}

interface Harness {
  readonly relay: RelayInstance;
  readonly wechat: FakeCode2Session;
  readonly api: RealWechatApi;
  readonly session: AppSession;
  readonly host: FakeRelayHost | null;
  readonly secrets: Secrets;
  dispose(): Promise<void>;
}

async function createHarness(options: { readonly withHost: boolean }): Promise<Harness> {
  // App-scoped stores, host target and credential session are process-wide singletons.
  resetAdminStores();
  resetHostTargetRegistry();
  resetOperatorTokenSession();

  const secrets = randomSecrets();
  const wechat = await startFakeCode2Session({
    appId: secrets.appId,
    appSecret: secrets.appSecret,
    outcomes: {
      [ADMIN_CODE]: { openid: secrets.adminOpenId },
      [NON_ADMIN_CODE]: { openid: `openid_other_${randomBytes(6).toString("hex")}` }
    }
  });

  let relay: RelayInstance | null = null;
  let host: FakeRelayHost | null = null;
  let session: AppSession | null = null;
  try {
    relay = await startRelay({
      extraEnv: {
        WECHAT_API_BASE_URL: wechat.baseUrl,
        WECHAT_APP_ID: secrets.appId,
        WECHAT_APP_SECRET: secrets.appSecret,
        ADMIN_OPENID: secrets.adminOpenId,
        TOKEN_HASH_PEPPER: secrets.pepper
      }
    });
    host = options.withHost
      ? await connectFakeHost({
          hostSocketUrl: relay.hostSocketUrl,
          hostToken: relay.hostToken,
          hostId: relay.hostId
        })
      : null;

    const api = createRealWechatApi({
      loginCode: () => ADMIN_CODE,
      envVersion: "develop",
      clientVersion: CLIENT_VERSION
    });
    const runningRelay = relay;
    const runningHost = host;
    session = createAppSession({
      api,
      environment: injectedEnvironment(runningRelay),
      clientVersion: CLIENT_VERSION,
      // An isolated in-memory DEV credential: this test never arms it, so the only credential in
      // force is the one the Relay issues.
      devTokenSession: createOperatorTokenSession()
    });
    const runningSession = session;
    const runningWechat = wechat;
    return {
      relay: runningRelay,
      wechat: runningWechat,
      api,
      session: runningSession,
      host: runningHost,
      secrets,
      async dispose() {
        runningSession.dispose();
        await runningHost?.close().catch(() => undefined);
        await runningRelay.stop();
        await runningWechat.close();
      }
    };
  } catch (error) {
    session?.dispose();
    await host?.close().catch(() => undefined);
    await relay?.stop().catch(() => undefined);
    await wechat.close();
    throw error;
  }
}

function storedRecord(api: RealWechatApi): AuthSessionRecord | undefined {
  return api.storage.get(AUTH_SESSION_STORAGE_KEY) as AuthSessionRecord | undefined;
}

function framesOfType(frames: readonly string[], type: string): Record<string, unknown>[] {
  return frames
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === type);
}

function hostStatus(hostId: string, displayName: string): HostStatus {
  return {
    hostId,
    displayName,
    online: true,
    appVersion: "0.9.10",
    protocolVersion: 1,
    remoteEnabled: true,
    activeRunCount: 0,
    pendingDecisionCount: 0,
    activeTerminalCount: 0,
    serverTime: new Date().toISOString()
  };
}

/** Fails loudly without echoing the secret: only the label and the fact of presence are printed. */
function assertAbsent(haystack: string, needles: ReadonlyArray<{ readonly label: string; readonly value: string }>): void {
  for (const { label, value } of needles) {
    assert.ok(value.length > 0, `${label} fixture must be non-empty`);
    assert.ok(!haystack.includes(value), `${label} must not appear here`);
  }
}

/** The Relay's SQLite file(s), read while it is still running, for the "nothing on disk" check. */
function relayStorageBytes(relay: RelayInstance): string {
  try {
    return readdirSync(relay.tempDir)
      .filter((name) => name.startsWith("relay.sqlite"))
      .map((name) => readFileSync(join(relay.tempDir, name)).toString("latin1"))
      .join("\n");
  } catch {
    return "";
  }
}

describe("M4 formal-auth cross-end: WX login -> real Relay -> real admin WS", () => {
  after(() => {
    cleanupRelayBuild();
  });

  test(
    "wx.login is exchanged by the real handler, and the issued access token authenticates /v1/ws/admin",
    { skip: SKIP, timeout: 120_000 },
    async () => {
      const h = await createHarness({ withHost: true });
      try {
        const { relay, session, api, host, secrets } = h;
        const fakeHost = host;
        assert.ok(fakeHost, "the host stand-in must be connected");

        // The injected environment is the only substitution; the production base URL comes from it.
        assert.equal(session.auth.httpBaseUrl, relay.httpBaseUrl);

        const outcome = await session.auth.loginWithWeChat();
        assert.equal(outcome.ok, true, `wechat login failed: ${outcome.kind ?? "?"} ${outcome.message}`);

        const state = session.auth.getState();
        assert.equal(state.mode, "wechat", "the credential in force must be the WeChat session");
        assert.equal(state.status, "signedIn");
        assert.equal(state.hasCredential, true);
        assert.equal(state.accessExpired, false);
        assert.equal(state.refreshExpired, false);

        // The Relay exchanged the scripted code using the configured AppID/AppSecret.
        const probes = h.wechat.requests();
        assert.equal(probes.length, 1, "exactly one code2Session call per login");
        assert.equal(probes[0].jsCode, ADMIN_CODE);
        assert.equal(probes[0].appIdMatched, true);
        assert.equal(probes[0].secretMatched, true);

        // Only the server-issued pair is persisted; no AppSecret, OpenID or login code reaches the client.
        const record = storedRecord(api);
        assert.ok(record, "the WeChat session must be persisted");
        assert.equal(typeof record?.accessToken, "string");
        assert.equal(typeof record?.refreshToken, "string");
        const clientState = JSON.stringify([...api.storage.entries()]);
        assertAbsent(clientState, [
          { label: "AppSecret", value: secrets.appSecret },
          { label: "ADMIN_OPENID", value: secrets.adminOpenId },
          { label: "TOKEN_HASH_PEPPER", value: secrets.pepper },
          { label: "the wx.login code", value: ADMIN_CODE }
        ]);

        /* ---- the formal token authenticates the real admin WebSocket ---------------- */
        session.connection.connect("M4 formal auth");
        await waitFor(
          () => (session.connection.getSnapshot().status === "online" ? true : null),
          15_000,
          "the admin socket to authenticate with the WeChat-issued token"
        );
        assert.equal(api.socketUrls.length, 1, "one App session owns exactly one socket");
        assert.equal(api.socketUrls[0], `${wsBaseUrlOf(relay)}/v1/ws/admin`);
        assert.equal(session.connection.getSnapshot().violations, 0);

        const adminAuth = framesOfType(api.sentFrames, "admin.auth");
        assert.equal(adminAuth.length, 1);
        const presented = (adminAuth[0].payload as { accessToken?: string }).accessToken;
        assert.equal(typeof presented, "string");
        assert.equal(presented === record?.accessToken, true, "the WeChat access token must be the credential on the wire");
        assert.equal(presented === relay.adminToken, false, "the DEV operator token must NOT be used");

        /* ---- a real read-only RPC through the real Relay --------------------------- */
        session.connection.setHostId(relay.hostId);
        const snapshotRequests = await fakeHost.waitForRequests("sync.snapshot", 1, 5_000);
        fakeHost.respondOk(snapshotRequests[0].requestId, snapshotPayload(relay.hostId, 1));

        const pendingStatus = session.connection.reads.hostStatus();
        const statusRequests = await fakeHost.waitForRequests("host.status", 1, 5_000);
        assert.equal(statusRequests[0].hostId, relay.hostId);
        fakeHost.respondOk(statusRequests[0].requestId, hostStatus(relay.hostId, HOST_DISPLAY_NAME));
        const result = await pendingStatus;
        assert.equal(result.ok, true, "host.status must succeed on the formal-auth connection");
        assert.equal(result.ok === true && result.value.displayName, HOST_DISPLAY_NAME);
        assert.equal(result.ok === true && result.value.hostId, relay.hostId);
        assert.equal(session.connection.pendingCount(), 0);

        /* ---- secrets stay out of the Relay's output and its SQLite file ------------ */
        assertAbsent(relay.logs(), [
          { label: "AppSecret", value: secrets.appSecret },
          { label: "ADMIN_OPENID", value: secrets.adminOpenId },
          { label: "TOKEN_HASH_PEPPER", value: secrets.pepper },
          { label: "the access token", value: record?.accessToken ?? "" },
          { label: "the refresh token", value: record?.refreshToken ?? "" },
          { label: "the wx.login code", value: ADMIN_CODE }
        ]);
        assertAbsent(relayStorageBytes(relay), [
          { label: "AppSecret", value: secrets.appSecret },
          { label: "the access token", value: record?.accessToken ?? "" },
          { label: "the refresh token", value: record?.refreshToken ?? "" }
        ]);
      } finally {
        await h.dispose();
      }
    }
  );

  test(
    "a non-admin WeChat account is rejected with forbidden and leaves no credential",
    { skip: SKIP, timeout: 120_000 },
    async () => {
      const h = await createHarness({ withHost: false });
      try {
        const { relay, session, api } = h;
        api.setLoginCode(() => NON_ADMIN_CODE);

        const outcome = await session.auth.loginWithWeChat();
        assert.equal(outcome.ok, false);
        assert.equal(outcome.kind, "non_admin", "a non-admin must be terminal, not retried as a network error");
        assert.equal(outcome.message.length > 0, true);

        const state = session.auth.getState();
        assert.equal(state.status, "rejected");
        assert.equal(state.mode, "none");
        assert.equal(state.hasCredential, false);
        assert.equal(api.storage.has(AUTH_SESSION_STORAGE_KEY), false, "a refused login must not leave a session");
        assert.equal(api.socketUrls.length, 0, "no socket is opened without a credential");

        const probes = h.wechat.requests();
        assert.equal(probes.length, 1);
        assert.equal(probes[0].appIdMatched, true);
        assert.equal(probes[0].secretMatched, true);

        assertAbsent(relay.logs(), [
          { label: "AppSecret", value: h.secrets.appSecret },
          { label: "ADMIN_OPENID", value: h.secrets.adminOpenId },
          { label: "the wx.login code", value: NON_ADMIN_CODE }
        ]);
      } finally {
        await h.dispose();
      }
    }
  );

  test(
    "refresh rotates both tokens, replaying the old refresh token revokes the family, and the client drops the session",
    { skip: SKIP, timeout: 120_000 },
    async () => {
      const h = await createHarness({ withHost: false });
      try {
        const { relay, session, api } = h;
        const login = await session.auth.loginWithWeChat();
        assert.equal(login.ok, true, `wechat login failed: ${login.message}`);
        const first = storedRecord(api);
        assert.ok(first, "the first pair must be persisted");

        const rotated = await session.auth.refreshNow();
        assert.equal(rotated, true, "refresh must rotate the pair");
        const second = storedRecord(api);
        assert.ok(second, "the rotated pair must be persisted atomically");
        assert.equal(second.accessToken === first.accessToken, false, "the access token must rotate");
        assert.equal(second.refreshToken === first.refreshToken, false, "the refresh token must rotate");

        // Replay the *old* refresh token directly against the Relay: it is one-time, so this is a
        // replay and the Relay revokes the whole token family.
        const replay = await postJson(`${relay.httpBaseUrl}/v1/auth/refresh`, { refreshToken: first.refreshToken });
        assert.equal(replay.statusCode, 401);
        const replayError = parseHttpBody("HttpError", replay.data);
        assert.equal(replayError.ok, true);
        assert.equal(replayError.ok === true && replayError.value.code, "unauthorized");

        // Family revocation means the rotated refresh token no longer works either.
        const replayedFamily = await postJson(`${relay.httpBaseUrl}/v1/auth/refresh`, {
          refreshToken: second.refreshToken
        });
        assert.equal(replayedFamily.statusCode, 401, "replay must revoke the rotated token too");

        // The client does not retry blindly: an unauthorized refresh clears the session.
        const afterReplay = await session.auth.refreshNow();
        assert.equal(afterReplay, false);
        assert.equal(session.auth.getState().status, "expired");
        assert.equal(session.auth.getState().hasCredential, false);
        assert.equal(api.storage.has(AUTH_SESSION_STORAGE_KEY), false, "a rejected session must be cleared locally");

        assertAbsent(relay.logs(), [
          { label: "the first access token", value: first.accessToken },
          { label: "the first refresh token", value: first.refreshToken },
          { label: "the rotated access token", value: second.accessToken },
          { label: "the rotated refresh token", value: second.refreshToken },
          { label: "AppSecret", value: h.secrets.appSecret }
        ]);
      } finally {
        await h.dispose();
      }
    }
  );

  test(
    "logout revokes the session and the Relay closes the live admin socket, with no reconnect",
    { skip: SKIP, timeout: 120_000 },
    async () => {
      const h = await createHarness({ withHost: false });
      try {
        const { relay, session, api } = h;
        const login = await session.auth.loginWithWeChat();
        assert.equal(login.ok, true, `wechat login failed: ${login.message}`);
        const record = storedRecord(api);
        assert.ok(record, "the pair must be persisted before logout");

        const statuses: string[] = [];
        const unsubscribe = session.connection.subscribe((snapshot) => statuses.push(snapshot.status));

        session.connection.connect("M4 logout test");
        await waitFor(
          () => (session.connection.getSnapshot().status === "online" ? true : null),
          15_000,
          "the admin socket to come online before logout"
        );

        const logout = await session.auth.logout();
        assert.equal(logout.localCleared, true);
        assert.equal(logout.revoked, "ok", "the Relay must accept the logout");
        assert.equal(session.auth.getState().hasCredential, false);
        assert.equal(api.storage.has(AUTH_SESSION_STORAGE_KEY), false, "logout must clear the local session");

        // The Relay closes the admin connection on revocation, so the client leaves "online" well
        // within one heartbeat period instead of after a heartbeat timeout.
        await waitFor(
          () => (session.connection.getSnapshot().status !== "online" ? true : null),
          3_000,
          "the Relay to drop the live admin socket on logout"
        );
        await waitFor(
          () => (session.connection.getSnapshot().status === "signedOut" ? true : null),
          8_000,
          "the socket to settle signedOut with no credential"
        );
        assert.ok(statuses.includes("online"), "the socket must actually have been online");
        assert.equal(api.socketUrls.length, 1, "a signed-out client must not open another socket");

        // The refresh token is dead as well: logout revokes the whole family.
        const afterLogout = await postJson(`${relay.httpBaseUrl}/v1/auth/refresh`, {
          refreshToken: record.refreshToken
        });
        assert.equal(afterLogout.statusCode, 401);
        unsubscribe();

        assertAbsent(relay.logs(), [
          { label: "the access token", value: record.accessToken },
          { label: "the refresh token", value: record.refreshToken },
          { label: "AppSecret", value: h.secrets.appSecret }
        ]);
      } finally {
        await h.dispose();
      }
    }
  );
});
