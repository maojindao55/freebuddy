import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import vm from "node:vm";

// The row menu is opened manually (Dropdown trigger={[]}), so outside-click
// dismissal is our own logic (PR #222 review): with the menu open, activating
// anything outside the row — other rows, the main content — must close it,
// while activations inside the row and inside the antd popup must not.
const compiled = ts.transpileModule(
  fs.readFileSync(new URL("../src/hooks/useDismissOnOutsideActivation.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText;

function makeHarness() {
  const listeners = new Map();
  const fakeDocument = {
    addEventListener(type, fn) { listeners.set(fn, type); },
    removeEventListener(type, fn) { listeners.delete(fn); }
  };
  class Element {}
  const makeElement = ({ children = [], inDropdown = false } = {}) => {
    const element = new Element();
    element.contains = (target) => target === element || children.includes(target);
    element.closest = (selector) => (inDropdown && selector === ".ant-dropdown" ? { dropdown: true } : null);
    return element;
  };

  let pendingEffects = [];
  let cleanup = null;
  const reactMock = {
    useEffect(effect) { pendingEffects.push(effect); }
  };
  const sandbox = {
    exports: {},
    module: { exports: {} },
    require: (name) => {
      if (name === "react") return reactMock;
      throw new Error(`unexpected import: ${name}`);
    },
    document: fakeDocument,
    Element,
    console
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(compiled, sandbox);
  const run = (props) => {
    pendingEffects = [];
    sandbox.module.exports.useDismissOnOutsideActivation(props);
    cleanup?.();
    cleanup = pendingEffects[0]?.() ?? null;
  };
  const activate = (target) => {
    for (const [fn, type] of [...listeners]) {
      assert.equal(type, "pointerdown");
      fn({ target });
    }
  };
  return { run, activate, makeElement, listenerCount: () => listeners.size };
}

test("an inactive menu registers no outside-click listener", () => {
  const { run, makeElement, listenerCount } = makeHarness();
  run({ active: false, anchor: { current: makeElement() }, onClose: () => {} });
  assert.equal(listenerCount(), 0);
});

test("activating outside the row closes the open menu", () => {
  const { run, activate, makeElement } = makeHarness();
  let closes = 0;
  const anchor = makeElement();
  run({ active: true, anchor: { current: anchor }, onClose: () => { closes += 1; } });
  // Main content and other rows: both outside the anchor.
  activate(makeElement());
  activate(makeElement());
  assert.equal(closes, 2);
});

test("activations inside the row or the popup keep the menu open", () => {
  const { run, activate, makeElement } = makeHarness();
  let closes = 0;
  const rowBody = makeElement();
  const anchor = makeElement({ children: [rowBody] });
  const popupItem = makeElement({ inDropdown: true });
  run({ active: true, anchor: { current: anchor }, onClose: () => { closes += 1; } });
  activate(rowBody);
  activate(popupItem);
  activate(undefined); // non-Element targets are ignored
  assert.equal(closes, 0);
});

test("closing the menu removes the outside-click listener", () => {
  const { run, activate, makeElement, listenerCount } = makeHarness();
  let closes = 0;
  const anchor = makeElement();
  run({ active: true, anchor: { current: anchor }, onClose: () => { closes += 1; } });
  assert.equal(listenerCount(), 1);
  run({ active: false, anchor: { current: anchor }, onClose: () => { closes += 1; } });
  assert.equal(listenerCount(), 0);
  activate(makeElement());
  assert.equal(closes, 0);
});
