/**
 * A `SocketTaskLike` backed by a real WebSocket.
 *
 * The mini program's production transport (`services/relaySocket.ts`) is used verbatim by the
 * integration tests: only the socket factory behind the `WechatApi` seam changes, from
 * `wx.connectSocket` to Node's `WebSocket`. Nothing about framing, admission, correlation or the
 * state machine is re-implemented here — this file only forwards callbacks.
 */

import type {
  SocketCloseEvent,
  SocketErrorEvent,
  SocketMessageEvent,
  SocketTaskLike
} from "../../miniprogram/platform/wechatApi";

/** Structural subset of Node's `WebSocket` this adapter relies on. */
interface RawWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

interface RawWebSocketConstructor {
  new (url: string, options?: { readonly headers?: Readonly<Record<string, string>> }): RawWebSocket;
}

export interface RealSocketOptions {
  /** Only the simulated *host* needs handshake headers; the admin authenticates in-band. */
  readonly headers?: Readonly<Record<string, string>>;
}

function readField(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  return (source as Record<string, unknown>)[key];
}

function readString(source: unknown, key: string, fallback: string): string {
  const value = readField(source, key);
  return typeof value === "string" ? value : fallback;
}

function readNumber(source: unknown, key: string, fallback: number): number {
  const value = readField(source, key);
  return typeof value === "number" ? value : fallback;
}

function readMessageText(event: unknown): string {
  const data = readField(event, "data");
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  return "";
}

export function createRealSocketTask(url: string, options: RealSocketOptions = {}): SocketTaskLike {
  const ctor = (globalThis as unknown as { WebSocket: RawWebSocketConstructor }).WebSocket;
  const socket =
    options.headers === undefined
      ? new ctor(url)
      : new ctor(url, { headers: { ...options.headers } });

  let openListener: (() => void) | null = null;
  let messageListener: ((event: SocketMessageEvent) => void) | null = null;
  let errorListener: ((event: SocketErrorEvent) => void) | null = null;
  let closeListener: ((event: SocketCloseEvent) => void) | null = null;

  socket.addEventListener("open", () => {
    openListener?.();
  });
  socket.addEventListener("message", (event) => {
    messageListener?.({ data: readMessageText(event) });
  });
  socket.addEventListener("error", (event) => {
    const message = readString(readField(event, "error"), "message", "") ||
      readString(event, "message", "socket error");
    errorListener?.({ errMsg: message });
  });
  socket.addEventListener("close", (event) => {
    closeListener?.({
      code: readNumber(event, "code", 1006),
      reason: readString(event, "reason", "")
    });
  });

  return {
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code ?? 1000, reason ?? "client_close");
    },
    onOpen(listener) {
      openListener = listener;
    },
    onMessage(listener) {
      messageListener = listener;
    },
    onError(listener) {
      errorListener = listener;
    },
    onClose(listener) {
      closeListener = listener;
    }
  };
}
