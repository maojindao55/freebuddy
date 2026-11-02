import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const dataUrl = value => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const compile = file => ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText;
const dragUrl = dataUrl(compile("../src/utils/conversationDrag.ts"));
const { CONVERSATION_DRAG_TYPE, writeConversationDrag, hasConversationDrag, resolveConversationDrag } = await import(dragUrl);
const mergeUrl = dataUrl(compile("../src/utils/conversationReferences.ts"));
const { mergeConversationReferences } = await import(mergeUrl);
const conversations = [{ id: "source", title: "源会话", agentName: "Codex" }, { id: "target", title: "当前会话", agentName: "Claude" }];

function transfer(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { get types() { return [...values.keys()]; }, effectAllowed: "all", dropEffect: "none",
    clearData() { values.clear(); }, setData(type, value) { values.set(type, value); }, getData(type) { return values.get(type) ?? ""; } };
}
function sourceTransfer() { const value = transfer(); writeConversationDrag(value, "source"); return value; }

test("sidebar drag carries only the source id and cannot paste text or a logo into the draft", () => {
  const value = transfer({ "text/html": "<img src=logo>", "text/plain": "old title" });
  writeConversationDrag(value, "source");
  assert.deepEqual(value.types, [CONVERSATION_DRAG_TYPE]);
  assert.deepEqual(JSON.parse(value.getData(CONVERSATION_DRAG_TYPE)), { version: 1, conversationId: "source" });
  assert.equal(value.effectAllowed, "copy");
});

test("file, path and ordinary text drags are left to existing handlers", () => {
  for (const type of ["Files", "text/plain", "text/uri-list"]) assert.equal(hasConversationDrag(transfer({ [type]: "/car_paly/home/" })), false);
  assert.equal(hasConversationDrag(sourceTransfer()), true);
});

test("drop resolves the current accessible source and ignores spoofed display fields", () => {
  const value = transfer({ [CONVERSATION_DRAG_TYPE]: JSON.stringify({ version: 1, conversationId: "source", title: "Spoofed", agentName: "Other" }) });
  assert.deepEqual(resolveConversationDrag(value, conversations, "target"), { reference: conversations[0] });
  assert.deepEqual(resolveConversationDrag(value, [], "target"), { error: "unavailable" });
  assert.deepEqual(resolveConversationDrag(value, conversations, "source"), { error: "self" });
});

test("malformed, missing and unsupported drag payloads never throw or add a reference", () => {
  for (const raw of ["", "{", "null", "[]", "42", JSON.stringify({ version: 2, conversationId: "source" }), JSON.stringify({ version: 1, conversationId: 12 }), "x".repeat(2048)]) {
    assert.deepEqual(resolveConversationDrag(transfer({ [CONVERSATION_DRAG_TYPE]: raw }), conversations), { error: "unavailable" });
  }
});

let harnessId = 0;
async function harness() {
  const mockUrl = dataUrl(`
    // ${harnessId++}
    let slots = [], cursor = 0, pending = [], cleanups = [], eventListeners = new Map();
    export const window = { addEventListener(name, callback) { const values = eventListeners.get(name) ?? new Set(); values.add(callback); eventListeners.set(name, values); },
      removeEventListener(name, callback) { eventListeners.get(name)?.delete(callback); } };
    export const emit = name => { for (const callback of eventListeners.get(name) ?? []) callback(); };
    export const renderStart = () => { cursor = 0; pending = []; };
    export const flushEffects = () => { for (const effect of pending) effect(); };
    export const useRef = value => useState({ current: value })[0];
    export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; }
    export function useEffect(effect, deps) { const index = cursor++; const previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous[i])) { pending.push(() => { cleanups[index]?.(); cleanups[index] = effect(); }); slots[index] = deps; } }
  `);
  const compiled = compile("../src/hooks/useConversationReferenceDrop.ts").replace(/from\s+["']([^"']+)["']/g,
    (_, path) => `from ${JSON.stringify(path === "@/utils/conversationDrag" ? dragUrl : mockUrl)}`);
  // Bind a local window for effect listener tests without mutating process globals.
  const { useConversationReferenceDrop } = await import(dataUrl(`import { window } from ${JSON.stringify(mockUrl)};\n${compiled}`));
  const mock = await import(mockUrl);
  let selected = [], disabled = false, targetId = "target", scopeKey = "target", focusCount = 0;
  const rejected = [];
  const render = () => { mock.renderStart(); const result = useConversationReferenceDrop({ conversations, targetId, scopeKey, disabled,
    onAdd: reference => { selected = mergeConversationReferences(selected, [reference]); }, onReject: reason => rejected.push(reason) }); mock.flushEffects(); return result; };
  const event = (data = sourceTransfer()) => ({ dataTransfer: data, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
    currentTarget: { querySelector: () => ({ focus() { focusCount++; } }) } });
  render();
  return { render, event, rejected, emit: mock.emit, get selected() { return selected; }, get focusCount() { return focusCount; },
    disable() { disabled = true; render(); }, changeTarget(id) { targetId = id; scopeKey = id ?? "new-task"; render(); } };
}

test("dragging over nested composer elements keeps the highlight until the pointer leaves or drops", async () => {
  const h = await harness();
  h.render().handleDragEnter(h.event());
  h.render().handleDragEnter(h.event());
  h.render().handleDragLeave(h.event());
  assert.equal(h.render().dragActive, true);
  h.render().handleDragLeave(h.event());
  assert.equal(h.render().dragActive, false);
  const event = h.event();
  h.render().handleDragOver(event);
  assert.equal(event.dataTransfer.dropEffect, "copy");
  h.render().handleDrop(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.deepEqual(h.selected, [conversations[0]]);
  assert.equal(h.focusCount, 1);
  h.render().handleDrop(h.event());
  assert.equal(h.selected.length, 1, "repeated drops deduplicate with the existing picker selection");
});

test("new task drops add the same reference; self drops and disabled composer drops do not", async () => {
  const h = await harness();
  h.changeTarget(undefined);
  h.render().handleDrop(h.event());
  assert.equal(h.selected.length, 1);
  h.changeTarget("source");
  h.render().handleDrop(h.event());
  assert.deepEqual(h.rejected, ["self"]);
  h.disable();
  const event = h.event();
  h.render().handleDragOver(event);
  assert.equal(event.dataTransfer.dropEffect, "none");
  h.render().handleDrop(event);
  assert.equal(h.selected.length, 1);
});

test("cancellation, dropping elsewhere, scope changes and send locks reset hover feedback", async () => {
  for (const name of ["dragend", "drop", "blur"]) {
    const h = await harness();
    h.render().handleDragEnter(h.event());
    assert.equal(h.render().dragActive, true);
    h.emit(name);
    assert.equal(h.render().dragActive, false);
  }
  const h = await harness();
  h.render().handleDragEnter(h.event());
  h.disable();
  assert.equal(h.render().dragActive, false);
  h.changeTarget("different");
  assert.equal(h.render().dragActive, false);
});

test("file drops are not consumed by the conversation drop hook", async () => {
  const h = await harness();
  for (const handler of ["handleDragEnter", "handleDragOver", "handleDragLeave", "handleDrop"]) {
    const event = h.event(transfer({ Files: "" }));
    assert.equal(h.render()[handler](event), false);
    assert.equal(event.prevented, undefined);
  }
  assert.deepEqual(h.selected, []);
});
