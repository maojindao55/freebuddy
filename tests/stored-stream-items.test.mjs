import test from "node:test";
import assert from "node:assert/strict";
import { createStoredStreamItemsCache } from "@freebuddy/cli-stream";

const body = text => JSON.stringify([{ kind: "thinking", content: text }]);

test("history parsing and preparation survive remounts and refresh changed bodies", () => {
  const cache = createStoredStreamItemsCache();
  const content = body("first");
  const raw = cache.parse(content, "message");
  let calls = 0;
  const prepare = items => { calls++; return items.map(item => ({ ...item })); };
  const first = cache.prepare(content, prepare, "message");
  assert.strictEqual(cache.parse(content, "message"), raw);
  assert.strictEqual(cache.prepare(content, prepare, "message"), first);
  assert.equal(calls, 1);
  const changed = cache.prepare(body("updated"), prepare, "message");
  assert.equal(changed[0].content, "updated");
  assert.notStrictEqual(changed, first);
  assert.equal(calls, 2);
  assert.equal(raw[0].content, "first");
});

test("history cache evicts least recently used messages and replaces live versions", () => {
  const cache = createStoredStreamItemsCache({ maxEntries: 2, maxChars: 200 });
  const a = cache.parse(body("a"), "a");
  const b = cache.parse(body("b"), "b");
  cache.parse(body("a"), "a");
  cache.parse(body("c"), "c");
  assert.strictEqual(cache.parse(body("a"), "a"), a);
  assert.notStrictEqual(cache.parse(body("b"), "b"), b);
  const retained = cache.parse(body("other"), "other");
  for (let i = 0; i < 100; i++) cache.parse(body(String(i)), "streaming");
  assert.strictEqual(cache.parse(body("other"), "other"), retained);
});

test("history cache bounds total content, including prepared entries", () => {
  const cache = createStoredStreamItemsCache({ maxEntries: 10, maxChars: body("a").length * 2 });
  const prepare = items => items.slice();
  const a = cache.prepare(body("a"), prepare, "a");
  cache.prepare(body("b"), prepare, "b");
  cache.prepare(body("c"), prepare, "c");
  assert.notStrictEqual(cache.prepare(body("a"), prepare, "a"), a);
  const large = body("x".repeat(200));
  assert.notStrictEqual(cache.parse(large), cache.parse(large));
});

test("malformed or legacy history retains its raw display fallback", () => {
  const cache = createStoredStreamItemsCache();
  for (const content of ["legacy text", "{broken", "null", '{"text":"object"}']) {
    assert.equal(cache.parse(content), undefined);
    assert.deepEqual(cache.prepare(content, (items, raw) => items ?? [{kind:"raw",content:raw}]),
      [{kind:"raw",content}]);
  }
});
