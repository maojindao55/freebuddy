import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createWechatApi } from "../miniprogram/platform/wechatApi";
import { getWechatApi, resetWechatApi, setWechatApi } from "../miniprogram/platform/wechatApiProvider";
import { createFakeWechatHost } from "./helpers/fakeWechatHost";
import { createFakeWechatApi } from "./helpers/fakeWechatApi";

describe("createWechatApi", () => {
  test("login resolves with the temporary code", async () => {
    const host = createFakeWechatHost({ loginCode: "code-abc" });
    const api = createWechatApi(host);
    await assert.doesNotReject(api.login());
    assert.deepEqual(await api.login(), { code: "code-abc" });
    assert.equal(host.calls.filter((call) => call.method === "login").length, 2);
  });

  test("login failures reject with a redacted message", async () => {
    const host = createFakeWechatHost({ loginError: { errMsg: "login:fail token=abcdef123456" } });
    await assert.rejects(createWechatApi(host).login(), (error: Error) => {
      assert.match(error.message, /\[redacted\]/);
      assert.doesNotMatch(error.message, /abcdef123456/);
      return true;
    });
  });

  test("storage round-trips through the host", () => {
    const host = createFakeWechatHost();
    const api = createWechatApi(host);
    api.setStorageSync("k", { a: 1 });
    assert.deepEqual(api.getStorageSync("k"), { a: 1 });
    api.removeStorageSync("k");
    assert.equal(api.getStorageSync("k"), undefined);
  });

  test("request resolves with status and payload, rejects on failure", async () => {
    const host = createFakeWechatHost({ requestResult: { statusCode: 201, data: { id: "x" } } });
    const result = await createWechatApi(host).request<{ id: string }>({
      url: "https://relay.example.com/v1/auth/wechat",
      method: "POST",
      header: { "content-type": "application/json" },
      data: { code: "code-abc" },
      timeout: 5000
    });
    assert.equal(result.statusCode, 201);
    assert.deepEqual(result.data, { id: "x" });

    const failingHost = createFakeWechatHost({ requestError: { errMsg: "request:fail" } });
    await assert.rejects(
      createWechatApi(failingHost).request({ url: "https://relay.example.com", method: "GET" }),
      /request:fail/
    );
  });

  test("connectSocket delegates url and protocols", () => {
    const host = createFakeWechatHost();
    const task = createWechatApi(host).connectSocket({
      url: "wss://relay.example.com/v1/ws/admin",
      protocols: ["freebuddy-remote-v1"]
    });
    assert.deepEqual(host.sockets, [
      { url: "wss://relay.example.com/v1/ws/admin", protocols: ["freebuddy-remote-v1"] }
    ]);
    task.send("{}");
    assert.deepEqual(host.sent, ["{}"]);
  });

  test("network listeners can be removed", () => {
    const host = createFakeWechatHost();
    const api = createWechatApi(host);
    const seen: boolean[] = [];
    const unsubscribe = api.onNetworkStatusChange((status) => seen.push(status.isConnected));

    host.emitNetworkStatus({ isConnected: true, networkType: "wifi" });
    assert.equal(host.listenerCount(), 1);

    unsubscribe();
    host.emitNetworkStatus({ isConnected: false, networkType: "none" });
    assert.equal(host.listenerCount(), 0);
    assert.deepEqual(seen, [true]);
  });

  test("client info and env version are normalised", () => {
    assert.deepEqual(createWechatApi(createFakeWechatHost()).getClientInfo(), {
      SDKVersion: "3.5.0",
      version: "8.0.0",
      language: "zh_CN"
    });
    assert.equal(createWechatApi(createFakeWechatHost({ envVersion: "develop" })).getEnvVersion(), "develop");
    assert.equal(createWechatApi(createFakeWechatHost({ envVersion: "trial" })).getEnvVersion(), "trial");
    assert.equal(createWechatApi(createFakeWechatHost({ envVersion: "nonsense" })).getEnvVersion(), "release");
  });

  test("host storage failures surface as errors, never as silent undefined", () => {
    const host = createFakeWechatHost();
    host.setStorageSync = () => {
      throw new Error("setStorageSync:fail quota");
    };
    assert.throws(() => createWechatApi(host).setStorageSync("k", 1), /quota/);
  });
});

describe("wechatApiProvider", () => {
  test("injected implementations win over the global", (t) => {
    t.after(() => resetWechatApi());

    const fake = createFakeWechatApi();
    setWechatApi(fake);
    assert.equal(getWechatApi(), fake);
    assert.equal(getWechatApi().kind, "fake");
  });

  test("without wx and without injection the failure is explicit", (t) => {
    t.after(() => resetWechatApi());

    const globalWithWx = globalThis as unknown as { wx?: unknown };
    const previous = globalWithWx.wx;
    delete globalWithWx.wx;
    try {
      assert.throws(() => getWechatApi(), /wx is unavailable/);
    } finally {
      if (previous !== undefined) {
        globalWithWx.wx = previous;
      }
      resetWechatApi();
    }
  });

  test("reset clears the memoised adapter", (t) => {
    t.after(() => resetWechatApi());

    const first = createFakeWechatApi();
    setWechatApi(first);
    assert.equal(getWechatApi(), first);

    resetWechatApi();
    const second = createFakeWechatApi();
    setWechatApi(second);
    assert.equal(getWechatApi(), second);
  });
});
