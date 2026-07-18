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
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
