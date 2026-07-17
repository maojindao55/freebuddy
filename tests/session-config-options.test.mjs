import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadModule() {
  const source = fs.readFileSync(
    new URL("../src/utils/sessionConfigOptions.ts", import.meta.url),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
}

const sample = [
  {
    id: "mode",
    category: "mode",
    currentValue: "ask",
    values: [{ id: "ask", name: "Ask" }]
  },
  {
    id: "model",
    category: "model",
    currentValue: "m1",
    currentLabel: "Model 1",
    values: [
      { id: "m1", name: "Model 1" },
      { id: "m2", name: "Model 2" }
    ]
  },
  {
    id: "effort",
    category: "model_config",
    currentValue: "low",
    values: [
      { id: "low", name: "Low" },
      { id: "high", name: "High" }
    ]
  },
  {
    id: "think",
    category: "thought_level",
    currentValue: "medium",
    values: [{ id: "medium", name: "Medium" }]
  },
  {
    id: "model",
    currentValue: "legacy-id-only",
    values: [{ id: "legacy-id-only", name: "Legacy" }]
  }
];

test("filters picker categories and id===model fallback", async () => {
  const { filterSessionConfigPickerOptions } = await loadModule();
  const filtered = filterSessionConfigPickerOptions(sample);
  assert.deepEqual(
    filtered.map((o) => `${o.id}:${o.category ?? ""}`),
    ["model:model", "effort:model_config", "think:thought_level", "model:"]
  );
});

test("does not invent unsupported thought levels", async () => {
  const { filterSessionConfigPickerOptions } = await loadModule();
  const filtered = filterSessionConfigPickerOptions(sample);
  const think = filtered.find((o) => o.category === "thought_level");
  assert.deepEqual(think?.values?.map((v) => v.id), ["medium"]);
});

test("display value prefers override", async () => {
  const { displayConfigOptionValue } = await loadModule();
  const model = sample[1];
  assert.equal(displayConfigOptionValue(model, {}), "m1");
  assert.equal(displayConfigOptionValue(model, { model: "m2" }), "m2");
});

test("prunes overrides to available option ids", async () => {
  const { pruneConfigOptionOverrides } = await loadModule();
  const pruned = pruneConfigOptionOverrides(
    { model: "m2", gone: "x", effort: "high" },
    sample
  );
  assert.deepEqual(pruned, { model: "m2", effort: "high" });
});

test("drops stale synthetic none but keeps agent-advertised none", async () => {
  const {
    displayConfigOptionValue,
    pruneConfigOptionOverrides,
    resolveConfigOptionOverrides
  } = await loadModule();
  const unsupported = sample.find((o) => o.category === "thought_level");
  assert.equal(
    displayConfigOptionValue(unsupported, { think: "none" }),
    "medium"
  );
  assert.deepEqual(pruneConfigOptionOverrides({ think: "none" }, sample), {});
  assert.equal(
    resolveConfigOptionOverrides({ think: "none" }, sample),
    undefined
  );

  const advertised = {
    ...unsupported,
    values: [{ id: "none", name: "Off" }, ...(unsupported.values ?? [])]
  };
  assert.equal(displayConfigOptionValue(advertised, { think: "none" }), "none");
  assert.deepEqual(
    pruneConfigOptionOverrides({ think: "none" }, [advertised]),
    { think: "none" }
  );
});

test("preserves overrides until config options are known", async () => {
  const { resolveConfigOptionOverrides } = await loadModule();
  assert.deepEqual(resolveConfigOptionOverrides({ think: "none" }, []), {
    think: "none"
  });
});

test("clears overrides that match current agent values", async () => {
  const { reconcileConfigOptionOverrides } = await loadModule();
  assert.deepEqual(
    reconcileConfigOptionOverrides({ model: "m1", effort: "high" }, sample),
    { effort: "high" }
  );
});
