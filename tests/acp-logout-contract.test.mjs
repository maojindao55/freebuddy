import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

const auth = read("../electron/cli/acpAuth.ts");
const ipc = read("../electron/cli/ipc.ts");
const preload = read("../electron/preload.ts");
const settings = read("../src/components/Settings/CLIAdaptersTab.tsx");

test("logout is gated by the official agent auth capability", () => {
  assert.match(auth, /agentCapabilities\?\.auth\?\.logout == null/);
  assert.match(auth, /buildLogoutRequest\(2\)/);
});

test("renderer exposes authentication probing and logout only when supported", () => {
  assert.match(ipc, /"cli:probeAuthentication"/);
  assert.match(ipc, /"cli:logout"/);
  assert.match(preload, /probeAuthentication/);
  assert.match(preload, /logout/);
  assert.match(settings, /authProbe\?\.logoutSupported/);
  assert.match(settings, /cliClient\.logout/);
});
