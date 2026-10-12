import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import ts from "typescript";
import { isOfficeEngineFile } from "../dist-electron/officeEngineCore.js";

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL("../electron/contextMenu.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;

function contextMenu(isDev = false) {
  const menus = [];
  const opened = [];
  const inspected = [];
  class Menu {
    constructor() { this.items = []; menus.push(this); }
    append(item) { this.items.push(item); }
    popup() { this.shown = true; }
  }
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    URL,
    require: (name) => {
      if (name.startsWith("node:")) return require(name);
      if (name === "electron") return { Menu, MenuItem: class { constructor(options) { Object.assign(this, options); } } };
      if (name === "./cli/settings.js") return { getLanguage: () => "en" };
      if (name === "./cli/i18n.js") return { tMain: (key) => key };
      if (name === "./officeEngineCore.js") return { isOfficeEngineFile };
      throw new Error(`Unexpected import: ${name}`);
    }
  });
  const webContents = new EventEmitter();
  webContents.inspectElement = (...position) => inspected.push(position);
  exports.setupContextMenu({ webContents }, isDev, (file) => opened.push(file));
  const show = (params = {}) => {
    webContents.emit("context-menu", {}, { selectionText: "", isEditable: false, linkURL: "", editFlags: {}, ...params });
    return menus.at(-1);
  };
  return { show, opened, inspected };
}

test("selected chat text exposes the native Copy role", () => {
  const { show } = contextMenu();
  const menu = show({ selectionText: "Selected response", editFlags: { canCopy: true, canSelectAll: true } });
  assert.equal(menu.shown, true);
  assert.deepEqual(menu.items.map((item) => item.role), ["copy", "selectAll"]);
});

test("unselected or whitespace-only chat text does not show an empty menu", () => {
  const { show } = contextMenu();
  assert.equal(show().shown, undefined);
  assert.equal(show({ selectionText: "  " }).shown, undefined);
  assert.equal(show({ selectionText: "Selected response", editFlags: { canCopy: false } }).shown, undefined);
});

test("editable chat inputs retain native editing and clipboard roles", () => {
  const { show } = contextMenu();
  const menu = show({ isEditable: true, editFlags: { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
  assert.equal(menu.shown, true);
  assert.deepEqual(menu.items.filter((item) => item.role).map((item) => item.role), ["undo", "redo", "cut", "copy", "paste", "selectAll"]);
});

test("shared context menus route Office links through their window's document opener", () => {
  const { show, opened } = contextMenu();
  const file = "/fixture/report.docx";
  const menu = show({ linkURL: `freebuddy-file://open?path=${encodeURIComponent(file)}` });
  assert.equal(menu.shown, true);
  menu.items[0].click();
  assert.deepEqual(opened, [file]);
  assert.equal(show({ linkURL: "file:///fixture/image.png" }).shown, undefined);
});

test("development windows retain Inspect Element in their context menu", () => {
  const { show, inspected } = contextMenu(true);
  const menu = show({ x: 12, y: 34 });
  menu.items[0].click();
  assert.deepEqual(inspected, [[12, 34]]);
});
