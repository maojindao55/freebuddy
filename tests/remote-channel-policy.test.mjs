import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const electronDir = new URL("../electron/", import.meta.url);
const electronDirPath = fileURLToPath(electronDir);

async function loadPolicy() {
  const source = fs.readFileSync(
    new URL("shared/remoteChannelPolicy.ts", electronDir),
    "utf8"
  );
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
  );
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function registeredChannels() {
  const channels = new Set();
  for (const file of walk(electronDirPath)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/registerHandler\(\s*"([^"]+)"/g)) {
      channels.add(match[1]);
    }
  }
  return channels;
}

function preloadChannels() {
  const source = fs.readFileSync(
    new URL("../public/web-preload.js", import.meta.url),
    "utf8"
  );
  const channels = new Set();
  for (const match of source.matchAll(/invoke\("([^"]+)"/g)) {
    channels.add(match[1]);
  }
  return channels;
}

test("every registered IPC channel is explicitly classified", async () => {
  const { isRemoteChannelClassified } = await loadPolicy();
  const missing = [...registeredChannels()].filter(
    (channel) => !isRemoteChannelClassified(channel)
  );
  assert.deepEqual(
    missing,
    [],
    `新增通道必须在 remoteChannelPolicy 中显式分类: ${missing.join(", ")}`
  );
});

test("unknown channels default to deny", async () => {
  const { classifyRemoteChannel, isRemoteChannelCallable } = await loadPolicy();
  assert.equal(classifyRemoteChannel("totally:unknown"), "deny");
  assert.equal(isRemoteChannelCallable("totally:unknown", true), false);
});

test("channels that spawn or reconfigure the host are not remotely callable", async () => {
  const { classifyRemoteChannel, isRemoteChannelCallable } = await loadPolicy();

  for (const channel of [
    "cli:upsertOverride",
    "cli:resetOverride",
    "cli:logout",
    "cli:probeAuthentication",
    "cli:connectCursorUsage",
    "cli:disconnectCursorUsage",
    "cli:createProject",
    "cli:updateProject",
    "cli:deleteProject",
    "skills:setTrusted",
    "skills:delete"
  ]) {
    assert.equal(
      classifyRemoteChannel(channel),
      "adminOnly",
      `${channel} 必须限制为管理员`
    );
    assert.equal(isRemoteChannelCallable(channel, false), false);
  }

  for (const channel of [
    "cli:install",
    "cli:installStream",
    "cli:selectDirectory",
    "skills:import",
    "plugins:install",
    "updater:quitAndInstall",
    "remote:setEnabled",
    "remote:createUser",
    "remote:deleteUser",
    "remote:setUserRoots",
    "remote:listSessions",
    "remote:revokeSession",
    "debugLog:write",
    "debugLogs:preview",
    "debugLogs:export"
  ]) {
    assert.equal(classifyRemoteChannel(channel), "deny", `${channel} 必须禁止远程调用`);
    assert.equal(isRemoteChannelCallable(channel, true), false);
  }
});

test("the chat surface the web client depends on stays callable", async () => {
  const { isRemoteChannelCallable } = await loadPolicy();
  for (const channel of [
    "cli:run",
    "cli:check",
    "cli:listConversations",
    "cli:listMessages",
    "cli:appendMessage",
    "cli:listOverrides",
    "cli:listAdapters",
    "cli:listProjects",
    "cli:getProject",
    "settings:get",
    "remote:whoami"
  ]) {
    assert.equal(
      isRemoteChannelCallable(channel, false),
      true,
      `${channel} 是远程聊天必需通道`
    );
  }
});

test("the remote bridge routes every call through the policy and the arg guard", () => {
  const registry = fs.readFileSync(
    new URL("invokeRegistry.ts", electronDir),
    "utf8"
  );
  assert.match(
    registry,
    /isRemoteChannelCallable\(channel, isAdmin\)/,
    "localInvoke consults the allow-list"
  );
  assert.match(
    registry,
    /guardRemoteInvokeArgs\(channel, args, context\.userId/,
    "arguments are sanitized before the handler runs"
  );
  assert.doesNotMatch(
    registry,
    /REMOTE_BLOCKED_CHANNELS/,
    "the old deny-list is gone"
  );

  const server = fs.readFileSync(new URL("webUIServer.ts", electronDir), "utf8");
  assert.match(
    server,
    /localInvoke\(channel, \{ userId \}/,
    "the HTTP bridge passes the session user into the guard"
  );
});

test("the arg guard replaces caller-supplied executables and clamps paths", () => {
  const guard = fs.readFileSync(
    new URL("cli/remoteInvokeGuard.ts", electronDir),
    "utf8"
  );
  assert.match(guard, /binary: resolved\.binary/, "binary comes from host config");
  assert.match(guard, /env: resolved\.env/, "env comes from host config");
  assert.match(guard, /forbidden_path/, "out-of-root paths are rejected");
  assert.match(guard, /forbidden_setting/, "settings keys are allow-listed");

  const roots = fs.readFileSync(new URL("cli/remoteRoots.ts", electronDir), "utf8");
  assert.match(
    roots,
    /isOwner \? resolveWorkspaceRoots\(\[\]\) : \[\]/,
    "members with no assigned roots do not fall back to the host home directory"
  );
});

test("channels used by the web preload are classified as allow or adminOnly", async () => {
  const { classifyRemoteChannel } = await loadPolicy();
  const denied = [...preloadChannels()]
    .filter((channel) => classifyRemoteChannel(channel) === "deny")
    .sort();
  // The web shell exposes these but degrades gracefully: installing a CLI and
  // opening a native settings window only make sense on the host.
  assert.deepEqual(denied, ["cli:install", "cli:openCursorUsageSettings"]);
});
