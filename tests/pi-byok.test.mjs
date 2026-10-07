import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as React from "react";
import { PI_BYOK_EXTENSION_SOURCE } from "../dist-electron/cli/piRuntime.js";

// Exercise the editor's actual JSX, change handlers, and save builder without
// loading its unrelated stores or requiring a browser/native app session.
const source = ts.createSourceFile(
  "CLIAdaptersTab.tsx",
  fs.readFileSync(new URL("../src/components/Settings/CLIAdaptersTab.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
const helperNames = new Set(["parseByokContextWindow", "extractModelArg", "withModelArg"]);
const helpers = source.statements
  .filter(node => ts.isFunctionDeclaration(node) && helperNames.has(node.name?.text))
  .map(node => node.getText(source));
let saveBuilder;
let modelList;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "buildOverride") {
    saveBuilder = node.initializer.getText(source);
  }
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(
    attr => ts.isJsxAttribute(attr) && attr.name.getText(source) === "className" &&
      attr.initializer?.getText(source) === '"byok-model-list"'
  )) modelList = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(saveBuilder && modelList, "Pi editor save builder and model list must exist");
const editorScript = new vm.Script(ts.transpileModule(`
  const BYOK_CONTEXT_WINDOW_MIN = 100000;
  const BYOK_CONTEXT_WINDOW_MAX = 1000000;
  ${helpers.join("\n")}
  const save = ${saveBuilder};
  const render = () => (${modelList});
  ({ save, render });
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText);

function editor(models, overrides = {}) {
  const state = {
    React, Plus: () => null, Trash2: () => null, t: key => key,
    isPi: true, isCodex: false, isDeepSeek: false, isClaude: false,
    isClone: false, ex: { id: "user-pi", baseAdapter: "pi-acp", enabled: true },
    label: "Pi", binary: "", extraArgs: "", model: "", envText: "", icon: "", skillIds: [],
    codexByokEnabled: true, codexBaseUrl: "https://relay.example.test/v1",
    codexEnvKey: "OPENAI_API_KEY", codexApiKey: "", byokContextWindow: "",
    savedPiByok: {}, selectedProvider: undefined, selectedProviderId: undefined,
    byokModels: models.map(model => ({ ...model })),
    ...overrides
  };
  state.setByokModels = update => { state.byokModels = update(state.byokModels); };
  const { render, save } = editorScript.runInNewContext(state);
  return { state, render, save: () => JSON.parse(JSON.stringify(save())) };
}

function findElements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => findElements(child, predicate));
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...findElements(node.props.children, predicate)];
}
const imageControls = view => findElements(view.render(), node => node.type === "input" && node.props.type === "checkbox");

function registerModels(config) {
  let provider;
  vm.runInNewContext(
    PI_BYOK_EXTENSION_SOURCE.replace("export default function (pi)", "function register(pi)") + "\nregister(pi);",
    {
      process: { env: { FREEBUDDY_PI_BYOK: JSON.stringify(config) } },
      pi: { registerProvider: (_id, value) => { provider = value; } }
    }
  );
  return JSON.parse(JSON.stringify(provider.models));
}

test("direct Pi BYOK exposes per-model image controls and saves enabled and disabled capabilities", () => {
  const view = editor([
    { id: "cline-free/mimo-v2.6-flash" },
    { id: "deepseek/deepseek-v4-flash" }
  ]);
  const controls = imageControls(view);
  assert.equal(controls.length, 2);
  assert.ok(controls.every(control => !control.props.disabled && !control.props.checked));
  controls[0].props.onChange({ target: { checked: true } });
  assert.deepEqual(imageControls(view).map(control => control.props.checked), [true, false]);

  const saved = view.save().piByok;
  assert.equal(saved.providerId, "custom");
  assert.deepEqual(saved.models.map(model => model.supportsVision), [true, false]);
  assert.deepEqual(registerModels(saved).map(model => model.input), [["text", "image"], ["text"]]);

  const reopened = editor(saved.models);
  assert.deepEqual(imageControls(reopened).map(control => control.props.checked), [true, false]);
  imageControls(reopened)[0].props.onChange({ target: { checked: false } });
  assert.deepEqual(registerModels(reopened.save().piByok).map(model => model.input), [["text"], ["text"]]);
});

test("legacy and newly added Pi models remain text-only until images are explicitly enabled", () => {
  const view = editor([{ id: "legacy-model" }]);
  const add = findElements(view.render(), node => node.props.className === "byok-model-add")[0];
  add.props.onClick();
  assert.deepEqual(imageControls(view).map(control => control.props.checked), [false, false]);
  assert.equal(view.save().piByok.models[0].supportsVision, false);
  assert.deepEqual(registerModels({ enabled: true, models: [{ id: "legacy-model" }] })[0].input, ["text"]);
});

test("provider-backed Pi models retain their vision flags and use read-only controls", () => {
  const models = [{ id: "vision-model", supportsVision: true }, { id: "text-model", supportsVision: false }];
  const view = editor(models, { selectedProviderId: "provider-test", selectedProvider: { models } });
  assert.ok(imageControls(view).every(control => control.props.disabled));
  assert.deepEqual(imageControls(view).map(control => control.props.checked), [true, false]);
  assert.deepEqual(view.save().piByok.models, models);
});

test("direct Pi BYOK vision flags survive database save, reload, and runtime env resolution without a provider", async t => {
  let db;
  try {
    const { default: Database } = await import("better-sqlite3");
    db = new Database(":memory:");
  } catch {
    t.skip("better-sqlite3 native binding unavailable under this Node; run with scripts/run-electron-node-test.mjs");
    return;
  }
  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  const store = await import("../dist-electron/cli/store.js");
  setDbForTest(db);
  t.after(() => { setDbForTest(null); db.close(); });
  migrate(db);
  const view = editor([{ id: "vision-model", supportsVision: true }, { id: "text-model", supportsVision: false }]);
  store.upsertOverride(view.save());
  const saved = store.listOverrides().find(item => item.id === "user-pi").piByok;
  assert.deepEqual(saved.models, view.save().piByok.models);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM providers").get().count, 0);
  const env = store.resolvePiByokEnv("cli-user-pi", "pi-acp");
  const config = JSON.parse(env.FREEBUDDY_PI_BYOK);
  assert.deepEqual(registerModels(config).map(model => model.input), [["text", "image"], ["text"]]);
});
