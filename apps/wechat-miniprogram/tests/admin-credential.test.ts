/**
 * Transport credential-seam tests.
 *
 * The socket must not know where a credential came from — but it must (a) put exactly that
 * credential on the wire and (b) hand a refusal back to its owner once, so a rotation can happen
 * before a reconnect. These tests drive `createAdminConnection` with an injected credential, the
 * same seam `services/appSession.ts` uses to connect a WeChat session to the read-only transport.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createHostTargetRegistry } from "../miniprogram/config/hostTarget";
import { createAdminConnection, type AdminCredential } from "../miniprogram/services/adminConnection";
import { createOperatorTokenSession } from "../miniprogram/services/adminSession";
import type { RemoteErrorCode } from "../miniprogram/protocol/remote.generated";
import {
  ISOTIME,
  adminAuthOkFrame,
  createManualScheduler,
  createSocketHub,
  createTestIdFactory,
  errorFrame,
  sentFrames,
  type SocketHub
} from "./helpers/fakeTransport";

const URL = "ws://127.0.0.1:8080/v1/ws/admin";

interface Harness {
  readonly connection: ReturnType<typeof createAdminConnection>;
  readonly hub: SocketHub;
  readonly rejections: Array<RemoteErrorCode | null>;
  setToken(token: string | null): void;
  setRecovery(recovered: boolean): void;
}

function harness(): Harness {
  const hub = createSocketHub();
  const scheduler = createManualScheduler();
  const rejections: Array<RemoteErrorCode | null> = [];
  let token: string | null = "credential-one";
  let recovered = false;

  const credential: AdminCredential = {
    getAccessToken: () => token,
    handleAuthRejected(code) {
      rejections.push(code);
      return Promise.resolve(recovered);
    },
    clear() {
      token = null;
    }
  };

  const connection = createAdminConnection({
    adminSocketUrl: URL,
    clientVersion: "0.9.10",
    createSocket: (url) => hub.createSocket(url),
    scheduler,
    isoNow: () => ISOTIME,
    nextId: createTestIdFactory(),
    random: () => 0.5,
    tokenSession: createOperatorTokenSession(),
    credential,
    hostTarget: createHostTargetRegistry()
  });

  return {
    connection,
    hub,
    rejections,
    setToken(value) {
      token = value;
    },
    setRecovery(value) {
      recovered = value;
    }
  };
}

function authTokenOf(h: Harness): unknown {
  const frames = sentFrames(h.hub.last());
  const auth = frames.find((frame) => frame.type === "admin.auth");
  return (auth?.payload as { accessToken?: unknown } | undefined)?.accessToken;
}

function goOnline(h: Harness): void {
  h.connection.connect("test");
  h.hub.last().fireOpen();
  h.hub.deliver(adminAuthOkFrame());
}

describe("injected credential", () => {
  test("the socket authenticates with the injected credential", () => {
    const h = harness();
    goOnline(h);
    assert.equal(authTokenOf(h), "credential-one");
    assert.equal(h.connection.hasCredential(), true);
  });

  test("no credential means no socket", () => {
    const h = harness();
    h.setToken(null);
    h.connection.connect("test");
    assert.equal(h.hub.tasks.length, 0);
    assert.equal(h.connection.getSnapshot().status, "signedOut");
    assert.equal(h.connection.hasCredential(), false);
  });

  test("an unauthorized rejection is offered to the credential owner exactly once", async () => {
    const h = harness();
    goOnline(h);
    h.hub.deliver(errorFrame("unauthorized"));

    // Let the recovery promise settle.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(h.rejections, ["unauthorized"]);
    assert.equal(h.hub.tasks.length, 1, "刷新失败时不得重连");
  });

  test("a successful recovery reconnects with the rotated credential", async () => {
    const h = harness();
    goOnline(h);
    h.setToken("credential-two");
    h.setRecovery(true);

    h.hub.deliver(errorFrame("unauthorized"));
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
    }

    assert.equal(h.hub.tasks.length, 2, "刷新成功后必须重连");
    h.hub.last().fireOpen();
    assert.equal(authTokenOf(h), "credential-two", "重连必须使用刷新后的令牌");
  });

  test("forbidden is reported and never triggers a reconnect loop", async () => {
    const h = harness();
    goOnline(h);
    h.setToken("credential-two");
    h.setRecovery(false);

    h.hub.deliver(errorFrame("forbidden"));
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
    }

    assert.deepEqual(h.rejections, ["forbidden"]);
    assert.equal(h.hub.tasks.length, 1, "forbidden 不得自动重连");
    assert.equal(h.connection.getSnapshot().status, "forbidden");
  });

  test("two terminal errors do not stack a second recovery", async () => {
    const h = harness();
    goOnline(h);
    h.setRecovery(false);
    h.hub.deliver(errorFrame("unauthorized"));
    // A second refusal may arrive while the first recovery is still in flight.
    assert.equal(h.connection.getSnapshot().status, "forbidden");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.rejections.length, 1, "同一时间只允许一次恢复尝试");
  });

  test("sign-out clears the credential and leaves nothing reusable", () => {
    const h = harness();
    goOnline(h);
    h.connection.signOut("test");
    assert.equal(h.connection.hasCredential(), false);
    h.connection.connect("after sign out");
    assert.equal(h.hub.tasks.length, 1, "注销后不得用旧凭证重连");
  });
});
