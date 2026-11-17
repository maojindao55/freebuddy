import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

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
        json: async () => ({ ok: true, result: { id: body.args[0].id, todo: body.args[0].todo } })
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

test("web bridge exposes setConversationTodo and forwards todo toggle", async () => {
  const { api, invoked } = loadWebPreload();
  assert.equal(typeof api.cli.setConversationTodo, "function");
  const marked = await api.cli.setConversationTodo("conv-1", true);
  const cleared = await api.cli.setConversationTodo("conv-2", false);
  assert.deepEqual(invoked, [
    { channel: "cli:setConversationTodo", args: [{ id: "conv-1", todo: true }] },
    { channel: "cli:setConversationTodo", args: [{ id: "conv-2", todo: false }] }
  ]);
  assert.equal(marked.id, "conv-1");
  assert.equal(marked.todo, true);
  assert.equal(cleared.todo, false);
});
