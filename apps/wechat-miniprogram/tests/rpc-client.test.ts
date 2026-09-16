import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_MAX_PENDING,
  createRpcClient,
  type LateResponseInfo,
  type RpcClient,
  type RpcResult
} from "../miniprogram/services/rpcClient";
import type { RpcRequestFrame } from "../miniprogram/protocol/remote.generated";

import {
  ISOTIME,
  createManualScheduler,
  createTestIdFactory,
  errorFrame,
  requestErrorFrame,
  rpcFailureFrame,
  rpcResponseFrame
} from "./helpers/fakeTransport";

interface Harness {
  client: RpcClient;
  sent: RpcRequestFrame[];
  advance(ms: number): void;
  lateResponses: LateResponseInfo[];
  setSendResult(result: boolean): void;
}

function harness(maxPending?: number): Harness {
  const scheduler = createManualScheduler();
  const sent: RpcRequestFrame[] = [];
  const lateResponses: LateResponseInfo[] = [];
  let sendResult = true;

  const client = createRpcClient({
    send: (frame) => {
      sent.push(frame);
      return sendResult;
    },
    scheduler,
    isoNow: () => ISOTIME,
    nextId: createTestIdFactory(),
    maxPending,
    onLateResponse: (info) => lateResponses.push(info)
  });

  return {
    client,
    sent,
    advance: (ms) => scheduler.advance(ms),
    lateResponses,
    setSendResult(result) {
      sendResult = result;
    }
  };
}

const HOST_ID = "host-1";
const requestId = (h: Harness, index = 0): string => (h.sent[index].id as string);

/** Every write, forbidden or unknown method is refused before it reaches the transport. */
const untyped = (client: RpcClient): ((method: string, hostId: string, params: unknown) => Promise<RpcResult<unknown>>) =>
  client.request as unknown as (method: string, hostId: string, params: unknown) => Promise<RpcResult<unknown>>;

describe("request envelope", () => {
  test("read requests carry method, params, hostId and a server-side expiry", () => {
    const h = harness();
    const promise = h.client.request("message.list", HOST_ID, { conversationId: "conv-1", limit: 20 });
    const frame = h.sent[0];
    assert.equal(frame.type, "rpc.request");
    assert.equal(frame.hostId, HOST_ID);
    assert.deepEqual(frame.payload, { method: "message.list", params: { conversationId: "conv-1", limit: 20 } });
    assert.equal(frame.expiresAt, "2026-09-14T10:00:15.000Z");
    assert.equal(frame.seq, undefined, "requests are not correlated by seq");

    h.client.settle(JSON.parse(rpcResponseFrame(HOST_ID, frame.id, { items: [] })), HOST_ID);
    return promise.then((result) => assert.equal(result.ok, true));
  });

  test("the expiry honours the method's read timeout", () => {
    const h = harness();
    h.client.request("host.status", HOST_ID, {});
    assert.equal(h.sent[0].expiresAt, "2026-09-14T10:00:15.000Z");
  });

  test("write methods are refused before reaching the transport", async () => {
    const h = harness();
    for (const method of ["conversation.send", "run.stop", "permission.respond", "terminal.input"]) {
      const result = await untyped(h.client)(method, HOST_ID, {});
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.error.code, "method_not_allowed");
    }
    assert.equal(h.sent.length, 0, "no forbidden method is ever framed");
  });

  test("generic shell/filesystem/ipc style methods are refused too", async () => {
    const h = harness();
    for (const method of ["shell.exec", "fs.read", "ipc.invoke", "totally.unknown"]) {
      const result = await untyped(h.client)(method, HOST_ID, { cwd: "/tmp" });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.error.code, "method_not_allowed");
    }
    assert.equal(h.sent.length, 0);
  });

  test("an unconfigured host cannot be targeted", async () => {
    const h = harness();
    const result = await h.client.request("host.status", "", {});
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "invalid_request");
    assert.equal(h.sent.length, 0);
  });
});

describe("correlation", () => {
  test("responses settle by request id, not by arrival order", async () => {
    const h = harness();
    const first = h.client.request("host.status", HOST_ID, {});
    const second = h.client.request("host.status", HOST_ID, {});
    const firstId = requestId(h, 0);
    const secondId = requestId(h, 1);

    h.client.settle(JSON.parse(rpcFailureFrame(HOST_ID, secondId, "host_offline")), HOST_ID);
    h.client.settle(JSON.parse(rpcResponseFrame(HOST_ID, firstId, { online: true })), HOST_ID);

    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    assert.deepEqual(firstResult.ok ? firstResult.value : null, { online: true });

    const secondResult = await second;
    assert.equal(secondResult.ok, false);
    assert.equal(secondResult.ok === false && secondResult.error.code, "host_offline");
    assert.equal(h.client.pendingCount(), 0);
  });

  test("a response from another host never settles anything", async () => {
    const h = harness();
    const pending = h.client.request("host.status", HOST_ID, {});
    assert.equal(h.client.settle(JSON.parse(rpcResponseFrame("host-2", requestId(h), {})), HOST_ID), false);
    assert.equal(h.client.pendingCount(), 1);

    h.client.settle(JSON.parse(rpcResponseFrame(HOST_ID, requestId(h), { online: true })), HOST_ID);
    assert.equal((await pending).ok, true);
  });

  test("a response without a request id is rejected", () => {
    const h = harness();
    h.client.request("host.status", HOST_ID, {});
    assert.equal(h.client.settle({ payload: { ok: true } } as never, HOST_ID), false);
    assert.equal(h.client.pendingCount(), 1);
  });

  test("a timeout frees the slot and makes the late response inert", async () => {
    const h = harness();
    const promise = h.client.request("host.status", HOST_ID, {});
    h.advance(15_000);

    const timedOut = await promise;
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.ok === false && timedOut.error.code, "rpc_timeout");
    assert.equal(h.client.pendingCount(), 0);

    // The answer finally arrives: it counts as late and must not reach the store.
    assert.equal(h.client.settle(JSON.parse(rpcResponseFrame(HOST_ID, requestId(h), { online: true })), HOST_ID), false);
    assert.equal(h.lateResponses.length, 1);
    assert.equal(h.lateResponses[0].requestId, requestId(h));
  });

  test("the pending map is bounded", async () => {
    const h = harness(2);
    const first = h.client.request("host.status", HOST_ID, {});
    h.client.request("host.status", HOST_ID, {});
    const third = await h.client.request("host.status", HOST_ID, {});
    assert.equal(third.ok, false);
    assert.equal(third.ok === false && third.error.code, "backpressure");
    assert.equal(h.client.pendingCount(), 2);
    assert.equal(DEFAULT_MAX_PENDING, 32);

    h.client.rejectAll({ code: "internal_error", message: "cleanup", retryable: false });
    assert.equal((await first).ok, false);
  });

  test("a refused send has no side effect and is reported as such", async () => {
    const h = harness();
    h.setSendResult(false);
    const result = await h.client.request("host.status", HOST_ID, {});
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "internal_error");
    assert.equal(result.ok === false && result.error.unknownOutcome, false);
    assert.match(result.ok === false ? result.error.message : "", /请求未发送/);
    assert.equal(h.client.pendingCount(), 0);
  });
});

describe("relay error frames", () => {
  test("an error carrying a request id settles that request with the wire code", async () => {
    const h = harness();
    const pending = h.client.request("host.status", HOST_ID, {});
    const settled = h.client.settleError(
      JSON.parse(requestErrorFrame(requestId(h), "host_offline", HOST_ID)),
      HOST_ID
    );
    assert.equal(settled, true);

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "host_offline");
    assert.equal(result.ok === false && result.error.unknownOutcome, undefined);
    assert.equal(h.client.pendingCount(), 0);
  });

  test("a relay rpc_timeout is an unknown outcome, an explicit rejection is not", async () => {
    const h = harness();
    const timedOut = h.client.request("host.status", HOST_ID, {});
    const rejected = h.client.request("conversation.list", HOST_ID, {});

    h.client.settleError(JSON.parse(requestErrorFrame(requestId(h, 0), "rpc_timeout", HOST_ID)), HOST_ID);
    h.client.settleError(JSON.parse(requestErrorFrame(requestId(h, 1), "request_expired", HOST_ID)), HOST_ID);

    const first = await timedOut;
    assert.equal(first.ok === false && first.error.code, "rpc_timeout");
    assert.equal(first.ok === false && first.error.unknownOutcome, true, "主机可能已经执行");

    const second = await rejected;
    assert.equal(second.ok === false && second.error.code, "request_expired");
    assert.equal(second.ok === false && second.error.unknownOutcome, undefined);
  });

  test("an error for another host settles nothing", async () => {
    const h = harness();
    h.client.request("host.status", HOST_ID, {});
    assert.equal(
      h.client.settleError(JSON.parse(requestErrorFrame(requestId(h), "host_offline", "host-2")), HOST_ID),
      false
    );
    assert.equal(h.client.pendingCount(), 1);
  });

  test("a connection-level error settles nothing", () => {
    const h = harness();
    h.client.request("host.status", HOST_ID, {});
    assert.equal(h.client.settleError(JSON.parse(errorFrame("unauthorized")), HOST_ID), false);
    assert.equal(h.client.pendingCount(), 1);
  });
});

describe("disconnect cleanup", () => {
  test("in-flight requests fail immediately with an unknown outcome", async () => {
    const h = harness();
    const first = h.client.request("host.status", HOST_ID, {});
    const second = h.client.request("conversation.list", HOST_ID, {});

    h.client.rejectAll({
      code: "internal_error",
      message: "连接已断开，请求结果未知",
      retryable: true,
      unknownOutcome: true
    });

    for (const settled of [await first, await second]) {
      assert.equal(settled.ok, false);
      assert.equal(settled.ok === false && settled.error.unknownOutcome, true);
    }
    assert.equal(h.client.pendingCount(), 0, "nothing is left hanging until its own timeout");
  });

  test("dispose releases everything and leaves no timer armed", async () => {
    const h = harness();
    const pending = h.client.request("host.status", HOST_ID, {});
    h.client.dispose();
    assert.equal((await pending).ok, false);
    assert.equal(h.client.pendingCount(), 0);
    h.advance(60_000);
    assert.equal(h.client.pendingCount(), 0);
  });
});
