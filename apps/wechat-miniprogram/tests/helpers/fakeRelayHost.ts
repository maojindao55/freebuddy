/**
 * Simulated FreeBuddy desktop host.
 *
 * The real host is the Electron desktop client and is out of scope for this component, so the
 * integration test talks to a stand-in that is only as clever as the protocol requires: it
 * authenticates with the Relay's DEV host token over the real `/v1/ws/host` endpoint, answers
 * `rpc.request` frames with `rpc.response` frames, and (W3) can originate `event`/`snapshot`
 * frames with its own sequence numbers and observe the `resume` frames the admin sends it.
 *
 * It never touches the admin's transport, so everything the admin client sees still comes from the
 * real Go Relay, and it never fabricates a protocol field: the frames below are assembled from
 * the same shapes the v1 schema declares.
 */

import { randomBytes } from "node:crypto";

import { createRealSocketTask } from "./realSocket";
import { waitFor } from "./wait";

export interface FakeHostRequest {
  readonly requestId: string;
  readonly method: string;
  readonly hostId: string;
  readonly params: Record<string, unknown>;
}

export interface FakeResumeFrame {
  readonly id: string;
  readonly hostId: string;
  readonly resumeFrom: number;
}

export interface HostAuthOk {
  readonly role: string;
  readonly hostId: string | undefined;
  readonly connectionId: string;
}

export interface FakeRelayHost {
  readonly hostId: string;
  readonly authOk: HostAuthOk | null;
  requests(): readonly FakeHostRequest[];
  waitForRequests(method: string, count: number, timeoutMs: number): Promise<readonly FakeHostRequest[]>;
  respondOk(requestId: string, result: unknown): void;
  respondError(requestId: string, code: string, message: string): void;
  /** `resume` frames the real Relay forwarded from the admin, in arrival order. */
  resumeFrames(): readonly FakeResumeFrame[];
  waitForResume(timeoutMs: number): Promise<FakeResumeFrame>;
  /** Originates a sequenced `event` frame, exactly as the desktop host does. */
  sendEvent(seq: number, name: string, data: unknown): void;
  /** Originates an authoritative `snapshot` frame. */
  sendSnapshot(seq: number, payload: Record<string, unknown>): void;
  close(): Promise<void>;
}

interface InboundFrame {
  readonly type: string;
  readonly id: string;
  readonly hostId?: string;
  readonly payload: Record<string, unknown>;
}

function parseFrame(raw: string): InboundFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const payload = typeof record.payload === "object" && record.payload !== null
    ? (record.payload as Record<string, unknown>)
    : {};
  return {
    type: typeof record.type === "string" ? record.type : "",
    id: typeof record.id === "string" ? record.id : "",
    hostId: typeof record.hostId === "string" ? record.hostId : undefined,
    payload
  };
}

export async function connectFakeHost(input: {
  readonly hostSocketUrl: string;
  readonly hostToken: string;
  readonly hostId: string;
}): Promise<FakeRelayHost> {
  const requests: FakeHostRequest[] = [];
  const resumes: FakeResumeFrame[] = [];
  let authOk: HostAuthOk | null = null;
  let closed = false;

  const readAuthOk = (): HostAuthOk | null => authOk;
  const isClosed = (): boolean => closed;

  const socket = createRealSocketTask(input.hostSocketUrl, {
    // Same handshake the desktop RelayClient uses in DEV mode.
    headers: { Authorization: `Bearer ${input.hostToken}`, "X-Host-Id": input.hostId }
  });

  socket.onClose(() => {
    closed = true;
  });
  socket.onError(() => {
    // The close event always follows; nothing to do here.
  });
  socket.onMessage((event) => {
    const frame = typeof event.data === "string" ? parseFrame(event.data) : null;
    if (frame === null) {
      return;
    }
    if (frame.type === "auth.ok") {
      authOk = {
        role: String(frame.payload.role ?? ""),
        hostId: typeof frame.payload.hostId === "string" ? frame.payload.hostId : undefined,
        connectionId: String(frame.payload.connectionId ?? "")
      };
      return;
    }
    if (frame.type === "resume") {
      resumes.push({
        id: frame.id,
        hostId: frame.hostId ?? "",
        resumeFrom: Number(frame.payload.resumeFrom)
      });
      return;
    }
    if (frame.type === "rpc.request") {
      requests.push({
        requestId: frame.id,
        method: String(frame.payload.method ?? ""),
        hostId: frame.hostId ?? "",
        params:
          typeof frame.payload.params === "object" && frame.payload.params !== null
            ? (frame.payload.params as Record<string, unknown>)
            : {}
      });
    }
  });

  // `auth.ok` is the proof that Relay bound this connection to the DEV host identity.
  const settled = await waitFor(() => readAuthOk(), 10_000, "host auth.ok");
  if (settled.role !== "host" || settled.hostId !== input.hostId) {
    socket.close(1000, "unexpected auth.ok");
    throw new Error(
      `host handshake rejected: role=${settled.role} hostId=${settled.hostId ?? "none"}`
    );
  }

  function send(payload: unknown, id?: string): void {
    socket.send(
      JSON.stringify({
        v: 1,
        type: "rpc.response",
        id: id ?? `msg_${randomBytes(8).toString("hex")}`,
        hostId: input.hostId,
        sentAt: new Date().toISOString(),
        payload
      })
    );
  }

  function sendTyped(type: "event" | "snapshot", seq: number, payload: unknown): void {
    socket.send(
      JSON.stringify({
        v: 1,
        type,
        id: `msg_${randomBytes(8).toString("hex")}`,
        hostId: input.hostId,
        seq,
        sentAt: new Date().toISOString(),
        payload
      })
    );
  }

  return {
    hostId: input.hostId,
    authOk: settled,
    requests() {
      return [...requests];
    },

    async waitForRequests(method, count, timeoutMs) {
      await waitFor(
        () => (requests.filter((request) => request.method === method).length >= count ? true : null),
        timeoutMs,
        `${count} × ${method} to reach the host`
      );
      return requests.filter((request) => request.method === method);
    },

    respondOk(requestId, result) {
      send({ requestId, ok: true, result });
    },

    respondError(requestId, code, message) {
      send({ requestId, ok: false, error: { code, message, retryable: false } });
    },

    resumeFrames() {
      return [...resumes];
    },

    async waitForResume(timeoutMs) {
      await waitFor(
        () => (resumes.length > 0 ? true : null),
        timeoutMs,
        "a resume frame to reach the host"
      );
      return resumes[resumes.length - 1];
    },

    sendEvent(seq, name, data) {
      sendTyped("event", seq, { name, data });
    },

    sendSnapshot(seq, payload) {
      sendTyped("snapshot", seq, payload);
    },

    async close() {
      if (isClosed()) {
        return;
      }
      socket.close(1000, "host_close");
      await waitFor(() => (isClosed() ? true : null), 5_000, "host socket close").catch(() => undefined);
    }
  };
}
