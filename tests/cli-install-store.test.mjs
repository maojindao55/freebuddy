import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadStore(t, { preparationError, verificationError, alreadyCurrent = false } = {}) {
  const key = `__freebuddyInstallTest_${Math.random()}`;
  const calls = [];
  const resolved = { id: "custom-agy", baseAdapter: "agy-acp", binary: "/selected/npm/bin/agy-acp", defaultBinary: "agy-acp", installHint: "npm install -g agy-acp-bridge", extraArgs: [], runtime: { installed: true, version: "0.3.6" } };
  const executor = {
    resolve: () => resolved,
    check: async () => { calls.push("check"); resolved.runtime.version = "0.3.8"; },
    refreshRuntimes: async () => { calls.push("refresh"); }
  };
  globalThis[key] = {
    client: {
      isAvailable: () => true,
      prepareUpgrade: async request => {
        calls.push(["prepare", request.adapter, request.runtimeAdapter]);
        assert.equal(request.binary, resolved.binary);
        if (preparationError) throw new Error(preparationError);
        return { command: "npm install -g agy-acp-bridge@0.3.8", previousVersion: "0.3.6", targetVersion: "0.3.8", alreadyCurrent };
      },
      installStream: (adapter, command, cb) => {
        calls.push(["install", adapter, command]);
        queueMicrotask(() => cb({ type: "done", exitCode: 0 }));
        return () => {};
      },
      verifyUpgrade: async () => { calls.push("verify"); if (verificationError) throw new Error(verificationError); }
    },
    executor: { getState: () => executor }
  };
  t.after(() => { delete globalThis[key]; });
  const url = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const clientUrl = url(`export const cliClient=globalThis[${JSON.stringify(key)}].client;`);
  const executorUrl = url(`export const useCliExecutorStore=globalThis[${JSON.stringify(key)}].executor;`);
  const source = ts.transpileModule(fs.readFileSync(new URL("../src/store/cliInstallStore.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText
    .replaceAll('"zustand"', JSON.stringify(import.meta.resolve("zustand")))
    .replaceAll('"@/services/cli/client"', JSON.stringify(clientUrl))
    .replaceAll('"@/store/cliExecutorStore"', JSON.stringify(executorUrl));
  const { useCliInstallStore } = await import(url(source));
  const completion = new Promise(resolve => {
    const off = useCliInstallStore.subscribe(state => { if (state.jobs[0]?.done) { off(); resolve(state.jobs[0]); } });
  });
  useCliInstallStore.getState().startJob({ adapterId: resolved.id, label: "Custom Antigravity", command: resolved.installHint });
  return { job: await completion, calls };
}

test("a cloned agent upgrades its base package and verifies before reporting success", async t => {
  const { job, calls } = await loadStore(t);
  assert.equal(job.phase, "succeeded");
  assert.equal(job.verifiedVersion, "0.3.8");
  assert.deepEqual(calls[0], ["prepare", "agy-acp", "custom-agy"]);
  assert.equal(calls[1][1], "agy-acp");
  assert.ok(calls.indexOf("verify") > calls.indexOf("check"));
});

test("exit code zero and installed=true cannot mask an ineffective upgrade", async t => {
  const { job } = await loadStore(t, { verificationError: "runtime_target_not_active" });
  assert.equal(job.phase, "verification_failed");
  assert.match(job.verificationError, /runtime_target_not_active/);
});

test("failed version lookup never starts the installer", async t => {
  const { job, calls } = await loadStore(t, { preparationError: "runtime_update_check_failed" });
  assert.equal(job.phase, "preparation_failed");
  assert.equal(calls.length, 1);
});

test("an already current package is verified without reinstalling", async t => {
  const { job, calls } = await loadStore(t, { alreadyCurrent: true });
  assert.equal(job.phase, "succeeded");
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === "install"), false);
  assert.ok(calls.includes("verify"));
});
