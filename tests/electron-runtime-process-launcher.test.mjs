import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

test("Electron utility-process messages reach the runtime host unchanged", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.postMessage = () => {};
  child.kill = () => {};
  globalThis.__freebuddyElectronUtilityProcessFork = () => child;

  try {
    const { createElectronRuntimeProcessLauncher } = await import(
      "../dist-electron/runtime/electronRuntimeProcessLauncher.js"
    );
    const handle = createElectronRuntimeProcessLauncher().launch({
      entryPath: "/runtime/index.mjs",
      env: {}
    });
    const received = [];
    handle.onMessage((message) => received.push(message));

    const hello = { rpcVersion: "1.0.0", id: "hello", kind: "response" };
    child.emit("message", hello);

    assert.deepEqual(received, [hello]);
  } finally {
    delete globalThis.__freebuddyElectronUtilityProcessFork;
  }
});

test("delegation stays in-process unless its runtime bridge is explicitly enabled", async () => {
  const previousRuntimeProcess = process.env.FREEBUDDY_RUNTIME_PROCESS;
  const previousDelegationProcess = process.env.FREEBUDDY_DELEGATION_RUNTIME_PROCESS;
  const previousInProcess = process.env.FREEBUDDY_RUNTIME_IN_PROCESS;
  process.env.FREEBUDDY_RUNTIME_PROCESS = "1";
  delete process.env.FREEBUDDY_RUNTIME_IN_PROCESS;
  delete process.env.FREEBUDDY_DELEGATION_RUNTIME_PROCESS;

  try {
    const { shouldUseDelegationRuntimeProcess } = await import(
      "../dist-electron/runtime/delegationRuntimeClient.js"
    );
    assert.equal(shouldUseDelegationRuntimeProcess(), false);
    process.env.FREEBUDDY_DELEGATION_RUNTIME_PROCESS = "1";
    assert.equal(shouldUseDelegationRuntimeProcess(), true);
  } finally {
    if (previousRuntimeProcess === undefined) delete process.env.FREEBUDDY_RUNTIME_PROCESS;
    else process.env.FREEBUDDY_RUNTIME_PROCESS = previousRuntimeProcess;
    if (previousDelegationProcess === undefined) {
      delete process.env.FREEBUDDY_DELEGATION_RUNTIME_PROCESS;
    } else {
      process.env.FREEBUDDY_DELEGATION_RUNTIME_PROCESS = previousDelegationProcess;
    }
    if (previousInProcess === undefined) delete process.env.FREEBUDDY_RUNTIME_IN_PROCESS;
    else process.env.FREEBUDDY_RUNTIME_IN_PROCESS = previousInProcess;
  }
});
