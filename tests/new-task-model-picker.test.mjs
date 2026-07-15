import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) =>
  fs.readFileSync(new URL(path, import.meta.url), "utf8");

const chatView = read("../src/components/CLI/ChatView.tsx");
const probe = read("../electron/cli/sessionConfigProbe.ts");
const ipc = read("../electron/cli/ipc.ts");
const preload = read("../electron/preload.ts");
const conversations = read("../electron/cli/conversations.ts");

test("new-task model picker discovers ACP options before creating a conversation", () => {
  assert.match(chatView, /inspectSessionConfigOptions\(probeInput\)/);
  const newTaskHome = chatView.slice(chatView.indexOf("function NewTaskHome"));
  assert.match(newTaskHome, /<SessionConfigPicker/);
  assert.match(newTaskHome, /options=\{configOptions\}/);
  assert.match(newTaskHome, /onChange=\{onConfigOptionOverrides\}/);
  assert.match(newTaskHome, /!teamMode/);
});

test("new-task model overrides are persisted before the first prompt", () => {
  const normalCreate = chatView.slice(
    chatView.indexOf("const selectedMember = members.find", chatView.indexOf("const onCreateAndSend")),
    chatView.indexOf("await sendMessage", chatView.indexOf("const onCreateAndSend"))
  );
  assert.match(normalCreate, /configOptionOverrides:\s*newTaskConfigOptionOverrides/);
  assert.match(
    conversations,
    /INSERT INTO conversations[\s\S]*config_option_overrides[\s\S]*JSON\.stringify\(input\.configOptionOverrides\)/
  );
});

test("ACP config probe creates and closes a session without sending a prompt", () => {
  assert.match(probe, /buildInitializeRequest\(\+\+nextRequestId\)/);
  assert.match(probe, /buildSessionNewRequest\(\+\+nextRequestId, input\.cwd, \[\]\)/);
  assert.match(probe, /buildSessionCloseRequest\(\+\+nextRequestId, sessionId\)/);
  assert.doesNotMatch(probe, /buildSessionPromptRequest/);
  assert.match(probe, /killProcessTree\(child, "term"\)/);
});

test("session config discovery is exposed through the isolated preload bridge", () => {
  assert.match(ipc, /cli:getCachedSessionConfigOptions/);
  assert.match(ipc, /cli:inspectSessionConfigOptions/);
  assert.match(preload, /ipcRenderer\.invoke\("cli:getCachedSessionConfigOptions", args\)/);
  assert.match(preload, /ipcRenderer\.invoke\("cli:inspectSessionConfigOptions", args\)/);
});

test("new-task model picker shows persisted cache before refreshing ACP", () => {
  const cacheRead = chatView.indexOf("getCachedSessionConfigOptions(probeInput)");
  const refresh = chatView.indexOf("inspectSessionConfigOptions(probeInput)");
  assert.ok(cacheRead > -1, "missing persisted model cache read");
  assert.ok(refresh > cacheRead, "ACP refresh must happen after cache is displayed");
  assert.match(chatView, /setNewTaskConfigOptions\(cached\)/);
  assert.match(probe, /cacheSessionConfigOptions\(input, options\)/);
  assert.match(probe, /if \(options\.length === 0\) return;/);
});
