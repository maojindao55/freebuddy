import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCommand, dshAcpCompositionReady, patchDshAcpManagedRuntime, patchDshAcpRuntimeFromBin } from "../dist-electron/cli/adapters.js";

test("modern standalone owns configuration and is protected from legacy overlays", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-modern-dsh-"));
  try {
    const pkg = path.join(root, "node_modules", "deepseek-harness-acp");
    fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
    const entry = path.join(pkg, "lib", "bin.js");
    fs.writeFileSync(entry, "");
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({
      name: "deepseek-harness-acp", dependencies: { "@deepseek-ai/dsh-base": "0.1.6-alpha.2" }
    }));
    const oldConfig = path.join(root, "cordis.yml");
    fs.writeFileSync(oldConfig, "- name: '@deepseek-ai/dsh-acp-demo'\n");
    assert.equal(dshAcpCompositionReady(entry, oldConfig), false);
    for (const name of ["dsh-base", "dsh-acp", "dsh-app-boot"]) {
      const dep = path.join(pkg, "node_modules", "@deepseek-ai", name);
      fs.mkdirSync(dep, { recursive: true });
      fs.writeFileSync(path.join(dep, "package.json"), "{}");
    }
    assert.equal(dshAcpCompositionReady(entry, oldConfig), true);
    const built = buildCommand({ adapter: "dsh-acp", prompt: "hello", dshAcpRuntimeRoot: root });
    assert.equal(built.bin, "node");
    assert.deepEqual(built.args, ["--disable-warning=ExperimentalWarning", entry]);
    assert.equal(built.env?.NODE_OPTIONS, undefined);
    assert.equal(built.env?.DSH_SESSIONS_ROOT, undefined);
    const workspace = path.join(root, "workspace");
    const stale = path.join(workspace, ".sessions", "project", "session-id");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "session.v3.jsonl.zstd"), "");
    const previousSessions = process.env.DSH_SESSIONS_ROOT;
    const previousCompression = process.env.DSH_PERSISTENCE_COMPRESSION;
    delete process.env.DSH_SESSIONS_ROOT;
    delete process.env.DSH_PERSISTENCE_COMPRESSION;
    try {
      const redirected = buildCommand({
        adapter: "dsh-acp",
        prompt: "hello",
        binary: entry,
        cwd: workspace,
        dshAcpRuntimeRoot: root
      });
      assert.equal(redirected.env.DSH_SESSIONS_ROOT, path.join(root, "sessions"));
      const clean = path.join(root, "clean");
      fs.mkdirSync(clean);
      const plain = buildCommand({
        adapter: "dsh-acp",
        prompt: "hello",
        binary: entry,
        cwd: clean,
        dshAcpRuntimeRoot: root,
        extraArgs: ["--model", "vendor/custom"]
      });
      assert.equal(plain.env.DSH_SESSIONS_ROOT, undefined);
      assert.equal(plain.env.DEEPSEEK_MODEL, "vendor/custom");
    } finally {
      if (previousSessions === undefined) delete process.env.DSH_SESSIONS_ROOT;
      else process.env.DSH_SESSIONS_ROOT = previousSessions;
      if (previousCompression === undefined) delete process.env.DSH_PERSISTENCE_COMPRESSION;
      else process.env.DSH_PERSISTENCE_COMPRESSION = previousCompression;
    }
    const custom = buildCommand({ adapter: "dsh-acp", prompt: "hello", binary: entry, extraArgs: ["--config", "custom.yml"] });
    assert.deepEqual(custom.args, ["--disable-warning=ExperimentalWarning", entry, "--config", "custom.yml"]);
    for (const extraArgs of [["--model", "vendor/custom"], ["--model=vendor/custom"], ["-m", "vendor/custom"]]) {
      const byok = buildCommand({ adapter: "dsh-acp", prompt: "hello", binary: entry, extraArgs });
      assert.deepEqual(byok.args, ["--disable-warning=ExperimentalWarning", entry]);
      assert.equal(byok.env.DEEPSEEK_MODEL, "vendor/custom");
    }
    const jsonl = path.join(root, "node_modules", "@deepseek-ai", "dsh-session-persistence-jsonl", "lib");
    fs.mkdirSync(jsonl, { recursive: true });
    const sentinel = path.join(jsonl, "index.js");
    fs.writeFileSync(sentinel, "modern persistence");
    assert.equal(patchDshAcpManagedRuntime(root), 0);
    patchDshAcpRuntimeFromBin(entry);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "modern persistence");
    // Protect a current JSONL package even when scanning a legacy/mixed prefix.
    fs.writeFileSync(path.join(path.dirname(jsonl), "package.json"), JSON.stringify({ version: "0.1.6-alpha.2" }));
    fs.writeFileSync(path.join(pkg, "package.json"), "{}");
    assert.equal(patchDshAcpManagedRuntime(root), 0);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "modern persistence");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default binary resolution finds global standalone deepseek-harness-acp", () => {
  const built = buildCommand({ adapter: "dsh-acp", prompt: "hello", extraArgs: ["--model=glm-5.3-flash"] });
  if (built.bin === "node") {
    assert.match(built.args[1], /deepseek-harness-acp[/\\]lib[/\\]bin\.js$/);
    assert.equal(built.args.includes("--config"), false);
    assert.equal(built.env?.DEEPSEEK_MODEL, "glm-5.3-flash");
  }
});

