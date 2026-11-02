import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const compile = file => ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText;
const utilsUrl = dataUrl(compile("../src/utils/skillCommands.ts"));
let harnessId = 0;

async function harness() {
  const mockUrl = dataUrl(`
    // ${harnessId++}: isolate each hook's state.
    let slots = [], cursor = 0;
    export const resetCursor = () => { cursor = 0; };
    export const useId = () => "skills";
    export const useMemo = fn => fn();
    export const useEffect = () => {};
    export function useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    }
    export const useRef = value => useState({ current: value })[0];
    export const useSkillUsageStore = selector => selector({ recentIds: [], remember() {} });
  `);
  const source = compile("../src/hooks/useSkillCommands.ts").replace(/from\s+["']([^"']+)["']/g,
    (_, path) => `from ${JSON.stringify(path === "@/utils/skillCommands" ? utilsUrl : mockUrl)}`);
  const { useSkillCommands } = await import(dataUrl(source));
  const { resetCursor } = await import(mockUrl);
  let draft = "", selected = [];
  const skills = [{ id: "review", name: "代码审查", description: "检查代码", enabled: true, trusted: true }];
  const render = () => {
    resetCursor();
    return useSkillCommands({ draft, skills, selected, onDraft: value => { draft = value; },
      onSelected: value => { selected = value; }, textareaRef: { current: { focus() {} } } });
  };
  return {
    render,
    get draft() { return draft; }, get selected() { return selected; },
    change(value, inputType = "insertText") {
      draft = value;
      render().handleChange({ currentTarget: { value, selectionStart: value.length }, nativeEvent: { inputType } });
      return render();
    }
  };
}

function key(value, extras = {}) {
  return { key: value, nativeEvent: {}, preventDefault() { this.prevented = true; }, ...extras };
}

test("pasting slash-prefixed content does not open the skill menu", async () => {
  const h = await harness();
  h.render().handlePaste();
  assert.equal(h.change("/car_paly/home/", "insertFromPaste").active, false);
  h.render().handlePaste();
  assert.equal(h.change("/review", "insertFromPaste").active, false);
  assert.equal(h.change("/").active, true);
});

test("Escape dismisses the menu without deleting the typed query", async () => {
  const h = await harness();
  const menu = h.change("/审查");
  assert.equal(menu.active, true);
  assert.equal(menu.handleKeyDown(key("Escape")), true);
  assert.equal(h.render().active, false);
  assert.equal(h.draft, "/审查");
});

test("selecting a skill consumes the slash query and creates a removable selection", async () => {
  const h = await harness();
  const menu = h.change("/审查");
  assert.equal(menu.handleKeyDown(key("Enter")), true);
  assert.equal(h.draft, "");
  assert.equal(h.selected[0].id, "review");
  h.render().selectIds([]);
  assert.deepEqual(h.selected, []);
});

test("an unmatched skill query cannot accidentally be sent with Enter", async () => {
  const h = await harness();
  const menu = h.change("/missing");
  const enter = key("Enter");
  assert.equal(menu.handleKeyDown(enter), true);
  assert.equal(enter.prevented, true);
  assert.equal(h.draft, "/missing");
});

test("IME confirmation is left to the input method and does not select or send", async () => {
  const h = await harness();
  const menu = h.change("/审查");
  const enter = key("Enter", { nativeEvent: { isComposing: true } });
  assert.equal(menu.handleKeyDown(enter), true);
  assert.equal(enter.prevented, undefined);
  assert.deepEqual(h.selected, []);
  assert.equal(h.draft, "/审查");
});

test("an attachment paste cannot suppress the next manually typed slash", async () => {
  const h = await harness();
  h.render().handlePaste(); // Attachment handler cancels the default text insertion.
  assert.equal(h.change("/", "insertText").active, true);
});

test("Shift+Tab leaves selection to normal focus navigation", async () => {
  const h = await harness();
  assert.equal(h.change("/").handleKeyDown(key("Tab", { shiftKey: true })), false);
  assert.deepEqual(h.selected, []);
});
