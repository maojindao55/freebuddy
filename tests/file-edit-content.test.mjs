import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

async function loadSource(relativePath) {
  const compiled = ts.transpileModule(fs.readFileSync(new URL(relativePath, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}
const { createFileEditContentLoader } = await loadSource("../src/services/cli/fileEditContent.ts");
const diffModule = await loadSource("../src/utils/fileDiff.ts");
const require = createRequire(import.meta.url);
const tick = () => new Promise(resolve => setImmediate(resolve));

function chunk(content) {
  const buffer = Buffer.from(JSON.stringify(content));
  return { data: buffer.toString("base64"), nextOffset: buffer.length, totalBytes: buffer.length, hasMore: false };
}

function makeStore(readFileEditBlob) {
  const compiled = ts.transpileModule(fs.readFileSync(new URL("../src/store/fileDiffStore.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    if (name === "zustand") return require(name);
    if (name === "@/utils/fileDiff") return diffModule;
    if (name === "@/services/cli/client") return { cliClient: { readFileEditBlob } };
    if (name === "@/services/cli/fileEditContent") return { createFileEditContentLoader };
    if (name === "./detailLayoutStore") return { useDetailLayoutStore: { getState: () => ({ setActiveTab() {}, setDetailCollapsed() {} }) } };
    throw new Error(name);
  } });
  return exports.useFileDiffStore;
}

test("content loads only on selection and late responses cannot replace another diff", async () => {
  const resolvers = new Map();
  const calls = [];
  const store = makeStore(async (conversationId, blobKey) => {
    calls.push(blobKey);
    return new Promise(resolve => resolvers.set(blobKey, resolve));
  });
  const edits = ["first", "second"].map(blobKey => ({ kind: "file-edit", path: `${blobKey}.ts`, action: "update", blobKey }));
  store.getState().refresh("conversation", "message", edits);
  assert.equal(calls.length, 0);
  store.getState().open({ conversationId: "conversation", messageId: "message", edits, index: 0 });
  assert.equal(store.getState().content.status, "loading");
  store.getState().select(1);
  resolvers.get("second")(chunk({ oldText: "before", newText: "second" }));
  await tick();
  assert.equal(store.getState().content.edit.newText, "second");
  resolvers.get("first")(chunk({ oldText: "before", newText: "first" }));
  await tick();
  assert.equal(store.getState().content.edit.newText, "second");
  store.getState().select(0);
  await tick();
  assert.equal(store.getState().content.edit.newText, "first");
  assert.equal(calls.length, 2);
  assert.equal(edits[0].oldText, undefined);
  assert.equal(store.getState().counts.first.added, 1);
  assert.equal(store.getState().counts.second.removed, 1);
});

test("failed and missing content can be retried without modifying message references", async () => {
  let attempts = 0;
  const store = makeStore(async () => {
    attempts++;
    if (attempts === 1) throw new Error("offline");
    if (attempts === 2) return undefined;
    return chunk({ oldText: "before", newText: "after" });
  });
  const edits = [{ kind: "file-edit", path: "file.ts", action: "update", blobKey: "key" }];
  store.getState().open({ conversationId: "conversation", edits, index: 0 });
  await tick();
  assert.equal(store.getState().content.status, "error");
  await store.getState().loadSelected(true);
  assert.equal(store.getState().content.status, "missing");
  await store.getState().loadSelected(true);
  assert.equal(store.getState().content.status, "ready");
  assert.equal(edits[0].newText, undefined);
});

test("refreshing unchanged references does not repeatedly publish selection updates", async () => {
  const store = makeStore(async () => chunk({ oldText: "before", newText: "after" }));
  const edits = [{ kind: "file-edit", path: "file.ts", action: "update", blobKey: "key" }];
  store.getState().open({ conversationId: "conversation", messageId: "message", edits, index: 0 });
  await tick();
  const selection = store.getState().selection;
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  store.getState().refresh("conversation", "message", [...edits]);
  assert.equal(store.getState().selection, selection);
  assert.equal(updates, 0);
  unsubscribe();
});

test("loader deduplicates requests, bounds previews and evicts cached contents", async () => {
  let requests = 0;
  const load = createFileEditContentLoader(async () => { requests++; return chunk({ newText: "a".repeat(30) }); }, 100);
  await Promise.all([load("conversation", "one"), load("conversation", "one")]);
  assert.equal(requests, 1);
  await load("conversation", "two");
  await load("conversation", "one");
  assert.equal(requests, 3);
  const oversized = createFileEditContentLoader(async () => ({ ...chunk({}), totalBytes: 101 }), 100);
  assert.equal((await oversized("conversation", "key")).status, "large");
  const malformed = createFileEditContentLoader(async () => ({ ...chunk({}), nextOffset: 0, hasMore: true }));
  await assert.rejects(malformed("conversation", "key"), /Invalid file edit page/);
});

test("stored metadata replaces stale references and preserves legacy inline edits", () => {
  const base = { kind: "file-edit", path: "file.ts", action: "update" };
  const legacy = { ...base, path: "legacy.ts", oldText: "a", newText: "b" };
  const stored = [{ ...base, blobKey: "new" }];
  assert.deepEqual(diffModule.mergeStoredFileEdits([{ ...base, blobKey: "old" }, base, legacy], stored), [legacy, ...stored]);
  assert.equal(diffModule.collectFileEdits([{ ...base, blobKey: "same" }, { ...base, blobKey: "same" }]).length, 1);
});
