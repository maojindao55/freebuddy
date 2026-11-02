import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// The remote WebUI reaches conversations through public/web-preload.js. The
// board's pin/unpin menu calls cliClient.setConversationPinned, which only
// works when this bridge exposes the same method as the desktop preload —
// a gap that shipped once already (TypeError in the WebUI, PR #222 review).
function loadWebPreload() {
  const source = fs.readFileSync(
    new URL("../public/web-preload.js", import.meta.url),
    "utf8"
  );
  const invoked = [];
  const fetch = async (path, options) => {
    if (path === "/api/invoke") {
      const body = JSON.parse(options.body);
      invoked.push({ channel: body.channel, args: body.args });
      return {
        status: 200,
        json: async () => ({ ok: true, result: { id: body.args[0].id } })
      };
    }
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const storage = { "fb_remote_token": "test-token" };
  const makeStorage = () => ({
    getItem: (key) => storage[key] ?? null,
    setItem: (key, value) => { storage[key] = String(value); },
    removeItem: (key) => { delete storage[key]; }
  });
  const context = {
    window: {},
    document: { createElement: () => ({ addEventListener() {} }) },
    sessionStorage: makeStorage(),
    localStorage: makeStorage(),
    fetch,
    location: { protocol: "http:", host: "localhost" },
    WebSocket: class { close() {} },
    console
  };
  vm.runInNewContext(source, context);
  return { api: context.window.freebuddy, invoked };
}

test("web bridge exposes setConversationPinned and forwards pin", async () => {
  const { api, invoked } = loadWebPreload();
  assert.equal(typeof api.cli.setConversationPinned, "function");
  const conversation = await api.cli.setConversationPinned("conv-1", true);
  assert.deepEqual(invoked, [{
    channel: "cli:setConversationPinned",
    args: [{ id: "conv-1", pinned: true }]
  }]);
  assert.equal(conversation.id, "conv-1");
});

test("web bridge forwards unpin through the same channel", async () => {
  const { api, invoked } = loadWebPreload();
  await api.cli.setConversationPinned("conv-2", false);
  assert.deepEqual(invoked, [{
    channel: "cli:setConversationPinned",
    args: [{ id: "conv-2", pinned: false }]
  }]);
});
