import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { acpProcessPool } from "../dist-electron/cli/acpProcessPool.js";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch { bindingAvailable = false; }
const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
const { app: testElectronApp } = await import("electron");
const { cliCheck, cliCheckUpdates, prepareCliUpgrade, verifyCliUpgrade, cliInstallStream, startDshAcpAutoUpdate, startRuntimeUpdateChecks, listRuntimes, recordRuntimeAgentVersion, waitForRuntimeInstall } = await import("../dist-electron/cli/check.js");
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
  const agy = path.join(npmDir, "agy");
  fs.writeFileSync(agy, '#!/bin/sh\n[ "$1" = update ] || exit 2\necho "agy update completed"\n', { mode: 0o755 });
  const npm = path.join(npmDir, "npm");
  fs.writeFileSync(npm, `#!${nodeExecutable}\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst args=process.argv.slice(2);\nif(args[0]==='view') { if(process.env.FREEBUDDY_TEST_REGISTRY_OFFLINE){ console.error('registry offline');process.exit(1); } console.log(JSON.stringify('0.3.8')); }\nelse if(args[0]==='install') { const prefix=args[args.indexOf('--prefix')+1]; if(!prefix||prefix!==${JSON.stringify(prefix)}){console.error('wrong install prefix');process.exit(1);} const file=path.join(prefix,'lib/node_modules/agy-acp-bridge/package.json'); const pkg=JSON.parse(fs.readFileSync(file)); pkg.version='0.3.8';fs.writeFileSync(file,JSON.stringify(pkg)); }\nelse {console.error('unexpected fake npm command');process.exit(1);}\n`);
  // This fixture is outside a package scope, so use .mjs via a tiny shell launcher.
  fs.renameSync(npm, npm + ".mjs");
  // Installers strip Electron flags, so the npm fixture needs standalone Node.
  fs.writeFileSync(npm, `#!/bin/sh\nexec '${nodeExecutable.replace(/'/g, `'"'"'`)}' '${(npm + ".mjs").replace(/'/g, `'"'"'`)}' "$@"\n`);
  fs.chmodSync(npm, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = npmDir + path.delimiter + previousPath;
  t.after(() => { process.env.PATH = previousPath; setDbForTest(null); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = { adapter: "agy-acp", binary, env: { PATH: process.env.PATH, AGY_ACP_COMMAND: agy }, force: true };
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
  assert.equal(plan.updatesNativeCli, true);
  assert.ok(plan.command.includes(prefix));
  await assert.rejects(verifyCliUpgrade(request, plan), /runtime_target_not_active/);
  const installed = await cliInstallStream(plan.command, null, request.adapter);
  assert.equal(installed.success, true, installed.stderr);
  assert.match(installed.stdout, /agy update completed/);
  assert.equal(JSON.parse(fs.readFileSync(pkgFile)).version, "0.3.8");
  const verified = await verifyCliUpgrade(request, plan);
  assert.equal(verified.version, "0.3.8");
  assert.equal(verified.path, request.binary);
  assert.equal(listRuntimes()[0].updateStatus, "updated");
});

test("matching version alone is insufficient when ACP initialization fails", { skip }, async t => {
  const { request } = setup(t, { packageVersion: "0.3.8", handshake: false });
  const plan = await prepareCliUpgrade(request);
  assert.equal(plan.alreadyCurrent, undefined);
  assert.equal(plan.updatesNativeCli, true);
  assert.doesNotMatch(plan.command, /npm install/);
  await assert.rejects(verifyCliUpgrade(request, plan), /Unsupported ACP protocol version 999/);
  assert.equal(listRuntimes()[0].installed, false);
  assert.equal(listRuntimes()[0].updateStatus, "error");
});

test("a running task prevents upgrading its shared adapter", { skip }, async t => {
  const { db, request } = setup(t, { packageVersion: "0.3.6" });
  db.prepare("INSERT INTO cli_tasks (id,agent_id,agent_name,adapter,status,prompt,pid,created_at,updated_at) VALUES ('run','clone','Clone','agy-acp','running','',?,'0','0')").run(process.pid);
  await assert.rejects(prepareCliUpgrade(request), /runtime_in_use/);
});

test("a dead task row is closed and does not block upgrade", { skip }, async t => {
  const { db, request } = setup(t, { packageVersion: "0.3.6" });
  db.prepare("INSERT INTO cli_tasks (id,agent_id,agent_name,adapter,status,prompt,pid,created_at,updated_at) VALUES ('dead','clone','Clone','agy-acp','running','',2147483646,'0','0')").run();
  const plan = await prepareCliUpgrade(request);
  assert.equal(plan.targetVersion, "0.3.8");
  assert.equal(db.prepare("SELECT status FROM cli_tasks WHERE id = 'dead'").get().status, "failed");
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

function setupNative(t, { version = "1.5.8", acp = true, handshake = true } = {}) {
  const fixture = setup(t);
  const binary = path.join(fixture.root, "native", "agy");
  const versionFile = path.join(fixture.root, "native", "version");
  fs.mkdirSync(path.dirname(binary));
  fs.writeFileSync(versionFile, version);
  const node = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
  fs.writeFileSync(binary, `#!${node}
import fs from 'node:fs';import readline from 'node:readline';
const file=${JSON.stringify(versionFile)};
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log(fs.readFileSync(file,'utf8'));process.exit(0);}
if(args[0]==='update'){fs.writeFileSync(file,'1.5.9');console.log('native update completed');process.exit(0);}
if(args[0]==='acp'&&args[1]==='--help'){console.log(${JSON.stringify(acp ? "Start the Agent Client Protocol (ACP) stdio server" : "Unknown command acp")});process.exit(${acp ? 0 : 1});}
if(args[0]!=='acp'||!args.includes('--process-per-session'))process.exit(2);
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:${handshake ? 1 : 999},agentInfo:{name:'Antigravity ACP Server',version:fs.readFileSync(file,'utf8')},agentCapabilities:{}}}));});
`, { mode: 0o755 });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(url, "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest");
    return { ok: true, json: async () => ({ tag_name: "1.5.9" }) };
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  return { ...fixture, binary, versionFile, request: { adapter: "agy-acp", binary, env: { PATH: process.env.PATH }, force: true } };
}

test("native detection checks ACP support and reports the native minimum version", { skip }, async t => {
  const { request } = setupNative(t);
  const detected = await cliCheck(request.adapter, request.binary, request.env);
  assert.equal(detected.version, "1.5.8");
  assert.equal(listRuntimes()[0].minimumVersion, "1.5.9");
  assert.equal(listRuntimes()[0].updateCheckSupported, true);
});

test("native detection rejects an old CLI that has no ACP command", { skip }, async t => {
  const { request } = setupNative(t, { acp: false });
  assert.equal((await cliCheck(request.adapter, request.binary, request.env)).installed, false);
  assert.match(listRuntimes()[0].lastError, /requires native ACP/);
  const plan = await prepareCliUpgrade(request);
  assert.match(plan.command, /update$/);
  assert.doesNotMatch(plan.command, /npm/);
});

test("native upgrade checks official releases, updates the selected binary and verifies ACP", { skip }, async t => {
  const { request, binary } = setupNative(t);
  let disposed = false;
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null,
    stdin: { destroyed: false }, stdout: { resume() {} }, stderr: { resume() {} } });
  acpProcessPool.put("upgrade-test", { child, fingerprint: "old-engine", conversationId: "test", requestId: 0,
    dispose: () => { disposed = true; } });
  t.after(() => acpProcessPool.dispose());
  const plan = await prepareCliUpgrade(request);
  assert.equal(plan.targetVersion, "1.5.9");
  assert.equal(plan.expectedBinaryPath, binary);
  assert.equal(plan.updatesNativeCli, true);
  assert.doesNotMatch(plan.command, /npm install|agy-acp-bridge/);
  await assert.rejects(verifyCliUpgrade(request, plan), /runtime_target_not_active/);
  const installed = await cliInstallStream(plan.command, null, request.adapter, "native-upgrade");
  assert.equal(installed.success, true, installed.stderr);
  assert.equal(disposed, true, "upgrading must discard idle workers running the old engine");
  assert.equal((await verifyCliUpgrade(request, plan)).version, "1.5.9");
});

test("native self-update remains available when release checks are offline", { skip }, async t => {
  const { request } = setupNative(t);
  globalThis.fetch = async () => { throw new Error("release network offline"); };
  assert.equal((await cliCheckUpdates(request)).installed, true);
  assert.equal(listRuntimes()[0].updateStatus, "error");
  const plan = await prepareCliUpgrade(request);
  assert.match(plan.command, /update$/);
  assert.equal(plan.targetVersion, "1.5.9");
});

test("switching from a bridge runtime clears its npm release cache", { skip }, async t => {
  const { request, db } = setupNative(t);
  db.prepare("INSERT INTO cli_runtimes (adapter,installed,binary_path,version,latest_version,update_status,last_update_check_at,updated_at) VALUES ('agy-acp',1,'/old/agy-acp','0.3.8','0.3.9','available','today','today')").run();
  globalThis.fetch = async () => { throw new Error("offline"); };
  await cliCheckUpdates(request);
  const runtime = listRuntimes()[0];
  assert.equal(runtime.version, "1.5.8");
  assert.equal(runtime.latestVersion, undefined);
  assert.equal(runtime.updateStatus, "error");
});

test("native upgrade verification fails when the ACP handshake is broken", { skip }, async t => {
  const { request } = setupNative(t, { version: "1.5.9", handshake: false });
  const plan = await prepareCliUpgrade(request);
  await assert.rejects(verifyCliUpgrade(request, plan), /Unsupported ACP protocol version 999/);
  assert.equal(listRuntimes()[0].installed, false);
});

test("startup migrates cached bridge paths while preserving explicit bridge overrides", { skip }, async t => {
  const { binary, db } = setupNative(t);
  process.env.PATH = path.dirname(binary) + path.delimiter + process.env.PATH;
  db.prepare("INSERT INTO cli_runtimes (adapter,installed,binary_path,version,updated_at) VALUES ('agy-acp',1,'/old/agy-acp','0.3.8','today')").run();
  await startRuntimeUpdateChecks();
  assert.equal(listRuntimes()[0].binaryPath, binary);
  assert.equal(listRuntimes()[0].version, "1.5.8");
  const bridge = path.join(path.dirname(path.dirname(binary)), "selected", "bin", "agy-acp");
  db.prepare("INSERT INTO cli_executor_overrides (id,binary,updated_at) VALUES ('agy-acp',?,'today')").run(bridge);
  await startRuntimeUpdateChecks();
  assert.equal(listRuntimes()[0].binaryPath, bridge);
  assert.equal(listRuntimes()[0].version, "0.3.6");
});

test("native upgrades never accept a downgrade when an installed release is newer than the API", { skip }, async t => {
  const { request } = setupNative(t, { version: "1.6.0" });
  const plan = await prepareCliUpgrade(request);
  assert.equal(plan.targetVersion, "1.6.0");
});

// Bare package requests deliberately resolve to the stale cached version.
// Only an explicit version/latest request can advance this managed runtime.
function writeDshPackage(root, version) {
  const directory = path.join(root, "node_modules", "deepseek-harness-acp");
  fs.mkdirSync(path.join(directory, "lib"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
    name: "deepseek-harness-acp", type: "module", version,
    dependencies: { "@deepseek-ai/dsh-base": "0.1.6-alpha.2" }
  }));
  fs.writeFileSync(path.join(directory, "lib", "bin.js"), `import fs from 'node:fs';
import readline from 'node:readline';
const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url)));
readline.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);
  if(r.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:1,agentInfo:{name:pkg.name,version:pkg.version},agentCapabilities:{}}}));
});`);
  for (const name of ["dsh-base", "dsh-acp", "dsh-app-boot"]) {
    const plugin = path.join(root, "node_modules", "@deepseek-ai", name);
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, "package.json"), "{}");
  }
}

function setupDsh(t) {
  const fixture = setup(t);
  const previousGetPath = testElectronApp.getPath;
  testElectronApp.getPath = () => fixture.root;
  const previousShell = process.env.SHELL;
  // Keep the mock npm on PATH for the non-streaming automatic installer.
  const shell = path.join(fixture.root, "test-shell");
  fs.writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n', { mode: 0o755 });
  process.env.SHELL = shell;
  t.after(() => {
    testElectronApp.getPath = previousGetPath;
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
  });
  const managed = path.join(fixture.root, "freebuddy", "runtimes", "dsh-acp");
  writeDshPackage(managed, "0.1.27");
  fs.writeFileSync(path.join(managed, "package.json"), JSON.stringify({ dependencies: { "deepseek-harness-acp": "^0.1.27" } }));
  fs.writeFileSync(path.join(managed, "package-lock.json"), "{}");
  const captured = path.join(fixture.root, "npm-args.json");
  fs.writeFileSync(path.join(fixture.root, "npm-bin", "npm.mjs"), `import fs from 'node:fs'; import path from 'node:path';
${writeDshPackage.toString()}
const args=process.argv.slice(2);
if(args[0]==='view') console.log(JSON.stringify('0.1.31'));
else if(args[0]==='install') {
  const prefix=args[args.indexOf('--prefix')+1];
  if(prefix!==${JSON.stringify(managed)}) throw new Error('wrong managed destination');
  fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify(args));
  const spec=args.find(value=>value.startsWith('deepseek-harness-acp@'));
  const version=spec?.split('@')[1];
  writeDshPackage(prefix,version==='latest'?'0.1.31':version||'0.1.27');
} else throw new Error('unexpected npm command');`);
  return { managed, captured, request: { adapter: "dsh-acp", cwd: fixture.root } };
}

for (const automatic of [false, true]) test(`DSH ${automatic ? "automatic" : "manual streaming"} upgrade installs the checked target despite stale metadata`, { skip }, async t => {
  const { managed, captured, request } = setupDsh(t);
  assert.equal((await cliCheck(request.adapter)).version, "0.1.27");
  if (automatic) {
    await startDshAcpAutoUpdate();
  } else {
    const plan = await prepareCliUpgrade(request);
    assert.equal(plan.targetVersion, "0.1.31");
    assert.match(plan.command, /deepseek-harness-acp@0\.1\.31/);
    assert.ok(plan.command.includes(managed));
    await assert.rejects(cliInstallStream(plan.command, null, request.adapter, "invalid", "0.1.31; echo unsafe"), /Invalid.*target version/);
    assert.equal((await cliCheck(request.adapter)).version, "0.1.27", "invalid input must not remove the working install");
    const installed = await cliInstallStream(plan.command, null, request.adapter, "dsh-upgrade", plan.targetVersion);
    assert.equal(installed.success, true, installed.stderr);
    const verified = await verifyCliUpgrade(request, plan);
    assert.equal(verified.version, "0.1.31");
    assert.equal(verified.path, plan.expectedBinaryPath);
  }
  const args = JSON.parse(fs.readFileSync(captured));
  assert.ok(args.includes("deepseek-harness-acp@0.1.31"));
  assert.ok(args.includes("--offline=false"));
  assert.ok(args.includes("--prefer-online"));
  const runtime = listRuntimes().find(runtime => runtime.adapter === request.adapter);
  assert.equal(runtime.version, "0.1.31");
  assert.equal(runtime.updateStatus, "updated", runtime.lastUpdateError);
  assert.equal(runtime.binaryPath, path.join(managed, "node_modules", "deepseek-harness-acp", "lib", "bin.js"));
});
