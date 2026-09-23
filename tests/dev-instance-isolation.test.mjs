import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relPath) => fs.readFileSync(new URL(relPath, import.meta.url), "utf8");

test("main.ts and App.tsx show dev badge and isolate userData in dev mode", () => {
  const main = read("../electron/main.ts");
  const app = read("../src/App.tsx");
  const css = read("../styles.css");

  assert.match(main, /if\s*\(!app\.isPackaged\)\s*\{/);
  assert.match(main, /readOnlyRemoteDevelopment \? "FreeBuddy Read-only Remote Dev" : "FreeBuddy Dev"/);
  assert.match(main, /:\s*path\.join\(app\.getPath\("appData"\),\s*"freebuddy-dev"\)\)/);
  assert.match(main, /readOnlyRemoteDevelopment \? "dev\.freebuddy\.app\.readonly-remote" : "dev\.freebuddy\.app\.dev"/);
  assert.match(main, /title:\s*app\.isPackaged\s*\?\s*APP_NAME\s*:\s*`\$\{APP_NAME\}\s*\[DEV\]`/);

  assert.match(app, /document\.title\s*=\s*"FreeBuddy \[DEV\]"/);
  assert.match(app, /sidebar-dev-badge/);
  assert.match(css, /\.sidebar-dev-badge/);
});

test("explicit read-only remote development uses only the fixed isolated userData path", () => {
  const main = read("../electron/main.ts");
  const launcher = read("../scripts/dev-readonly-remote-electron.mjs");

  assert.match(main, /!app\.isPackaged\s*&&\s*process\.env\.FB_REMOTE_READONLY_DEV\s*===\s*"1"/);
  assert.match(main, /fs\.realpathSync\(path\.resolve\(process\.cwd\(\)\)\)/);
  assert.match(main, /fs\.existsSync\(path\.join\(repositoryRoot, "package\.json"\)\)/);
  assert.match(main, /path\.resolve\(repositoryRoot, "\.local", "readonly-remote-desktop-user-data"\)/);
  assert.match(main, /path\.relative\(repositoryRoot, userDataPath\)/);
  assert.match(main, /\? readOnlyRemoteDevelopmentUserDataPath\(\)\s*:\s*path\.join\(app\.getPath\("appData"\), "freebuddy-dev"\)/);
  assert.doesNotMatch(launcher, /--user-data-dir=/);
  assert.match(launcher, /FB_REMOTE_READONLY_DEV: "1"/);
  assert.match(launcher, /FB_REMOTE_DEV_HOST_TOKEN: relayEnv\.DEV_AUTH_HOST_TOKEN/);
  assert.doesNotMatch(launcher, /console\.(?:log|error)\([^\n]*DEV_AUTH_HOST_TOKEN/);
});
