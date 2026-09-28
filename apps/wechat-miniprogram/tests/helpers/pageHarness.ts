/**
 * Controller/page test harness.
 *
 * Wires the *production* `createAdminConnection` (real frames, real admission pipeline, real RPC
 * correlation) to the fake transport and answers outgoing `rpc.request` frames from a small
 * responder table. That is what lets a page controller test observe "the page asked for the next
 * page", "the page never re-sent after a drop" or "the late page never reached a dead page".
 */

import { createHostTargetRegistry } from "../../miniprogram/config/hostTarget";
import { createAdminConnection, type AdminConnection, type AdminCredential } from "../../miniprogram/services/adminConnection";
import { createOperatorTokenSession, type OperatorTokenSession } from "../../miniprogram/services/adminSession";
import { createMemoryResumeCursorStorage } from "../../miniprogram/services/resumeCursorStorage";
import { createAdminStores, type AdminStores } from "../../miniprogram/stores/adminStores";

import {
  ISOTIME,
  adminAuthOkFrame,
  createManualScheduler,
  createSocketHub,
  createTestIdFactory,
  rpcResponseFrame,
  sentFrames,
  snapshotPayload,
  type ManualScheduler,
  type SocketHub
} from "./fakeTransport";

export const PAGE_TOKEN = "local-dev-token";
export const PAGE_HOST = "host-1";
export const PAGE_HOST_2 = "host-2";
export const PAGE_ADMIN_URL = "ws://127.0.0.1:8080/v1/ws/admin";

export type Responder = (params: Record<string, unknown>) => unknown;

export interface Responders {
  "sync.snapshot"?: Responder;
  "host.status"?: Responder;
  "conversation.list"?: Responder;
  "message.list"?: Responder;
  "conversation.get"?: Responder;
}

export interface PageHarness {
  readonly connection: AdminConnection;
  readonly stores: AdminStores;
  readonly hub: SocketHub;
  readonly scheduler: ManualScheduler;
  readonly storage: ReturnType<typeof createMemoryResumeCursorStorage>;
  /** The DEV in-memory credential, shared with an injected credential when a test wants one. */
  readonly tokenSession: OperatorTokenSession;
  /** Mutable so a test can change pagination behaviour between actions. */
  readonly responders: Responders;
  /** `baseSeq` used by the default `sync.snapshot` responder. */
  baseSeq: number;
  advance(ms: number): void;
  /** Fires `open` + `auth.ok` on the newest socket. */
  open(): void;
  /** Answers every outstanding request using the responder table, then lets promises settle. */
  pump(): Promise<void>;
  /** Requests of a method that are still unanswered, oldest first. */
  unanswered(method: string): readonly Record<string, unknown>[];
  /** All requests of a method ever sent on the newest socket. */
  requests(method: string): readonly Record<string, unknown>[];
  framesSent(): readonly Record<string, unknown>[];
  settle(): Promise<void>;
  boot(baseSeq?: number): Promise<void>;
  dropSocket(): void;
}

export async function settle(): Promise<void> {
  // Two turns: the RPC promise resolves, and the read layer's continuation runs.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

export interface PageHarnessOptions {
  /** Injected credential, mirroring how the App session wires a WeChat session to the socket. */
  readonly credential?: AdminCredential;
  /** Shared DEV credential; defaults to a fresh in-memory session. */
  readonly devSession?: OperatorTokenSession;
}

export function createPageHarness(options: PageHarnessOptions = {}): PageHarness {
  const hub = createSocketHub();
  const scheduler = createManualScheduler();
  const storage = createMemoryResumeCursorStorage();
  const stores = createAdminStores();
  const tokenSession = options.devSession ?? createOperatorTokenSession();
  const connection = createAdminConnection({
    adminSocketUrl: PAGE_ADMIN_URL,
    clientVersion: "0.0.0",
    createSocket: (url) => hub.createSocket(url),
    scheduler,
    isoNow: () => ISOTIME,
    nextId: createTestIdFactory(),
    random: () => 0.5,
    tokenSession,
    credential: options.credential,
    hostTarget: createHostTargetRegistry(),
    stores,
    resumeStorage: storage
  });

  const answered = new Set<string>();

  function requestsOf(method: string): readonly Record<string, unknown>[] {
    return sentFrames(hub.last()).filter((frame) => {
      const payload = frame.payload as { method?: string } | undefined;
      return frame.type === "rpc.request" && payload?.method === method;
    });
  }

  const responders: Responders = {
    "sync.snapshot": () => snapshotPayload(PAGE_HOST, harnessRef.baseSeq, { conversations: [] }),
    "host.status": () => ({
      hostId: PAGE_HOST,
      displayName: "FreeBuddy 主机",
      online: true,
      appVersion: "0.9.10",
      protocolVersion: 1,
      remoteEnabled: true,
      activeRunCount: 2,
      pendingDecisionCount: 1,
      activeTerminalCount: 0,
      // Strictly newer than the snapshot's `serverTime`, so the mirror accepts it (the host store
      // is monotonic on `serverTime` and would otherwise reject an equal timestamp).
      serverTime: "2026-09-14T10:00:05.000Z"
    }),
    "conversation.list": () => ({ items: [], nextCursor: null }),
    "message.list": () => ({ items: [], nextCursor: null }),
    "conversation.get": () => null
  };

  const harnessRef: PageHarness = {
    connection,
    stores,
    hub,
    scheduler,
    storage,
    tokenSession,
    responders,
    baseSeq: 7,

    advance(ms) {
      scheduler.advance(ms);
    },

    open() {
      hub.last().fireOpen();
      hub.deliver(adminAuthOkFrame());
    },

    async pump() {
      for (let round = 0; round < 10; round += 1) {
        const outstanding = sentFrames(hub.last()).filter((frame) => {
          const payload = frame.payload as { method?: string } | undefined;
          return frame.type === "rpc.request" && !answered.has(frame.id as string) && payload?.method !== undefined;
        });
        if (outstanding.length === 0) {
          await settle();
          return;
        }
        for (const frame of outstanding) {
          const payload = frame.payload as { method: string; params?: Record<string, unknown> };
          const responder = responders[payload.method as keyof Responders];
          const result = responder === undefined ? {} : responder(payload.params ?? {});
          hub.deliver(rpcResponseFrame(PAGE_HOST, frame.id as string, result));
          answered.add(frame.id as string);
        }
        await settle();
      }
      throw new Error("pump did not converge");
    },

    unanswered(method) {
      return requestsOf(method).filter((frame) => !answered.has(frame.id as string));
    },

    requests(method) {
      return requestsOf(method);
    },

    framesSent() {
      return sentFrames(hub.last());
    },

    settle,

    async boot(baseSeq = 7) {
      harnessRef.baseSeq = baseSeq;
      connection.setToken(PAGE_TOKEN);
      connection.setHostId(PAGE_HOST);
      connection.connect("test");
      harnessRef.open();
      await harnessRef.pump();
    },

    dropSocket() {
      hub.last().fireClose(1006, "gone");
    }
  };

  return harnessRef;
}

/** Params of an `rpc.request` frame. */
export function paramsOf(frame: Record<string, unknown>): Record<string, unknown> {
  return (frame.payload as { params?: Record<string, unknown> }).params ?? {};
}
