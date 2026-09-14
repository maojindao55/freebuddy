import { spawnSync } from "node:child_process";

import electronPath from "electron";

const testFiles = process.argv.slice(2);
if (testFiles.length === 0) {
  console.error("Usage: run-electron-node-test.mjs <test-file> [...test-files]");
  process.exit(2);
}

const result = spawnSync(
  electronPath,
  ["--test", "--test-force-exit", ...testFiles],
  {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  }
);

if (result.error) {
  // Keep diagnostic output on stderr. This runner never prints test input,
  // credentials, or relay frames, so node:test assertion stacks stay useful
  // without exposing remote payloads.
  console.error(result.error.stack || result.error.message);
  process.exit(1);
}
if (result.signal) {
  console.error(`Electron node:test terminated by ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
