/**
 * The wx socket adapter is the one place where the real WeChat object-form `SocketTask`
 * (`send({ data })`, `close({ code, reason })`) meets the primitive-form business seam
 * (`SocketTaskLike.send(string)`).
 *
 * These tests drive that seam with a *strict* object-form task. Unlike the lenient fakes that
 * previously implemented `SocketTaskLike` directly, this one throws on a primitive argument, so a
 * regression that hands the raw task to business code fails here instead of surfacing on device as
 * `authentication timeout or invalid frame` from the Relay.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  adaptWechatSocketTask,
  createWechatApi,
  type SocketErrorEvent,
  type WechatSocketTask,
  type WechatSocketTaskCloseOptions,
  type WechatSocketTaskSendOptions
} from "../miniprogram/platform/wechatApi";
import { createFakeWechatHost } from "./helpers/fakeWechatHost";

/**
 * Compile-time contract check: the real `wx` `SocketTask` from `miniprogram-api-typings` must stay
 * assignable to our `WechatSocketTask`. The `Assert<... extends true>` wrapper makes this a hard
 * compile error if a typings bump changes `send`/`close`/listener shapes, before a drifting adapter
 * can ship.
 */
type Assert<T extends true> = T;
export type WechatSocketTaskMatchesSdk = Assert<
  WechatMiniprogram.SocketTask extends WechatSocketTask ? true : false
>;

interface StrictRawTaskOptions {
  readonly failOnSend?: { readonly errMsg: string };
  readonly throwOnSend?: Error;
}

interface StrictRawTask {
  readonly task: WechatSocketTask;
  readonly sends: WechatSocketTaskSendOptions[];
  readonly closes: WechatSocketTaskCloseOptions[];
  /** Fires the raw error listener the adapter registered, exactly as `wx` would on a socket error. */
  emitError(event: SocketErrorEvent): void;
}

/** A raw task that accepts object-form arguments only, exactly like `wx`. */
function createStrictRawTask(options: StrictRawTaskOptions = {}): StrictRawTask {
  const sends: WechatSocketTaskSendOptions[] = [];
  const closes: WechatSocketTaskCloseOptions[] = [];
  let rawErrorListener: ((event: SocketErrorEvent) => void) | null = null;
  const task: WechatSocketTask = {
    send(sendOptions) {
      if (!sendOptions || typeof sendOptions.data !== "string") {
        throw new Error("SocketTask.send:fail parameter error");
      }
      sends.push(sendOptions);
      if (options.throwOnSend) {
        throw options.throwOnSend;
      }
      if (options.failOnSend) {
        sendOptions.fail?.(options.failOnSend);
      }
    },
    close(closeOptions) {
      closes.push(closeOptions);
    },
    onOpen: () => undefined,
    onMessage: () => undefined,
    onError(listener) {
      rawErrorListener = listener;
    },
    onClose: () => undefined
  };
  return {
    task,
    sends,
    closes,
    emitError(event) {
      rawErrorListener?.(event);
    }
  };
}

describe("wechat socket adapter", () => {
  test("translates the business primitive send into wx object form", () => {
    const raw = createStrictRawTask();
    const adapted = adaptWechatSocketTask(raw.task);

    // A primitive argument would throw inside `createStrictRawTask`; the adapter must never send one.
    adapted.send('{"type":"ping"}');

    assert.equal(raw.sends.length, 1);
    assert.deepEqual(raw.sends[0].data, '{"type":"ping"}');
  });

  test("the strict raw task rejects a primitive argument, as real wx does", () => {
    const raw = createStrictRawTask();
    assert.throws(
      () => raw.task.send('{"type":"ping"}' as unknown as WechatSocketTaskSendOptions),
      /parameter error/
    );
  });

  test("translates close code and reason into wx object form", () => {
    const raw = createStrictRawTask();
    const adapted = adaptWechatSocketTask(raw.task);

    adapted.close(1000, "client_close");
    adapted.close();

    assert.deepEqual(raw.closes, [
      { code: 1000, reason: "client_close" },
      { code: 1000, reason: "client_close" }
    ]);
  });

  test("an asynchronous send failure surfaces through onError, without the frame", () => {
    const raw = createStrictRawTask({
      failOnSend: { errMsg: "SocketTask.send:fail token=SUPER_SECRET" }
    });
    const adapted = adaptWechatSocketTask(raw.task);
    const errors: string[] = [];
    adapted.onError((event) => errors.push(event.errMsg));

    adapted.send('{"type":"admin.auth","payload":{"accessToken":"SuperSecretTokenValue123"}}');

    assert.equal(errors.length, 1);
    assert.match(errors[0], /socket send failed/);
    assert.match(errors[0], /\[redacted\]/);
    assert.doesNotMatch(errors[0], /SUPER_SECRET/);
    assert.doesNotMatch(errors[0], /SuperSecretTokenValue123/);
    assert.doesNotMatch(errors[0], /admin\.auth/);
  });

  test("a synchronous send error propagates redacted to the caller", () => {
    const raw = createStrictRawTask({
      throwOnSend: new Error("SocketTask.send:fail token=SUPER_SECRET")
    });
    const adapted = adaptWechatSocketTask(raw.task);

    assert.throws(
      () => adapted.send('{"type":"admin.auth","payload":{"accessToken":"SuperSecretTokenValue123"}}'),
      (error: Error) => {
        assert.match(error.message, /\[redacted\]/);
        assert.doesNotMatch(error.message, /SUPER_SECRET/);
        assert.doesNotMatch(error.message, /SuperSecretTokenValue123/);
        return true;
      }
    );
  });

  test("forwards a raw socket error to the business listener, redacted and once", () => {
    const raw = createStrictRawTask();
    const adapted = adaptWechatSocketTask(raw.task);
    const errors: string[] = [];
    adapted.onError((event) => errors.push(event.errMsg));

    // A raw network error must reach `relaySocket`, which owns teardown and reconnect.
    raw.emitError({ errMsg: "network down token=SUPER_SECRET" });
    // Later errors on the same connection are suppressed so teardown is not triggered twice.
    raw.emitError({ errMsg: "second error" });

    assert.equal(errors.length, 1);
    assert.match(errors[0], /socket error/);
    assert.match(errors[0], /\[redacted\]/);
    assert.doesNotMatch(errors[0], /SUPER_SECRET/);
  });

  test("createWechatApi bridges the raw object-form task to the business seam", () => {
    const host = createFakeWechatHost();
    const raw = createStrictRawTask();
    host.connectSocket = () => raw.task;

    const task = createWechatApi(host).connectSocket({
      url: "ws://127.0.0.1:8080/v1/ws/admin",
      protocols: ["freebuddy-remote-v1"]
    });
    task.send("frame-1");
    task.close(1000, "client_close");

    assert.equal(raw.sends.length, 1);
    assert.equal(raw.sends[0].data, "frame-1");
    assert.deepEqual(raw.closes, [{ code: 1000, reason: "client_close" }]);
  });
});
