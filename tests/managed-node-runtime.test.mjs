import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import spawn from "cross-spawn";
import { spawn as spawnProcess } from "node:child_process";
import { applyManagedNodeEnvironment, ensureManagedNodeRuntime, getManagedNodeRuntime, setManagedNodeRuntime } from "../dist-electron/cli/managedNodeRuntime.js";
import { resolveNodeBinaryHint, resolveCodexBinaryHint } from "../dist-electron/cli/codexBinaryHint.js";
import { ensurePiAcpLauncher, resolvePiAcpRuntime, piCliEntryForRoot } from "../dist-electron/cli/piRuntime.js";
import { createAcpTerminalManager } from "../dist-electron/cli/acpTerminal.js";
import { NODE_REQUIRED_FILES, NODE_VERSION, validateNodePackage, verifyPackagedNodeRuntime } from "../scripts/managed-node-package.mjs";
let Database;
try {
  const candidate = (await import("better-sqlite3")).default;
  new candidate(":memory:").close(); Database = candidate;
} catch { /* Backend installation tests run with the app's Electron ABI below. */ }

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-managed-node-"));
  t.after(() => {
    setManagedNodeRuntime(undefined);
    delete globalThis.__freebuddyElectronGetPath;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("freebuddy-managed-node-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}
function fixture(t, extra = [], version = "24.21.0") {
  const root = workspace(t);
  const packageDir = path.join(root, "resources", "node-runtime");
  const dataDir = path.join(root, "中文 user data");
  fs.mkdirSync(packageDir, { recursive: true });
  const archiveRoot = `node-v${version}-win-x64`;
  const zip = new AdmZip();
  const files = {};
  for (const file of NODE_REQUIRED_FILES) {
    const body = Buffer.from(`fixture: ${file}\n`);
    zip.addFile(`${archiveRoot}/${file}`, body); files[file] = hash(body);
  }
  for (const name of extra) zip.addFile(name, Buffer.from("must not escape"));
  const archive = zip.toBuffer();
  fs.writeFileSync(path.join(packageDir, "node.zip"), archive);
  fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, version, platform: "win32", arch: "x64", archiveRoot, sha256: hash(archive), files
  }));
  return { root, dataDir, packageDir, prepare: () => ensureManagedNodeRuntime(dataDir, { packageDir, platform: "win32" }) };
}

test("other platforms and older Windows packages retain their existing environment", async t => {
  const root = workspace(t);
  assert.equal(await ensureManagedNodeRuntime(root, { platform: "darwin", packageDir: "missing" }), undefined);
  assert.equal(await ensureManagedNodeRuntime(root, { platform: "win32", packageDir: root }), undefined);
  const env = { Path: "user path", ELECTRON_RUN_AS_NODE: "1" };
  assert.deepEqual(applyManagedNodeEnvironment(env, { platform: "win32" }), env);
});

test("local archives extract concurrently once, survive resource relocation and repair missing or corrupt cached files", async t => {
  const fixture = makeFixture(t);
  const [runtime, same] = await Promise.all([fixture.prepare(), fixture.prepare()]);
  assert.equal(runtime.root, same.root);
  assert.ok(fs.existsSync(path.join(runtime.root, "node_modules", "npm", "bin", "npm-cli.js")));
  const marker = path.join(runtime.root, "ready.json");
  const first = fs.statSync(marker).mtimeMs;
  assert.equal((await fixture.prepare()).root, runtime.root);
  assert.equal(fs.statSync(marker).mtimeMs, first);
  fs.rmSync(path.join(runtime.root, "npx.cmd"));
  await fixture.prepare();
  assert.ok(fs.existsSync(path.join(runtime.root, "npx.cmd")));
  fs.writeFileSync(runtime.node, "corrupt executable");
  await fixture.prepare();
  assert.equal(fs.readFileSync(runtime.node, "utf8"), "fixture: node.exe\n");
  const nextResources = path.join(fixture.root, "updated-app", "node-runtime");
  fs.cpSync(fixture.packageDir, nextResources, { recursive: true });
  assert.equal((await ensureManagedNodeRuntime(fixture.dataDir, { packageDir: nextResources, platform: "win32" })).root, runtime.root);
  assert.equal(fs.readdirSync(path.dirname(runtime.root)).some(name => name.includes("extracting") || name.endsWith(".lock")), false);
});
const makeFixture = fixture;

test("a new app process reuses Node after an app upgrade without opening the archive or reinstalling CLIs", async t => {
  const fixture = makeFixture(t);
  const runtime = await fixture.prepare();
  const marker = path.join(runtime.root, "ready.json");
  const timestamp = fs.statSync(marker).mtimeMs;
  const cli = path.join(runtime.prefix, "installed-cli.cmd");
  fs.writeFileSync(cli, "already installed");
  // The cache is disposable; losing it must not force a Node reinstall.
  fs.rmdirSync(runtime.cache);
  const nextResources = path.join(fixture.root, "updated-app", "node-runtime");
  fs.mkdirSync(nextResources, { recursive: true });
  fs.copyFileSync(path.join(fixture.packageDir, "manifest.json"), path.join(nextResources, "manifest.json"));
  const worker = path.join(fixture.root, "upgraded-app.mjs");
  fs.writeFileSync(worker, `import {ensureManagedNodeRuntime} from ${JSON.stringify(new URL("../dist-electron/cli/managedNodeRuntime.js", import.meta.url).href)};
    const runtime=await ensureManagedNodeRuntime(${JSON.stringify(fixture.dataDir)}, {packageDir:${JSON.stringify(nextResources)},platform:'win32'});
    console.log(JSON.stringify(runtime));`);
  const child = spawnProcess(process.execPath, [worker], { env: process.env, windowsHide: true });
  let output = "", error = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { error += data; });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(error || `Worker exited ${code}`)));
  });
  assert.deepEqual(JSON.parse(output.trim()), runtime);
  assert.equal(fs.statSync(marker).mtimeMs, timestamp);
  assert.equal(fs.readFileSync(cli, "utf8"), "already installed");
  assert.ok(fs.statSync(runtime.cache).isDirectory());
  assert.deepEqual(fs.readdirSync(path.dirname(runtime.root)), [path.basename(runtime.root)]);
});

test("a Node release change prepares only the new runtime and preserves the CLI prefix and npm cache", async t => {
  const original = fixture(t);
  const oldRuntime = await original.prepare();
  const cli = path.join(oldRuntime.prefix, "installed-cli.cmd");
  const cache = path.join(oldRuntime.cache, "cached-package");
  fs.writeFileSync(cli, "already installed");
  fs.writeFileSync(cache, "cached download");
  const updated = fixture(t, [], "24.22.0");
  const options = { packageDir: updated.packageDir, platform: "win32" };
  const next = await ensureManagedNodeRuntime(original.dataDir, options);
  assert.notEqual(next.root, oldRuntime.root);
  assert.equal(next.version, "24.22.0");
  assert.equal(next.prefix, oldRuntime.prefix);
  assert.equal(next.cache, oldRuntime.cache);
  assert.equal(fs.readFileSync(cli, "utf8"), "already installed");
  assert.equal(fs.readFileSync(cache, "utf8"), "cached download");
  // Keep the previous runtime usable for another app process still running it.
  assert.ok(fs.existsSync(oldRuntime.node));
  const marker = path.join(next.root, "ready.json");
  const timestamp = fs.statSync(marker).mtimeMs;
  fs.unlinkSync(path.join(updated.packageDir, "node.zip"));
  assert.deepEqual(await ensureManagedNodeRuntime(original.dataDir, options), next);
  assert.equal(fs.statSync(marker).mtimeMs, timestamp);
});

test("checksum errors and archive traversal cannot publish a runtime or write outside its extraction directory", async t => {
  const broken = fixture(t);
  fs.appendFileSync(path.join(broken.packageDir, "node.zip"), "corruption");
  await assert.rejects(broken.prepare(), /checksum mismatch/);
  assert.equal(getManagedNodeRuntime(), undefined);
  const traversal = fixture(t, ["node-v24.21.0-win-x64/../../escaped.txt"]);
  await assert.rejects(traversal.prepare(), /archive path/);
  assert.equal(fs.existsSync(path.join(traversal.root, "escaped.txt")), false);
});

test("two independent app processes share extraction safely and interrupted locks recover", async t => {
  const fixture = makeFixture(t);
  const worker = path.join(fixture.root, "prepare.mjs");
  fs.writeFileSync(worker, `import {ensureManagedNodeRuntime} from ${JSON.stringify(new URL("../dist-electron/cli/managedNodeRuntime.js", import.meta.url).href)};
    const runtime=await ensureManagedNodeRuntime(${JSON.stringify(fixture.dataDir)}, {packageDir:${JSON.stringify(fixture.packageDir)},platform:'win32'});
    console.log('ROOT='+runtime.root);`);
  const run = () => new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [worker], { env: process.env, windowsHide: true });
    let output = "", error = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { error += data; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve({ pid: child.pid, root: output.trim().split('ROOT=').at(-1) }) : reject(new Error(error)));
  });
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first.root, second.root);
  fs.unlinkSync(path.join(first.root, "npx.cmd"));
  const lock = `${first.root}.lock`;
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: first.pid }));
  assert.equal((await fixture.prepare()).root, first.root);
  assert.equal(fs.existsSync(lock), false);
});

test("managed paths survive Windows refreshes, keep explicit overrides, and isolate npm globals without modifying the source", async t => {
  const fixture = makeFixture(t);
  const runtime = await fixture.prepare();
  const source = { Path: "C:\\system;C:\\old-node", PATH: `${runtime.root.toUpperCase()};C:\\system`,
    ELECTRON_RUN_AS_NODE: "1", CHROME_CRASHPAD_PIPE_NAME: "inherited", npm_config_prefix: "C:\\Program Files\\nodejs",
    NODE_OPTIONS: "--require electron/bootstrap --max-old-space-size=2048" };
  const env = applyManagedNodeEnvironment(source, { platform: "win32", install: true });
  assert.equal(env.Path, undefined);
  assert.equal(env.PATH.split(";")[0], runtime.root);
  assert.equal(env.PATH.split(";").filter(entry => entry.toLowerCase() === runtime.root.toLowerCase()).length, 1);
  assert.equal(env.NPM_CONFIG_PREFIX, runtime.prefix);
  assert.equal(env.npm_config_prefix, undefined);
  assert.equal(env.NPM_CONFIG_CACHE, runtime.cache);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=2048");
  assert.equal(source.ELECTRON_RUN_AS_NODE, "1");
  const override = path.join(fixture.root, "custom-node", "node.exe");
  fs.mkdirSync(path.dirname(override)); fs.writeFileSync(override, "user node");
  const explicit = applyManagedNodeEnvironment({ ...source, FREEBUDDY_NODE_BIN: override }, { platform: "win32" });
  assert.equal(explicit.FREEBUDDY_NODE_BIN, override);
  assert.equal(explicit.PATH.split(";")[0], path.dirname(override));
  assert.equal(applyManagedNodeEnvironment({ FREEBUDDY_NODE_BIN: path.dirname(override) }, {
    platform: "win32"
  }).FREEBUDDY_NODE_BIN, runtime.node);
  const { getFreshWindowsEnvironment } = await import("../dist-electron/cli/windowsEnv.js");
  if (process.platform === "win32") assert.equal((await getFreshWindowsEnvironment(env)).PATH.split(";")[0], runtime.root);
  assert.equal(applyManagedNodeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }, {
    platform: "win32", preserveElectronRunAsNode: true
  }).ELECTRON_RUN_AS_NODE, "1");
});

test("Codex resolves private CLI installations and Node defaults before system binaries while retaining user overrides", async t => {
  const fixture = makeFixture(t);
  const runtime = await fixture.prepare();
  const globalNode = path.join(fixture.root, "system", "node.exe");
  fs.mkdirSync(path.dirname(globalNode)); fs.writeFileSync(globalNode, "system node");
  assert.equal(resolveNodeBinaryHint({ platform: "win32", env: { PATH: path.dirname(globalNode) } }), runtime.node);
  assert.equal(resolveNodeBinaryHint({ platform: "win32", env: { FREEBUDDY_NODE_BIN: globalNode } }), globalNode);
  const acp = path.join(runtime.prefix, "node_modules", "@agentclientprotocol", "codex-acp");
  const codex = path.join(runtime.prefix, "node_modules", "@openai", "codex", "bin", "codex.js");
  fs.mkdirSync(acp, { recursive: true }); fs.writeFileSync(path.join(acp, "package.json"), "{}");
  fs.mkdirSync(path.dirname(codex), { recursive: true }); fs.writeFileSync(codex, "// bundled codex");
  // Node's module resolver canonicalizes symlinks, including macOS /var -> /private/var.
  assert.equal(resolveCodexBinaryHint({ platform: "win32", env: { PATH: "" } }), fs.realpathSync(codex));
});

const staged = fileURLToPath(new URL("../.build/node-runtime/win32-x64", import.meta.url));
test("real Windows Node works with no system Node on PATH, including npm installs, ACP terminals, MCP and Pi", {
  skip: process.platform !== "win32" || !fs.existsSync(path.join(staged, "node.zip")), timeout: 120_000
}, async t => {
  const root = workspace(t);
  validateNodePackage(staged);
  const userData = path.join(root, "中文 user data");
  globalThis.__freebuddyElectronGetPath = () => userData;
  const runtime = await ensureManagedNodeRuntime(path.join(userData, "freebuddy"), { packageDir: staged });
  const systemPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const env = applyManagedNodeEnvironment({ ...process.env, PATH: systemPath, Path: undefined,
    ELECTRON_RUN_AS_NODE: "1" }, { install: true });
  const invoke = (bin, args, overrides = {}) => {
    const result = spawn.sync(bin, args, { env, encoding: "utf8", timeout: 30_000, windowsHide: true, ...overrides });
    assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stderr}`);
    return result.stdout.trim();
  };
  assert.equal(invoke("node", ["--version"]), `v${NODE_VERSION}`);
  assert.match(invoke("npm", ["--version"]), /^\d+\.\d+\.\d+$/);
  assert.match(invoke("npx", ["--version"]), /^\d+\.\d+\.\d+$/);
  assert.equal(invoke("node", ["-e", "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:'); console.log(db.prepare('SELECT 7 AS n').get().n); db.close()"]), "7");

  // Install a local, dependency-free CLI through the same backend used by the app.
  const cli = path.join(root, "fixture-cli");
  fs.mkdirSync(cli);
  fs.writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "freebuddy-node-fixture", version: "1.0.0", bin: { "fb-node-fixture": "bin.js" } }));
  fs.writeFileSync(path.join(cli, "bin.js"), "#!/usr/bin/env node\nconsole.log(JSON.stringify({node:process.execPath,version:process.versions.node,electron:process.env.ELECTRON_RUN_AS_NODE}));\n");
  const packed = JSON.parse(invoke("npm", ["pack", cli, "--json", "--pack-destination", root, "--ignore-scripts"]));
  const command = `npm install -g "${path.join(root, packed[0].filename)}" --offline --ignore-scripts --no-audit --no-fund`;
  if (Database) {
    const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
    const db = new Database(":memory:"); migrate(db); setDbForTest(db);
    t.after(() => { setDbForTest(null); db.close(); });
    const { cliInstall, cliInstallStream } = await import("../dist-electron/cli/check.js");
    const originalPath = process.env.PATH;
    process.env.PATH = systemPath;
    try {
      assert.equal((await cliInstall(command)).success, true);
      assert.equal((await cliInstallStream(command)).success, true);
    } finally { process.env.PATH = originalPath; }
  } else {
    invoke("npm", ["install", "-g", path.join(root, packed[0].filename), "--offline", "--ignore-scripts", "--no-audit", "--no-fund"]);
    t.diagnostic("Use npm run test:managed-node to also exercise both app backend installers with Electron's SQLite ABI.");
  }
  const installed = JSON.parse(invoke("fb-node-fixture", []));
  assert.equal(installed.node.toLowerCase(), runtime.node.toLowerCase());
  assert.equal(installed.version, NODE_VERSION);
  assert.equal(installed.electron, undefined);
  assert.ok(fs.existsSync(path.join(runtime.prefix, "fb-node-fixture.cmd")));

  if (Database) {
    const { runAuthenticationTerminal } = await import("../dist-electron/cli/acpAuthTerminal.js");
    const authEvents = [];
    await runAuthenticationTerminal({ sessionId: "managed-node-auth", agentName: "Fixture",
      method: { id: "terminal", name: "Terminal", type: "terminal" },
      command: { bin: runtime.node, args: ["-e", "console.log('AUTH_NODE='+process.versions.node+' ELECTRON='+Boolean(process.env.ELECTRON_RUN_AS_NODE))"],
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" } }, emit: event => authEvents.push(event) });
    assert.ok(authEvents.some(event => event.output?.includes(`AUTH_NODE=${NODE_VERSION} ELECTRON=false`)));
  }

  const manager = createAcpTerminalManager({});
  t.after(() => manager.dispose());
  const terminal = await manager.create({ sessionId: "no-system-node", command: "node", args: ["-p", "process.execPath"],
    env: [{ name: "PATH", value: systemPath }, { name: "ELECTRON_RUN_AS_NODE", value: "1" }] });
  assert.equal((await manager.waitForExit(terminal.terminalId)).exitCode, 0);
  assert.equal(manager.output(terminal.terminalId).output.trim().toLowerCase(), runtime.node.toLowerCase());
  manager.dispose();

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const service = path.join(root, "mcp.cjs");
  fs.writeFileSync(service, `require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const q=JSON.parse(line); if(q.id==null)return;
    const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0.0'}}:
      q.method==='tools/call'?{content:[{type:'text',text:JSON.stringify({node:process.execPath,version:process.versions.node})}]}:{};
    console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
  });`);
  const client = new Client({ name: "managed-node-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(new StdioClientTransport({ command: "node", args: [service], env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")) }));
    const result = await client.callTool({ name: "runtime-info", arguments: {} });
    assert.equal(JSON.parse(result.content[0].text).version, NODE_VERSION);
  } finally { await client.close(); }

  const pi = resolvePiAcpRuntime();
  if (pi.ready) assert.match(invoke(runtime.node, [piCliEntryForRoot(pi.root), "--version"]), /0\.85\.1/);
  const piEntry = path.join(root, "pi-launcher-fixture.js");
  fs.writeFileSync(piEntry, "console.log(JSON.stringify({node:process.execPath,electron:process.env.ELECTRON_RUN_AS_NODE}));");
  const launcher = ensurePiAcpLauncher({ dataDir: root, piCliEntry: piEntry, node: { bin: runtime.node, env: {} } });
  const launched = JSON.parse(invoke(launcher, [], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" } }));
  assert.equal(launched.electron, undefined);
  assert.equal(launched.node.toLowerCase(), runtime.node.toLowerCase());
});

test("the Windows packaging guard rejects a missing runtime", t => {
  const root = workspace(t);
  assert.throws(() => verifyPackagedNodeRuntime(root), /ENOENT/);
});
