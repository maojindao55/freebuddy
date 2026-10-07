import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { bindingAvailable = false; }
const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
const { cliCheck, cliCheckUpdates, prepareCliUpgrade, verifyCliUpgrade, cliInstallStream, listRuntimes, recordRuntimeAgentVersion, waitForRuntimeInstall } = await import("../dist-electron/cli/check.js");
// Process fixtures use executable symlinks. The Windows shim identity is
// covered separately by cli-runtime-update.test.mjs on every platform.
const skip = !bindingAvailable || process.platform === "win32";

function setup(t, { output = "0.3.6", packageVersion, handshake = true } = {}) {
  const nodeExecutable = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
  const db = new Database(":memory:");
  migrate(db);
  setDbForTest(db);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy runtime update ")));
  const prefix = path.join(root, "selected");
  const directory = path.join(prefix, "lib/node_modules/agy-acp-bridge");
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(prefix, "bin"));
  const pkgFile = path.join(directory, "package.json");
  fs.writeFileSync(pkgFile, JSON.stringify({ name: "agy-acp-bridge", type: "module", ...(packageVersion ? { version: packageVersion } : {}) }));
  const entry = path.join(directory, "index.js");
  fs.writeFileSync(entry, `#!${nodeExecutable}\nimport fs from 'node:fs';\nimport readline from 'node:readline';\nconst pkg=()=>JSON.parse(fs.readFileSync(new URL('./package.json',import.meta.url)));\nif(process.argv.includes('--version')) { console.log(pkg().version ?? ${JSON.stringify(output)}); process.exit(0); }\nconst lines=readline.createInterface({input:process.stdin});\nlines.on('line',line=>{ const r=JSON.parse(line); if(r.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:${handshake ? "1" : "999"},agentInfo:{name:'agy-acp',version:pkg().version},agentCapabilities:{}}})); });\n`);
  fs.chmodSync(entry, 0o755);
  const binary = path.join(prefix, "bin/agy-acp");
  fs.symlinkSync(entry, binary);
  const npmDir = path.join(root, "npm-bin");
  fs.mkdirSync(npmDir);
  const npm = path.join(npmDir, "npm");
  fs.writeFileSync(npm, `#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst args=process.argv.slice(2);\nif(args[0]==='view') { if(process.env.FREEBUDDY_TEST_REGISTRY_OFFLINE){ console.error('registry offline');process.exit(1); } console.log(JSON.stringify('0.3.8')); }\nelse if(args[0]==='install') { const prefix=args[args.indexOf('--prefix')+1]; if(!prefix||prefix!==${JSON.stringify(prefix)}){console.error('wrong install prefix');process.exit(1);} const file=path.join(prefix,'lib/node_modules/agy-acp-bridge/package.json'); const pkg=JSON.parse(fs.readFileSync(file)); pkg.version='0.3.8';fs.writeFileSync(file,JSON.stringify(pkg)); }\nelse {console.error('unexpected fake npm command');process.exit(1);}\n`);
  // This fixture is outside a package scope, so use .mjs via a tiny shell launcher.
  fs.renameSync(npm, npm + ".mjs");
  fs.writeFileSync(npm, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'"'"'`)}' '${(npm + ".mjs").replace(/'/g, `'"'"'`)}' "$@"\n`);
  fs.chmodSync(npm, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = npmDir + path.delimiter + previousPath;
  t.after(() => { process.env.PATH = previousPath; setDbForTest(null); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = { adapter: "agy-acp", binary, env: { PATH: process.env.PATH }, force: true };
  return { db, root, prefix, pkgFile, binary, request };
}

test("Antigravity's optional probe is persisted even without package metadata", { skip }, async t => {
  const { request } = setup(t);
  assert.equal((await cliCheck(request.adapter, request.binary, request.env)).version, "0.3.6");
  assert.equal(listRuntimes()[0].version, "0.3.6");
  assert.equal(listRuntimes()[0].minimumVersion, "0.3.8");
});

test("initialize fills an unknown version and a later empty probe preserves it", { skip }, async t => {
  const { request } = setup(t, { output: "Usage: agy-acp" });
  await cliCheck(request.adapter, request.binary, request.env);
  recordRuntimeAgentVersion("agy-acp", "0.3.6", request.binary);
  await cliCheck(request.adapter, request.binary, request.env);
  assert.equal(listRuntimes()[0].version, "0.3.6");
});

test("registry errors leave the installed agent usable", { skip }, async t => {
  const { request } = setup(t, { packageVersion: "0.3.6" });
  const runtime = await cliCheckUpdates({ ...request, env: { ...request.env, FREEBUDDY_TEST_REGISTRY_OFFLINE: "1" } });
  assert.equal(runtime.installed, true);
  assert.equal(runtime.version, "0.3.6");
  assert.equal(runtime.updateStatus, "error");
});

test("upgrade pins the selected npm prefix and verifies the new version and ACP handshake", { skip }, async t => {
  const { request, prefix, pkgFile } = setup(t, { packageVersion: "0.3.6" });
  const plan = await prepareCliUpgrade(request);
  assert.equal(plan.targetVersion, "0.3.8");
  assert.match(plan.command, /agy-acp-bridge@0\.3\.8/);
  assert.ok(plan.command.includes(prefix));
  await assert.rejects(verifyCliUpgrade(request, plan), /runtime_target_not_active/);
  const installed = await cliInstallStream(plan.command, null, request.adapter);
  assert.equal(installed.success, true, installed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(pkgFile)).version, "0.3.8");
  const verified = await verifyCliUpgrade(request, plan);
  assert.equal(verified.version, "0.3.8");
  assert.equal(verified.path, request.binary);
  assert.equal(listRuntimes()[0].updateStatus, "updated");
});

test("matching version alone is insufficient when ACP initialization fails", { skip }, async t => {
  const { request } = setup(t, { packageVersion: "0.3.8", handshake: false });
  const plan = await prepareCliUpgrade(request);
  assert.equal(plan.alreadyCurrent, true);
  await assert.rejects(verifyCliUpgrade(request, plan), /Unsupported ACP protocol version 999/);
  assert.equal(listRuntimes()[0].installed, false);
  assert.equal(listRuntimes()[0].updateStatus, "error");
});

test("a running task prevents upgrading its shared adapter", { skip }, async t => {
  const { db, request } = setup(t, { packageVersion: "0.3.6" });
  db.prepare("INSERT INTO cli_tasks (id,agent_id,agent_name,adapter,status,prompt,created_at,updated_at) VALUES ('run','clone','Clone','agy-acp','running','','0','0')").run();
  await assert.rejects(prepareCliUpgrade(request), /runtime_in_use/);
});

test("shared installation blocks a second installer and defers runtime checks and launches", { skip }, async t => {
  const { root, request } = setup(t, { packageVersion: "0.3.6" });
  const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
  const marker = path.join(root, "started");
  const release = path.join(root, "released");
  const script = path.join(root, "slow-install.sh");
  fs.writeFileSync(script, `printf started > ${quote(marker)}\ni=0\nwhile [ ! -f ${quote(release)} ]; do\n  i=$((i + 1))\n  [ "$i" -lt 200 ] || exit 1\n  sleep 0.05\ndone\n`);
  const installation = cliInstallStream(`sh ${quote(script)}`, null, request.adapter);
  try {
    for (let i = 0; !fs.existsSync(marker) && i < 100; i++) await delay(20);
    assert.ok(fs.existsSync(marker), "installer did not start");
    await assert.rejects(cliInstallStream("true", null, request.adapter), /runtime_install_in_progress/);
    let launched = false, checked = false;
    const launch = waitForRuntimeInstall(request.adapter).then(() => { launched = true; });
    const check = cliCheck(request.adapter, request.binary, request.env).then(() => { checked = true; });
    await delay(20);
    assert.equal(launched, false);
    assert.equal(checked, false);
    fs.writeFileSync(release, "");
    assert.equal((await installation).success, true);
    await Promise.all([launch, check]);
    assert.equal(launched, true);
    assert.equal(checked, true);
  } finally {
    fs.writeFileSync(release, "");
    await installation;
  }
});
