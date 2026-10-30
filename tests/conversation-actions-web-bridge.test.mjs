import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// The remote WebUI reaches conversations through public/web-preload.js. Fork,
// move-to-project and manual ordering call cliClient methods that only work
// when this bridge exposes the same methods as the desktop preload — the same
// gap that shipped once already (TypeError in the WebUI, PR #222/#224 review).
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
        json: async () => ({ ok: true, result: { id: "conv-1" } })
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

test("web bridge exposes forkConversation and forwards its input", async () => {
  const { api, invoked } = loadWebPreload();
  assert.equal(typeof api.cli.forkConversation, "function");
  await api.cli.forkConversation({
    sourceConversationId: "src-1",
    throughMessageId: "msg-9",
    targetConversationId: "fork-1"
  });
  assert.deepEqual(invoked, [{
    channel: "cli:forkConversation",
    args: [{
      sourceConversationId: "src-1",
      throughMessageId: "msg-9",
      targetConversationId: "fork-1"
    }]
  }]);
});

test("web bridge exposes moveConversationToProject with desktop arg shape", async () => {
  const { api, invoked } = loadWebPreload();
  assert.equal(typeof api.cli.moveConversationToProject, "function");
  await api.cli.moveConversationToProject("conv-1", "proj-1");
  assert.deepEqual(invoked, [{
    channel: "cli:moveConversationToProject",
    args: [{ id: "conv-1", projectId: "proj-1" }]
  }]);
  await api.cli.moveConversationToProject("conv-1", null);
  assert.deepEqual(invoked[1], {
    channel: "cli:moveConversationToProject",
    args: [{ id: "conv-1", projectId: null }]
  });
});

test("web bridge exposes manual ordering channels", async () => {
  const { api, invoked } = loadWebPreload();
  assert.equal(typeof api.cli.setConversationOrder, "function");
  assert.equal(typeof api.cli.resetConversationOrder, "function");
  await api.cli.setConversationOrder(["b", "a"]);
  await api.cli.resetConversationOrder(["b", "a"]);
  assert.deepEqual(invoked, [
    { channel: "cli:setConversationOrder", args: [{ conversationIds: ["b", "a"] }] },
    { channel: "cli:resetConversationOrder", args: [{ conversationIds: ["b", "a"] }] }
  ]);
});
