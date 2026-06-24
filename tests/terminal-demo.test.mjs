import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("buildDevTerminalDemoItems embeds terminal in tool call", async () => {
  const source = readFileSync(join(root, "src/dev/terminalDemo.ts"), "utf8");
  assert.match(source, /kind: "tool-call"/);
  assert.match(source, /kind: "terminal-embed"/);
  assert.match(source, /toolOutputs/);
});

test("dev menu exposes terminal demo action in development", async () => {
  const source = readFileSync(join(root, "electron/menu.ts"), "utf8");
  assert.match(source, /menu\.development/);
  assert.match(source, /injectTerminalDemo/);
  assert.match(source, /dev:action/);
});

test("conversation store wires injectDevTerminalDemo", async () => {
  const source = readFileSync(join(root, "src/store/conversationStore.ts"), "utf8");
  assert.match(source, /injectDevTerminalDemo/);
  assert.match(source, /startDevTerminalDemo/);
});
