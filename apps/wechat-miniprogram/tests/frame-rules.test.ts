import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ADMIN_INBOUND_FRAME_TYPES,
  ADMIN_OUTBOUND_FRAME_TYPES,
  FRAME_DIRECTIONS,
  buildAdminAuthFrame,
  buildPingFrame,
  buildPongFrame,
  buildResumeFrame,
  buildRpcRequestFrame,
  classifyInboundFrame,
  hasCompleteDirectionTable,
  readEventSeq,
  readFrameHostId,
  readRpcRequestId,
  type InboundViolation
} from "../miniprogram/protocol/frameRules";

import { REMOTE_FRAME_TYPES } from "../miniprogram/protocol/remote.generated";

import {
  ISOTIME,
  adminAuthOkFrame,
  errorFrame,
  eventFrame,
  pingFrame,
  snapshotFrame
} from "./helpers/fakeTransport";

describe("frame admission", () => {
  test("every protocol frame type has a direction", () => {
    assert.equal(hasCompleteDirectionTable(), true);
    assert.equal(REMOTE_FRAME_TYPES.length, 13);
  });

  test("only bidirectional frames may flow both ways", () => {
    const both = REMOTE_FRAME_TYPES.filter(
      (type) => ADMIN_INBOUND_FRAME_TYPES.has(type) && ADMIN_OUTBOUND_FRAME_TYPES.has(type)
    );
    assert.deepEqual([...both].sort(), ["error", "ping", "pong"]);
  });

  test("frames addressed to the host are rejected before reaching any store", () => {
    const outcome = classifyInboundFrame(
      JSON.stringify({
        v: 1,
        id: "m1",
        type: "challenge",
        sentAt: ISOTIME,
        payload: { connectionId: "conn-1", challenge: "c", issuedAt: ISOTIME, expiresAt: ISOTIME }
      }),
      { authenticated: true, expectedHostId: "host-1" }
    );
    assert.equal(outcome.kind, "violation");
    assert.equal((outcome as { violation: InboundViolation }).violation.code, "frame_direction");
  });

  test("host-to-relay frames are rejected even when the host id matches", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "m1",
      type: "host.auth",
      hostId: "host-1",
      sentAt: ISOTIME,
      payload: {
        hostId: "host-1",
        keyId: "key-1",
        publicKey: "pk",
        signature: "sig",
        clientVersion: "0.0.0",
        protocolVersion: 1
      }
    });
    const outcome = classifyInboundFrame(raw, { authenticated: true, expectedHostId: "host-1" });
    assert.equal(outcome.kind, "violation");
    assert.equal((outcome as { violation: InboundViolation }).violation.code, "frame_direction");
  });

  test("malformed, oversized and non-JSON frames are refused", () => {
    const context = { authenticated: true, expectedHostId: "host-1" };
    const cases: Array<[unknown, string]> = [
      ["x".repeat(262_145), "frame_too_large"],
      ["{not json", "invalid_json"],
      [JSON.stringify({ v: 2, id: "m1", type: "ping", sentAt: ISOTIME, payload: {} }), "frame_schema"],
      [JSON.stringify({ v: 1, id: "m1", type: "nope", sentAt: ISOTIME, payload: {} }), "frame_schema"],
      [JSON.stringify({ v: 1, id: "m1", type: "ping", sentAt: ISOTIME, payload: {}, extra: 1 }), "frame_schema"],
      [42, "frame_schema"]
    ];
    for (const [raw, expected] of cases) {
      const outcome = classifyInboundFrame(raw, context);
      assert.equal(outcome.kind, "violation", `${String(raw).slice(0, 24)} must be refused`);
      assert.equal((outcome as { violation: InboundViolation }).violation.code, expected);
    }
  });

  test("nothing except the handshake is accepted before auth.ok", () => {
    const outcome = classifyInboundFrame(pingFrame(), { authenticated: false, expectedHostId: "host-1" });
    assert.equal(outcome.kind, "violation");
    assert.equal((outcome as { violation: InboundViolation }).violation.code, "frame_pre_auth");

    assert.equal(
      classifyInboundFrame(errorFrame("forbidden"), { authenticated: false, expectedHostId: "host-1" }).kind,
      "frame"
    );
    assert.equal(
      classifyInboundFrame(adminAuthOkFrame(), { authenticated: false, expectedHostId: "host-1" }).kind,
      "frame"
    );
  });

  test("frames from another host never reach the client", () => {
    const context = { authenticated: true, expectedHostId: "host-1" };
    for (const raw of [eventFrame("host-2", "host.status.changed", 1, {}), snapshotFrame("host-2", 1)]) {
      const outcome = classifyInboundFrame(raw, context);
      assert.equal(outcome.kind, "violation");
      assert.equal((outcome as { violation: InboundViolation }).violation.code, "frame_identity");
    }
    // The configured host is accepted.
    assert.equal(classifyInboundFrame(eventFrame("host-1", "host.status.changed", 1, {}), context).kind, "frame");
  });

  test("a host-scoped frame is refused while no host is configured", () => {
    const outcome = classifyInboundFrame(eventFrame("host-1", "host.status.changed", 1, {}), {
      authenticated: true,
      expectedHostId: null
    });
    assert.equal(outcome.kind, "violation");
    assert.equal((outcome as { violation: InboundViolation }).violation.code, "frame_identity");
  });

  test("read helpers only accept well-formed values", () => {
    assert.equal(readFrameHostId({ hostId: "host-1" }), "host-1");
    assert.equal(readFrameHostId({ hostId: 7 }), undefined);
    assert.equal(readFrameHostId(null), undefined);
    assert.equal(readRpcRequestId({ payload: { requestId: "req1" } } as never), "req1");
    assert.equal(readRpcRequestId({ payload: { requestId: "" } } as never), null);
    assert.equal(readEventSeq({ seq: 4 } as never), 4);
    assert.equal(readEventSeq({ seq: -1 } as never), null);
    assert.equal(readEventSeq({ seq: 1.5 } as never), null);
  });
});

describe("outbound frames", () => {
  test("admin.auth carries exactly the protocol fields", () => {
    const frame = buildAdminAuthFrame({
      id: "m1",
      sentAt: ISOTIME,
      accessToken: "dev-token",
      clientVersion: "0.0.0"
    });
    assert.deepEqual(frame, {
      v: 1,
      id: "m1",
      type: "admin.auth",
      sentAt: ISOTIME,
      payload: { accessToken: "dev-token", clientVersion: "0.0.0", protocolVersion: 1 }
    });
  });

  test("ping omits the nonce instead of sending null", () => {
    assert.deepEqual(buildPingFrame({ id: "m1", sentAt: ISOTIME }), {
      v: 1,
      id: "m1",
      type: "ping",
      sentAt: ISOTIME,
      payload: {}
    });
    assert.deepEqual(buildPongFrame({ id: "m2", sentAt: ISOTIME, serverTime: ISOTIME }), {
      v: 1,
      id: "m2",
      type: "pong",
      sentAt: ISOTIME,
      payload: { serverTime: ISOTIME }
    });
  });

  test("rpc.request always carries hostId and never a raw shell/channel parameter", () => {
    const frame = buildRpcRequestFrame({
      id: "req1",
      sentAt: ISOTIME,
      hostId: "host-1",
      method: "message.list",
      params: { conversationId: "conv-1" }
    });
    assert.deepEqual(frame, {
      v: 1,
      id: "req1",
      type: "rpc.request",
      sentAt: ISOTIME,
      hostId: "host-1",
      payload: { method: "message.list", params: { conversationId: "conv-1" } }
    });
    assert.deepEqual(Object.keys(frame), ["v", "id", "type", "sentAt", "hostId", "payload"]);
  });

  test("resume carries the last applied seq", () => {
    assert.deepEqual(buildResumeFrame({ id: "m1", sentAt: ISOTIME, hostId: "host-1", resumeFrom: 41 }), {
      v: 1,
      id: "m1",
      type: "resume",
      sentAt: ISOTIME,
      hostId: "host-1",
      payload: { resumeFrom: 41 }
    });
  });

  test("the admin cannot emit a host or relay frame", () => {
    assert.equal(ADMIN_OUTBOUND_FRAME_TYPES.has("challenge"), false);
    assert.equal(ADMIN_OUTBOUND_FRAME_TYPES.has("host.auth"), false);
    assert.equal(ADMIN_OUTBOUND_FRAME_TYPES.has("rpc.response"), false);
    assert.equal(ADMIN_OUTBOUND_FRAME_TYPES.has("admin.auth"), true);
    assert.equal(FRAME_DIRECTIONS["server.draining"], "relayToClient");
  });
});
