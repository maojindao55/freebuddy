import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function load() {
  const source = fs.readFileSync(
    new URL("../electron/shared/environmentInfo.ts", import.meta.url), "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("buildEnvironmentInfo shapes the environment.json snapshot", async () => {
  const { buildEnvironmentInfo } = await load();
  const info = buildEnvironmentInfo({
    appVersion: "0.6.8",
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.22631",
    locale: "zh-CN",
    versions: { electron: "35.0.0", chrome: "134.0.0", node: "22.0.0" },
    telemetryEnabled: true,
    adapters: [{ id: "codex", label: "Codex" }, { id: "claude" }],
    conversationCount: 12,
    droppedLines: 0,
    exportedAt: "2026-07-30T01:02:03.000Z",
    exportMode: "standard",
    exportScope: "all"
  });
  assert.equal(info.app.version, "0.6.8");
  assert.equal(info.app.platform, "win32");
  assert.equal(info.app.arch, "x64");
  assert.equal(info.app.osRelease, "10.0.22631");
  assert.equal(info.app.locale, "zh-CN");
  assert.equal(info.runtime.electron, "35.0.0");
  assert.equal(info.runtime.chrome, "134.0.0");
  assert.equal(info.runtime.node, "22.0.0");
  assert.equal(info.telemetry.enabled, true);
  assert.deepEqual(info.adapters, [
    { id: "codex", label: "Codex" },
    { id: "claude", label: "claude" }
  ]);
  assert.equal(info.counts.conversations, 12);
  assert.equal(info.logHealth.droppedLines, 0);
  assert.equal(info.exportedAt, "2026-07-30T01:02:03.000Z");
  assert.equal(info.exportMode, "standard");
  assert.equal(info.exportScope, "all");
});

test("buildEnvironmentInfo defaults missing runtime versions to empty strings", async () => {
  const { buildEnvironmentInfo } = await load();
  const info = buildEnvironmentInfo({
    appVersion: "0.6.8",
    platform: "darwin",
    arch: "arm64",
    osRelease: "24.5.0",
    locale: "en",
    versions: {},
    telemetryEnabled: false,
    adapters: [],
    conversationCount: 0,
    droppedLines: 0,
    exportedAt: "2026-07-30T01:02:03.000Z",
    exportMode: "standard",
    exportScope: "conversation"
  });
  assert.equal(info.runtime.electron, "");
  assert.equal(info.runtime.chrome, "");
  assert.equal(info.runtime.node, "");
});

test("environment info never includes paths, usernames or message content", async () => {
  const { buildEnvironmentInfo } = await load();
  const serialized = JSON.stringify(buildEnvironmentInfo({
    appVersion: "0.6.8", platform: "darwin", arch: "arm64", osRelease: "24.5.0",
    locale: "en", versions: {}, telemetryEnabled: false,
    adapters: [], conversationCount: 0, droppedLines: 0,
    exportedAt: "t", exportMode: "full", exportScope: "all"
  }));
  assert.doesNotMatch(serialized, /workspacePath|cwd|home|message/i);
});
