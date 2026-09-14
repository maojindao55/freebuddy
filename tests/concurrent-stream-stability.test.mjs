import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

const runtime = read("../electron/cli/runtime.ts");
const main = read("../electron/main.ts");
const handlers = read("../src/store/conversationHandlers.ts");
const chatView = read("../src/components/CLI/ChatView.tsx");

test("high-frequency ACP events are batched below animation-frame frequency", () => {
  assert.match(runtime, /const FLUSH_MS = 80/);
  assert.match(runtime, /createItemsBatchingEmit/);
});

test("background streams keep one progressive snapshot instead of duplicating message JSON", () => {
  assert.match(handlers, /Keep progressive output only in `live`/);
  assert.match(chatView, /const liveContent = JSON\.stringify\(live\.items\)/);
  assert.match(handlers, /capPersistedStreamItems\(live\.items\)/);
});

test("main renderer crash records dumps and reloads with loop protection", () => {
  assert.match(main, /crashReporter\.start\(/);
  assert.match(main, /MAX_RENDERER_RECOVERIES_PER_WINDOW = 2/);
  assert.match(main, /win\.webContents\.reload\(\)/);
  assert.match(main, /reason !== "crashed" && reason !== "oom"/);
});
