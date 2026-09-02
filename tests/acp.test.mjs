import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCommand,
  cliAdapterDefinitions,
  adapterAcceptsClientMcpServers,
  extraArgsHaveDshConfig,
  resolveDshAcpConfigPath,
  DSH_ACP_NODE_DISABLE_WARNING,
  isDshAcpExperimentalWarningLine,
  mergeNodeOptions,
  sanitizeCliAgentEnv,
  ensureDshAcpCwd,
  dshAcpManagedRoot,
  formatAcpAgentExitMessage,
  isWindowsAccessViolationExit,
  patchDshAcpManagedRuntime,
  syncDshAcpManagedConfig,
  dshHarnessOverlayDir,
  dshAcpJsonlStillUsesKoffi,
  patchDshAcpRuntimeFromBin,
  buildDshAcpRuntimeDiagnostics,
  dshAcpKoffiGuardPath,
  dshAcpKoffiGuardImportFlag,
  isDefaultDshAcpBinary
} from "../dist-electron/cli/adapters.js";
import {
  acpSessionListToItems,
  acpSessionSetupToItems,
  acpUpdateToItems,
  acpNonRetryableUpstreamError,
  buildAuthenticateRequest,
  buildInitializeRequest,
  buildLogoutRequest,
  buildPromptContentBlocks,
  buildSessionLoadRequest,
  buildSessionNewRequest,
  buildSessionPromptRequest,
  buildSessionResumeRequest,
  buildSessionSetConfigOptionRequest,
  buildTerminalOutputResponse,
  contentBlockToItems,
  isMissingSavedSessionError,
  parseAcpLine,
  selectAcpAuthMethod,
  selectAcpSessionStartMode,
  shouldDiscardAcpToolSession,
  shouldEmitAcpUpdate,
  shouldRetryEmptyResumedDshTurn,
  shouldSkipUserMessageChunk,
  shouldDropReplayPhaseAgentChunk,
  updateActiveAcpToolCalls
} from "../dist-electron/cli/acp.js";

const acpRuntimeSource = fs.readFileSync(
  new URL("../electron/cli/acpRuntime.ts", import.meta.url),
  "utf8"
);

test("buildCommand starts OpenCode through its ACP server", () => {
  const built = buildCommand({
    adapter: "opencode-acp",
    prompt: "hello",
    cwd: "/tmp/project"
  });

  assert.equal(built.bin, "opencode");
  assert.deepEqual(built.args, ["acp", "--cwd", "/tmp/project"]);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildCommand omits OpenCode permission for single workspace root", () => {
  const built = buildCommand({
    adapter: "opencode-acp",
    prompt: "hello",
    cwd: "/tmp/primary",
    workspaceRoots: ["/tmp/primary"]
  });
  assert.equal(built.env, undefined);
});

test("buildCommand injects OpenCode external_directory allows for multi-root projects", () => {
  const built = buildCommand({
    adapter: "opencode-acp",
    prompt: "hello",
    cwd: "/tmp/primary",
    workspaceRoots: ["/tmp/primary/", "/tmp/secondary", ""]
  });
  const content = JSON.parse(built.env.OPENCODE_CONFIG_CONTENT);
  const rules = content.permission.external_directory;
  assert.equal(Object.keys(rules).length, 2);
  for (const [pattern, action] of Object.entries(rules)) {
    assert.equal(action, "allow");
    assert.match(pattern, /\/\*\*$/);
  }
  assert.ok(Object.keys(rules).some((k) => k.includes("primary")));
  assert.ok(Object.keys(rules).some((k) => k.includes("secondary")));
});

test("buildCommand merges OpenCode model with multi-root permission", () => {
  const built = buildCommand({
    adapter: "opencode-acp",
    prompt: "hello",
    cwd: "/tmp/primary",
    extraArgs: ["-m", "openai/gpt-4.1"],
    workspaceRoots: ["/tmp/primary", "/tmp/secondary"]
  });
  const content = JSON.parse(built.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(content.model, "openai/gpt-4.1");
  const rules = content.permission.external_directory;
  assert.equal(Object.keys(rules).length, 2);
  for (const [pattern, action] of Object.entries(rules)) {
    assert.equal(action, "allow");
    assert.match(pattern, /\/\*\*$/);
  }
  assert.ok(Object.keys(rules).some((k) => k.includes("primary")));
  assert.ok(Object.keys(rules).some((k) => k.includes("secondary")));
});

test("buildCommand applies OpenCode ACP model through config env", () => {
  const built = buildCommand({
    adapter: "opencode-acp",
    prompt: "hello",
    cwd: "/tmp/project",
    extraArgs: ["-m", "openai/gpt-4.1", "--print-logs"]
  });

  assert.deepEqual(built.args, ["acp", "--cwd", "/tmp/project", "--print-logs"]);
  assert.deepEqual(built.env, {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "openai/gpt-4.1" })
  });

  const withEquals = buildCommand({
    adapter: "opencode-acp",
    prompt: "hello",
    extraArgs: ["--model=anthropic/claude-sonnet-4"]
  });
  assert.deepEqual(withEquals.args, ["acp"]);
  assert.deepEqual(withEquals.env, {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "anthropic/claude-sonnet-4" })
  });
});

test("visible adapter definitions are ACP-only with product names", () => {
  assert.deepEqual(
    cliAdapterDefinitions.map((definition) => ({
      id: definition.id,
      label: definition.label,
      protocol: definition.protocol
    })),
    [
      { id: "codex-acp", label: "Codex", protocol: "acp" },
      { id: "claude-agent-acp", label: "ClaudeCode", protocol: "acp" },
      { id: "opencode-acp", label: "OpenCode", protocol: "acp" },
      { id: "cursor-agent-acp", label: "Cursor", protocol: "acp" },
      { id: "kimi-acp", label: "Kimi", protocol: "acp" },
      { id: "qoder-acp", label: "Qoder", protocol: "acp" },
      { id: "codebuddy-acp", label: "CodeBuddy", protocol: "acp" },
      { id: "grok-acp", label: "Grok", protocol: "acp" },
      { id: "agy-acp", label: "Antigravity", protocol: "acp" },
      { id: "dsh-acp", label: "DeepSeek Harness", protocol: "acp" }
    ]
  );
});

test("buildCommand starts Codex and Claude ACP adapters", () => {
  assert.deepEqual(
    buildCommand({ adapter: "codex-acp", prompt: "hello" }),
    {
      bin: "codex-acp",
      args: [],
      promptViaStdin: false,
      protocol: "acp"
    }
  );
  assert.deepEqual(
    buildCommand({ adapter: "claude-agent-acp", prompt: "hello" }),
    {
      bin: "claude-agent-acp",
      args: [],
      promptViaStdin: false,
      protocol: "acp"
    }
  );
});

test("buildCommand translates Codex model shorthand for codex-acp", () => {
  assert.deepEqual(
    buildCommand({
      adapter: "codex-acp",
      prompt: "hello",
      extraArgs: ["-m", "gpt-5", "--config", "approval_policy=never"]
    }),
    {
      bin: "codex-acp",
      args: [],
      env: {
        CODEX_CONFIG: JSON.stringify({
          model: "gpt-5",
          approval_policy: "never"
        })
      },
      promptViaStdin: false,
      protocol: "acp"
    }
  );

  const withEquals = buildCommand({
    adapter: "codex-acp",
    prompt: "hello",
    extraArgs: ["--model=o3"]
  });
  assert.deepEqual(withEquals.args, []);
  assert.deepEqual(withEquals.env, {
    CODEX_CONFIG: JSON.stringify({ model: "o3" })
  });
});

test("buildCommand maps Codex ACP config args to CODEX_CONFIG for new codex-acp", () => {
  const built = buildCommand({
    adapter: "codex-acp",
    prompt: "hello",
    extraArgs: [
      "-c",
      "model_provider=proxy",
      "--config",
      'model_providers.proxy.base_url="https://proxy.example.com/v1"'
    ]
  });

  assert.deepEqual(built.args, []);
  assert.deepEqual(JSON.parse(built.env.CODEX_CONFIG), {
    model_provider: "proxy",
    model_providers: {
      proxy: {
        base_url: "https://proxy.example.com/v1"
      }
    }
  });
});

test("buildCommand applies ClaudeCode ACP model through environment", () => {
  const built = buildCommand({
    adapter: "claude-agent-acp",
    prompt: "hello",
    extraArgs: ["--model=claude-sonnet-4-5", "--hide-claude-auth"]
  });

  assert.deepEqual(built.args, ["--hide-claude-auth"]);
  assert.deepEqual(built.env, {
    ANTHROPIC_MODEL: "claude-sonnet-4-5"
  });
});

test("buildCommand starts Cursor through its ACP server", () => {
  const built = buildCommand({
    adapter: "cursor-agent-acp",
    prompt: "hello"
  });

  assert.equal(built.bin, "cursor-agent");
  assert.deepEqual(built.args, ["acp"]);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildCommand keeps Cursor global flags before the ACP subcommand", () => {
  const built = buildCommand({
    adapter: "cursor-agent-acp",
    prompt: "hello",
    extraArgs: ["-m", "gpt-5", "--print"]
  });

  assert.deepEqual(built.args, ["--model", "gpt-5", "--print", "acp"]);
  assert.equal(built.env, undefined);
});

test("buildCommand starts Kimi through its ACP server", () => {
  const built = buildCommand({ adapter: "kimi-acp", prompt: "hello" });

  assert.equal(built.bin, "kimi");
  assert.deepEqual(built.args, ["acp"]);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildCommand applies Kimi ACP model through KIMI_MODEL_NAME env", () => {
  const built = buildCommand({
    adapter: "kimi-acp",
    prompt: "hello",
    extraArgs: ["-m", "kimi-k2", "--yolo"]
  });

  assert.deepEqual(built.args, ["acp", "--yolo"]);
  assert.deepEqual(built.env, { KIMI_MODEL_NAME: "kimi-k2" });

  const withEquals = buildCommand({
    adapter: "kimi-acp",
    prompt: "hello",
    extraArgs: ["--model=moonshot-v1-128k"]
  });
  assert.deepEqual(withEquals.args, ["acp"]);
  assert.deepEqual(withEquals.env, { KIMI_MODEL_NAME: "moonshot-v1-128k" });
});

test("buildCommand starts Qoder through its ACP server", () => {
  const built = buildCommand({ adapter: "qoder-acp", prompt: "hello" });

  assert.equal(built.bin, "qodercli");
  assert.deepEqual(built.args, ["--acp"]);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildCommand forwards extra args to Qoder ACP server", () => {
  const built = buildCommand({
    adapter: "qoder-acp",
    prompt: "hello",
    extraArgs: ["--yolo", "--some-flag"]
  });

  assert.deepEqual(built.args, ["--acp", "--yolo", "--some-flag"]);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildCommand starts Grok through its ACP stdio agent", () => {
  const built = buildCommand({ adapter: "grok-acp", prompt: "hello" });

  assert.equal(built.bin, "grok");
  assert.deepEqual(built.args, ["agent", "stdio"]);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildCommand starts DeepSeek Harness through its ACP demo server", () => {
  const built = buildCommand({ adapter: "dsh-acp", prompt: "hello" });
  const config = resolveDshAcpConfigPath();

  assert.equal(built.bin, "deepseek-harness-acp");
  assert.deepEqual(built.args, ["--config", config]);
  assert.equal(fs.existsSync(config), true);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildCommand uses a workspace cordis.yml when present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acp-"));
  const local = path.join(dir, "cordis.yml");
  fs.writeFileSync(local, "- id: acp-agent\n");
  const built = buildCommand({
    adapter: "dsh-acp",
    prompt: "hello",
    cwd: dir
  });

  assert.deepEqual(built.args, ["--config", local]);
});

function withPlatform(platform, fn) {
  const original = process.platform;
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", {
      value: original,
      configurable: true
    });
  }
}

function writeManagedDshRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acp-managed-"));
  const demo = path.join(root, "node_modules", "@deepseek-ai", "dsh-acp-demo");
  fs.mkdirSync(path.join(demo, "lib"), { recursive: true });
  fs.writeFileSync(path.join(demo, "package.json"), "{}");
  const binJs = path.join(demo, "lib", "bin.js");
  fs.writeFileSync(binJs, "");
  const probe = path.join(root, "node_modules", "@deepseek-ai", "dsh-llm-deepseek");
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, "package.json"), "{}");
  const config = path.join(root, "cordis.yml");
  fs.writeFileSync(config, "- id: acp-agent\n");
  return { root, binJs, config };
}

test("buildCommand starts a managed DeepSeek ACP runtime with node", () => {
  const { root, binJs, config } = writeManagedDshRuntime();

  const built = buildCommand({
    adapter: "dsh-acp",
    prompt: "hello",
    dshAcpRuntimeRoot: root
  });

  assert.equal(built.bin, "node");
  const importFlag = dshAcpKoffiGuardImportFlag();
  assert.ok(importFlag);
  assert.deepEqual(built.args, [
    DSH_ACP_NODE_DISABLE_WARNING,
    binJs,
    "--config",
    config
  ]);
  assert.match(built.env?.NODE_OPTIONS ?? "", /--disable-warning=ExperimentalWarning/);
  assert.doesNotMatch(built.env?.NODE_OPTIONS ?? "", /koffi-guard/);
  assert.equal(built.protocol, "acp");
});

test("buildCommand prefers managed DeepSeek runtime when binary is the default demo name", () => {
  const { root, binJs } = writeManagedDshRuntime();

  for (const binary of ["dsh-acp-demo", "dsh-acp-demo.cmd", "dsh-acp-demo.exe"]) {
    const built = buildCommand({
      adapter: "dsh-acp",
      binary,
      prompt: "hello",
      dshAcpRuntimeRoot: root
    });
    assert.equal(built.bin, "node", binary);
    assert.equal(built.args.includes(binJs), true, binary);
  }
});

test("buildCommand keeps an explicit custom DeepSeek binary path", () => {
  const { root } = writeManagedDshRuntime();
  const custom = path.join(os.tmpdir(), "custom-dsh", "dsh-acp-demo");

  const built = buildCommand({
    adapter: "dsh-acp",
    binary: custom,
    prompt: "hello",
    dshAcpRuntimeRoot: root
  });

  assert.equal(built.bin, custom);
  assert.equal(built.args.includes(path.join(root, "node_modules", "@deepseek-ai", "dsh-acp-demo", "lib", "bin.js")), false);
});

test("isDefaultDshAcpBinary treats npm-global shims as the stock demo", () => {
  assert.equal(isDefaultDshAcpBinary(undefined), true);
  assert.equal(isDefaultDshAcpBinary("dsh-acp-demo"), true);
  assert.equal(isDefaultDshAcpBinary("dsh-acp-demo.cmd"), true);
  assert.equal(
    isDefaultDshAcpBinary(
      "C:/Users/Morefine/AppData/Roaming/npm/dsh-acp-demo.cmd"
    ),
    true
  );
  assert.equal(
    isDefaultDshAcpBinary(path.join(os.tmpdir(), "custom-dsh", "dsh-acp-demo")),
    false
  );
});

test("buildCommand puts koffi --import on argv on Windows when the composition uses the native sandbox", () => {
  const { root, binJs } = writeManagedDshRuntime();
  const sandbox = path.join(root, "node_modules", "@deepseek-ai", "dsh-sandbox-local");
  fs.mkdirSync(sandbox, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "package.json"), "{}");
  // The managed cordis.yml must mount the native sandbox for the guard to apply.
  fs.writeFileSync(
    path.join(root, "cordis.yml"),
    "- name: '@deepseek-ai/dsh-sandbox-local'\n"
  );

  withPlatform("win32", () => {
    const built = buildCommand({
      adapter: "dsh-acp",
      prompt: "hello",
      dshAcpRuntimeRoot: root
    });

    assert.equal(built.bin, "node");
    assert.equal(built.args.includes(binJs), true);
    const importFlag = dshAcpKoffiGuardImportFlag();
    assert.ok(importFlag);
    assert.equal(built.args.includes(importFlag), true);
  });

  withPlatform("darwin", () => {
    const built = buildCommand({
      adapter: "dsh-acp",
      prompt: "hello",
      dshAcpRuntimeRoot: root
    });
    const importFlag = dshAcpKoffiGuardImportFlag();
    assert.equal(built.args.includes(importFlag), false);
  });
});

test("buildCommand prefers managed runtime over a resolved npm-global demo shim", () => {
  const { root, binJs } = writeManagedDshRuntime();
  const built = buildCommand({
    adapter: "dsh-acp",
    binary: "C:/Users/Morefine/AppData/Roaming/npm/dsh-acp-demo.cmd",
    prompt: "hello",
    dshAcpRuntimeRoot: root
  });
  assert.equal(built.bin, "node");
  assert.equal(built.args.includes(binJs), true);
});

test("buildCommand uses a well-known npm-global demo when managed runtime is missing", () => {
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acp-appdata-"));
  const demo = path.join(
    appdata,
    "npm",
    "node_modules",
    "@deepseek-ai",
    "dsh-acp-demo"
  );
  fs.mkdirSync(path.join(demo, "lib"), { recursive: true });
  fs.writeFileSync(path.join(demo, "package.json"), "{}");
  const binJs = path.join(demo, "lib", "bin.js");
  fs.writeFileSync(binJs, "");
  const previous = process.env.APPDATA;
  process.env.APPDATA = appdata;
  try {
    const built = buildCommand({
      adapter: "dsh-acp",
      binary: "dsh-acp-demo",
      prompt: "hello",
      dshAcpRuntimeRoot: path.join(appdata, "missing-managed")
    });
    assert.equal(built.bin, "node");
    assert.equal(built.args.includes(binJs), true);
  } finally {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
  }
});

test("buildCommand keeps extra DeepSeek args after the bundled config", () => {
  const built = buildCommand({
    adapter: "dsh-acp",
    prompt: "hello",
    extraArgs: ["--verbose"]
  });

  assert.deepEqual(built.args, [
    "--config",
    resolveDshAcpConfigPath(),
    "--verbose"
  ]);
});

test("buildCommand forwards DeepSeek Harness extra args including cordis config", () => {
  const built = buildCommand({
    adapter: "dsh-acp",
    prompt: "hello",
    extraArgs: ["-c", "/tmp/acp-agent/cordis.yml"]
  });

  assert.deepEqual(built.args, ["-c", "/tmp/acp-agent/cordis.yml"]);
  assert.equal(built.protocol, "acp");
});

test("buildCommand does not override DeepSeek --config= extra args", () => {
  const built = buildCommand({
    adapter: "dsh-acp",
    prompt: "hello",
    extraArgs: ["--config=/custom/cordis.yml"]
  });

  assert.equal(extraArgsHaveDshConfig(["--config=/custom/cordis.yml"]), true);
  assert.deepEqual(built.args, ["--config=/custom/cordis.yml"]);
});

test("DeepSeek Harness ACP accepts client MCP servers", () => {
  assert.equal(adapterAcceptsClientMcpServers("dsh-acp"), true);
  assert.equal(adapterAcceptsClientMcpServers("codex-acp"), true);
  assert.equal(adapterAcceptsClientMcpServers("agy-acp"), true);
});

test("buildCommand silences Node SQLite ExperimentalWarning for DeepSeek ACP", () => {
  const built = buildCommand({ adapter: "dsh-acp", prompt: "hello" });

  assert.equal(built.bin, "deepseek-harness-acp");
  assert.equal(built.args.includes(DSH_ACP_NODE_DISABLE_WARNING), false);
  assert.match(built.env?.NODE_OPTIONS ?? "", /--disable-warning=ExperimentalWarning/);
  assert.doesNotMatch(built.env?.NODE_OPTIONS ?? "", /koffi-guard/);
});

test("isDshAcpExperimentalWarningLine matches Node sqlite warning stderr", () => {
  assert.equal(
    isDshAcpExperimentalWarningLine(
      "(node:16676) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created)"
    ),
    true
  );
  assert.equal(
    isDshAcpExperimentalWarningLine(
      "(node:16676) ExperimentalWarning: SQLite is an experimental feature and might change at any time"
    ),
    true
  );
  assert.equal(
    isDshAcpExperimentalWarningLine(
      "(Use `node --trace-warnings ...` to show where the warning was created)"
    ),
    true
  );
  assert.equal(
    isDshAcpExperimentalWarningLine("plugin tree failed to load"),
    false
  );
});

test("mergeNodeOptions appends the DeepSeek warning flag without dropping existing options", () => {
  assert.equal(
    mergeNodeOptions(undefined, DSH_ACP_NODE_DISABLE_WARNING),
    DSH_ACP_NODE_DISABLE_WARNING
  );
  assert.equal(
    mergeNodeOptions("--preserve-symlinks", DSH_ACP_NODE_DISABLE_WARNING),
    `--preserve-symlinks ${DSH_ACP_NODE_DISABLE_WARNING}`
  );
  assert.equal(
    mergeNodeOptions(DSH_ACP_NODE_DISABLE_WARNING, DSH_ACP_NODE_DISABLE_WARNING),
    DSH_ACP_NODE_DISABLE_WARNING
  );
});

test("sanitizeCliAgentEnv drops Electron crashpad variables before spawning Node CLIs", () => {
  const env = sanitizeCliAgentEnv({
    PATH: "/usr/bin",
    ELECTRON_RUN_AS_NODE: "1",
    CHROME_CRASHPAD_PIPE_NAME: "\\\\.\\pipe\\crashpad",
    ELECTRON_CRASHPAD_PIPE_NAME: "\\\\.\\pipe\\electron-crashpad",
    NODE_OPTIONS: "--require /app/asar/hook.js --disable-warning=ExperimentalWarning",
    DEEPSEEK_API_KEY: "sk-test"
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.DEEPSEEK_API_KEY, "sk-test");
  assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
  assert.equal("CHROME_CRASHPAD_PIPE_NAME" in env, false);
  assert.equal("ELECTRON_CRASHPAD_PIPE_NAME" in env, false);
  assert.equal(env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning");
});

test("ensureDshAcpCwd falls back to the managed runtime workspace when cwd is missing", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acp-cwd-"));
  const fallback = ensureDshAcpCwd(undefined, dataDir);
  assert.equal(fallback, path.join(dshAcpManagedRoot(dataDir), "workspace"));
  assert.equal(fs.existsSync(fallback), true);
  assert.equal(ensureDshAcpCwd(" /tmp/project ", dataDir), "/tmp/project");
});

test("formatAcpAgentExitMessage explains Windows access violation 0xC0000005", () => {
  assert.equal(isWindowsAccessViolationExit(3221225477), true);
  assert.equal(isWindowsAccessViolationExit(-1073741819), true);
  assert.equal(isWindowsAccessViolationExit(1), false);
  assert.match(
    formatAcpAgentExitMessage(3221225477, "zh-CN", "dsh-acp"),
    /访问冲突/
  );
  assert.match(
    formatAcpAgentExitMessage(3221225477, "zh-CN", "dsh-acp"),
    /session\/prompt/
  );
  assert.match(
    formatAcpAgentExitMessage(3221225477, "zh-CN", "dsh-acp"),
    /MoveFileExW/
  );
  assert.match(
    formatAcpAgentExitMessage(3221225477, "zh-CN", "dsh-acp"),
    /导出调试日志/
  );
  assert.doesNotMatch(
    formatAcpAgentExitMessage(3221225477, "zh-CN", "dsh-acp"),
    /关掉 ACL sandbox/
  );
  assert.doesNotMatch(
    formatAcpAgentExitMessage(3221225477, "en", "dsh-acp"),
    /disables the ACL sandbox/
  );
  assert.doesNotMatch(
    formatAcpAgentExitMessage(3221225477, "zh-CN", "dsh-acp"),
    /请用本版本重新编译后再试。$/
  );
  assert.match(
    formatAcpAgentExitMessage(3221225477, "en", "dsh-acp"),
    /access violation/i
  );
  assert.match(
    formatAcpAgentExitMessage(3221225477, "en", "dsh-acp"),
    /MoveFileExW/
  );
  assert.match(
    formatAcpAgentExitMessage(3221225477, "en", "dsh-acp"),
    /debug logs/i
  );

  // Other ACP adapters must receive generic error messages without DeepSeek/koffi mentions
  const genericZh = formatAcpAgentExitMessage(3221225477, "zh-CN", "codex");
  assert.match(genericZh, /访问冲突/);
  assert.doesNotMatch(genericZh, /DeepSeek/i);
  assert.doesNotMatch(genericZh, /MoveFileExW/);

  const genericEn = formatAcpAgentExitMessage(3221225477, "en", "codex");
  assert.match(genericEn, /access violation/i);
  assert.doesNotMatch(genericEn, /DeepSeek/i);
  assert.doesNotMatch(genericEn, /MoveFileExW/);
});

function writePlaceholderDshRuntime(root) {
  const jsonlDir = path.join(
    root,
    "node_modules",
    "@deepseek-ai",
    "dsh-session-persistence-jsonl",
    "lib"
  );
  const demoDir = path.join(
    root,
    "node_modules",
    "@deepseek-ai",
    "dsh-acp-demo",
    "lib"
  );
  fs.mkdirSync(jsonlDir, { recursive: true });
  fs.mkdirSync(demoDir, { recursive: true });
  const jsonl = path.join(jsonlDir, "index.js");
  const demo = path.join(demoDir, "index.js");
  fs.writeFileSync(jsonl, 'await import("koffi");\n');
  fs.writeFileSync(demo, "official-demo\n");
  return { jsonl, demo };
}

test("DeepSeek harness overlay never loads koffi", () => {
  const overlay = dshHarnessOverlayDir();
  const jsonl = fs.readFileSync(
    path.join(overlay, "dsh-session-persistence-jsonl", "lib", "index.js"),
    "utf8"
  );
  const demo = fs.readFileSync(
    path.join(overlay, "dsh-acp-demo", "lib", "index.js"),
    "utf8"
  );
  assert.doesNotMatch(jsonl, /koffi/);
  assert.doesNotMatch(jsonl, /MoveFileExW/);
  assert.match(jsonl, /async function publishNewFileWin32/);
  assert.match(jsonl, /await rename\(/);
  assert.match(demo, /openAt:\s*"never"/);
});

test("patchDshAcpManagedRuntime is a no-op when DeepSeek packages are missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acp-missing-"));
  assert.doesNotThrow(() => patchDshAcpManagedRuntime(root));
});

test("patchDshAcpManagedRuntime overlays the harness fork onto an installed runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acp-patch-"));
  const files = writePlaceholderDshRuntime(root);
  patchDshAcpManagedRuntime(root);
  const overlay = dshHarnessOverlayDir();
  assert.equal(
    fs.readFileSync(files.jsonl, "utf8"),
    fs.readFileSync(
      path.join(overlay, "dsh-session-persistence-jsonl", "lib", "index.js"),
      "utf8"
    )
  );
  assert.equal(
    fs.readFileSync(files.demo, "utf8"),
    fs.readFileSync(path.join(overlay, "dsh-acp-demo", "lib", "index.js"), "utf8")
  );
  patchDshAcpManagedRuntime(root);
  assert.doesNotMatch(fs.readFileSync(files.jsonl, "utf8"), /koffi/);
});

test("syncDshAcpManagedConfig patches an already-installed DeepSeek runtime", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acp-sync-"));
  const root = dshAcpManagedRoot(dataDir);
  const files = writePlaceholderDshRuntime(root);
  assert.equal(syncDshAcpManagedConfig(dataDir), root);
  assert.equal(fs.existsSync(path.join(root, "cordis.yml")), true);
  assert.doesNotMatch(fs.readFileSync(files.jsonl, "utf8"), /koffi/);
  assert.match(fs.readFileSync(files.demo, "utf8"), /openAt:\s*"never"/);
});

test("patchDshAcpManagedRuntime overlays nested node_modules copies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acp-nested-"));
  const nested = path.join(
    root,
    "node_modules",
    "@deepseek-ai",
    "dsh-acp",
    "node_modules",
    "@deepseek-ai",
    "dsh-session-persistence-jsonl",
    "lib"
  );
  fs.mkdirSync(nested, { recursive: true });
  const dest = path.join(nested, "index.js");
  fs.writeFileSync(dest, 'await import("koffi");\n');
  patchDshAcpManagedRuntime(root);
  assert.doesNotMatch(fs.readFileSync(dest, "utf8"), /koffi/);
  assert.deepEqual(dshAcpJsonlStillUsesKoffi(root), []);
});

test("buildDshAcpRuntimeDiagnostics reports leftover koffi and cordis safety flags", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acp-diag-"));
  const files = writePlaceholderDshRuntime(root);
  const aclLib = path.join(
    root,
    "node_modules",
    "@deepseek-ai",
    "dsh-sandbox-windows-acl",
    "lib"
  );
  fs.mkdirSync(aclLib, { recursive: true });
  fs.writeFileSync(path.join(aclLib, "index.js"), 'await import("koffi");\n');
  fs.writeFileSync(
    path.join(root, "cordis.yml"),
    [
      "- id: sandbox",
      "  name: '@deepseek-ai/dsh-sandbox-local'",
      "  disabled: !!js process.platform === 'win32'",
      "- id: acp-agent",
      "  name: '@deepseek-ai/dsh-acp-demo'",
      "  config:",
      "    persistenceCompression: none",
      ""
    ].join("\n")
  );

  const before = buildDshAcpRuntimeDiagnostics({ runtimeRoot: root });
  assert.equal(before.runtimePresent, true);
  assert.equal(before.jsonlCopyCount, 1);
  assert.equal(before.jsonlKoffiCopyCount, 1);
  assert.equal(before.windowsAclPresent, true);
  assert.equal(before.windowsAclUsesKoffi, true);
  assert.equal(before.persistenceCompressionNone, true);
  assert.equal(before.sandboxDisabledOnWin32, true);
  assert.equal(before.koffiGuardPresent, true);
  assert.equal(before.koffiGuardOnArgv, false);
  assert.equal(before.jsonlRelatives[0]?.usesKoffi, true);
  assert.doesNotMatch(JSON.stringify(before), /home|Users|AppData/i);

  patchDshAcpManagedRuntime(root);
  const after = buildDshAcpRuntimeDiagnostics({ runtimeRoot: root });
  assert.equal(after.jsonlKoffiCopyCount, 0);
  assert.equal(fs.readFileSync(files.jsonl, "utf8").includes("koffi"), false);
});

test("koffi guard redirects koffi to a JavaScript stub", async () => {
  const { execFileSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const guard = dshAcpKoffiGuardPath();
  assert.equal(fs.existsSync(guard), true);
  const script = [
    "const k = await import('koffi');",
    "const api = (k.default ?? k).load('kernel32.dll');",
    "const fn = api.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']);",
    "process.stdout.write(JSON.stringify({ result: fn('a', 'b', 8), stub: true }));"
  ].join("");
  const stdout = execFileSync(
    process.execPath,
    ["--import", pathToFileURL(guard).href, "--input-type=module", "-e", script],
    { encoding: "utf8" }
  );
  assert.deepEqual(JSON.parse(stdout), { result: 0, stub: true });
});

test("patchDshAcpRuntimeFromBin overlays the install prefix of a demo bin", () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acp-bin-"));
  const files = writePlaceholderDshRuntime(prefix);
  const demo = path.join(
    prefix,
    "node_modules",
    "@deepseek-ai",
    "dsh-acp-demo"
  );
  fs.writeFileSync(path.join(demo, "package.json"), "{}");
  const bin = path.join(demo, "lib", "bin.js");
  fs.writeFileSync(bin, "");
  patchDshAcpRuntimeFromBin(bin);
  assert.doesNotMatch(fs.readFileSync(files.jsonl, "utf8"), /koffi/);
});

test("buildCommand keeps Grok global flags before the ACP subcommand", () => {
  const built = buildCommand({
    adapter: "grok-acp",
    prompt: "hello",
    extraArgs: ["--model=grok-4.5", "--effort", "low", "--always-approve"]
  });

  assert.deepEqual(built.args, [
    "--model=grok-4.5",
    "--effort",
    "low",
    "--always-approve",
    "agent",
    "stdio"
  ]);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildInitializeRequest advertises only implemented stable capabilities", () => {
  assert.deepEqual(buildInitializeRequest(7, "0.4.9-test"), {
    jsonrpc: "2.0",
    id: 7,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        terminal: true,
        auth: { terminal: true }
      },
      clientInfo: {
        name: "freebuddy",
        title: "FreeBuddy",
        version: "0.4.9-test"
      }
    }
  });
});

test("ACP auth request builders use stable v1 method shapes", () => {
  assert.deepEqual(buildAuthenticateRequest(8, "agent-login"), {
    jsonrpc: "2.0",
    id: 8,
    method: "authenticate",
    params: { methodId: "agent-login" }
  });
  assert.deepEqual(buildLogoutRequest(9), {
    jsonrpc: "2.0",
    id: 9,
    method: "logout",
    params: {}
  });
});

test("ACP auth selection prefers available API keys, otherwise interactive login", () => {
  const methods = [
    {
      id: "api-key",
      name: "API Key",
      _meta: { "api-key": { provider: "openai" } }
    },
    { id: "chat-gpt", name: "ChatGPT" }
  ];

  assert.equal(selectAcpAuthMethod(methods, {})?.id, "chat-gpt");
  assert.equal(
    selectAcpAuthMethod(methods, { ANTHROPIC_API_KEY: "unrelated-key" })?.id,
    "chat-gpt"
  );
  assert.equal(
    selectAcpAuthMethod(methods, { OPENAI_API_KEY: "test-key" })?.id,
    "api-key"
  );
  assert.equal(
    selectAcpAuthMethod(
      [{ id: "login", type: "terminal", name: "Login" }],
      {}
    )?.id,
    "login"
  );
  assert.equal(
    selectAcpAuthMethod(
      [
        { id: "ioa", name: "Login with iOA" },
        { id: "external", name: "Login with Google/GitHub" }
      ],
      {}
    ),
    undefined
  );
});

test("terminal/output uses the stable ACP exitStatus shape", () => {
  assert.deepEqual(
    buildTerminalOutputResponse({
      output: "done",
      truncated: false,
      exited: true,
      exitCode: 0,
      signal: null
    }),
    {
      output: "done",
      truncated: false,
      exitStatus: { exitCode: 0, signal: null }
    }
  );
  assert.deepEqual(
    buildTerminalOutputResponse({
      output: "running",
      truncated: false,
      exited: false
    }),
    { output: "running", truncated: false }
  );
});

test("buildSessionPromptRequest sends a text content block", () => {
  assert.deepEqual(buildSessionPromptRequest(8, "sess-1", "hello"), {
    jsonrpc: "2.0",
    id: 8,
    method: "session/prompt",
    params: {
      sessionId: "sess-1",
      prompt: [{ type: "text", text: "hello" }]
    }
  });
});

test("buildSessionSetConfigOptionRequest shapes stable ACP params", () => {
  assert.deepEqual(buildSessionSetConfigOptionRequest(7, "sess-1", "model", "m2"), {
    jsonrpc: "2.0",
    id: 7,
    method: "session/set_config_option",
    params: {
      sessionId: "sess-1",
      configId: "model",
      value: "m2"
    }
  });
});

test("buildSessionLoadRequest loads Cursor-style ACP sessions", () => {
  assert.deepEqual(buildSessionLoadRequest(9, "sess-1", "/tmp/project"), {
    jsonrpc: "2.0",
    id: 9,
    method: "session/load",
    params: {
      sessionId: "sess-1",
      cwd: "/tmp/project",
      mcpServers: []
    }
  });
});

test("isMissingSavedSessionError recognizes Cursor Invalid params Session not found", () => {
  const cursorErr = Object.assign(new Error("Invalid params"), {
    code: -32602,
    data: {
      message: 'Session "8140ff9a-7f50-426d-987e-3e8c5c2b0ece" not found'
    }
  });
  assert.equal(isMissingSavedSessionError(cursorErr), true);

  const resourceErr = Object.assign(new Error("Resource not found"), {
    code: -32002
  });
  assert.equal(isMissingSavedSessionError(resourceErr), true);

  const authErr = Object.assign(new Error("Authentication required"), {
    code: -32000
  });
  assert.equal(isMissingSavedSessionError(authErr), false);

  const cursorInitErr = Object.assign(new Error("Internal error"), {
    code: -32603,
    data: {
      message: "Failed to initialize session services"
    }
  });
  assert.equal(isMissingSavedSessionError(cursorInitErr), true);

  const invalidParamsUnrelated = Object.assign(new Error("Invalid params"), {
    code: -32602
  });
  assert.equal(isMissingSavedSessionError(invalidParamsUnrelated), false);
});

test("ACP session lifecycle injects FreeBuddy stdio MCP servers", () => {
  const mcpServers = [
    {
      name: "freebuddy-browser",
      command: "/Applications/FreeBuddy",
      args: ["/app/dist-electron/mcp/browserMcpServer.js"],
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "FREEBUDDY_BROWSER_TOKEN", value: "token" }
      ]
    }
  ];

  assert.deepEqual(buildSessionNewRequest(1, "/tmp/project", mcpServers), {
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: { cwd: "/tmp/project", mcpServers }
  });
  assert.deepEqual(
    buildSessionResumeRequest(2, "sess-1", "/tmp/project", mcpServers),
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/resume",
      params: { sessionId: "sess-1", cwd: "/tmp/project", mcpServers }
    }
  );
  assert.deepEqual(
    buildSessionLoadRequest(3, "sess-1", "/tmp/project", mcpServers),
    {
      jsonrpc: "2.0",
      id: 3,
      method: "session/load",
      params: { sessionId: "sess-1", cwd: "/tmp/project", mcpServers }
    }
  );
});

test("ACP session setup can forward Claude SDK settings through _meta", () => {
  const sessionMeta = {
    claudeCode: {
      options: {
        settings: {
          autoCompactEnabled: true,
          autoCompactWindow: 150000
        }
      }
    }
  };
  assert.deepEqual(
    buildSessionNewRequest(4, "/tmp/project", [], sessionMeta),
    {
      jsonrpc: "2.0",
      id: 4,
      method: "session/new",
      params: {
        cwd: "/tmp/project",
        mcpServers: [],
        _meta: sessionMeta
      }
    }
  );
  assert.deepEqual(
    buildSessionResumeRequest(5, "sess-1", "/tmp/project", [], sessionMeta)
      .params._meta,
    sessionMeta
  );
});

test("ACP runtime authenticates standard auth-required errors and recovers missing sessions", () => {
  assert.match(acpRuntimeSource, /isAuthenticationRequiredError/);
  assert.match(acpRuntimeSource, /e\?\.code === -32000/);
  assert.match(
    acpRuntimeSource,
    /buildAuthenticateRequest\(nextId\(\), method\.id\)/
  );
  assert.match(
    acpRuntimeSource,
    /requestedToolSessionId\s*&&\s*isMissingSavedSessionError\(sessionErr\)/
  );
  assert.match(acpRuntimeSource, /abandonStaleToolSession/);
  assert.match(
    acpRuntimeSource,
    /Previous agent session is no longer available; starting a fresh session/
  );
  assert.match(
    acpRuntimeSource,
    /abandonStaleToolSession\(requestedToolSessionId, sessionErr\);\s*await establishSession\(\);/
  );
  assert.match(acpRuntimeSource, /Unsupported ACP protocol version/);
});

test("ACP runtime starts a fresh session once when a prompt exceeds context", () => {
  assert.match(acpRuntimeSource, /isContextWindowError/);
  assert.match(acpRuntimeSource, /contextResetAttempted/);
  assert.match(acpRuntimeSource, /requestedToolSessionId = undefined/);
  assert.match(
    acpRuntimeSource,
    /buildSessionNewRequest\(nextId\(\), args\.cwd, mcpServers, sessionMeta\)/
  );
});

test("ACP tool-call activity tracks silent in-flight tools until terminal updates", () => {
  const active = new Set();
  updateActiveAcpToolCalls(active, {
    sessionUpdate: "tool_call",
    toolCallId: "job-1",
    status: "in_progress"
  });
  assert.deepEqual([...active], ["job-1"]);
  updateActiveAcpToolCalls(active, {
    sessionUpdate: "tool_call_update",
    toolCallId: "job-1",
    status: "completed"
  });
  assert.equal(active.size, 0);
});

test("DeepSeek session health policy retries one empty resume and discards unhealthy sessions", () => {
  assert.equal(
    shouldRetryEmptyResumedDshTurn({
      adapter: "dsh-acp",
      resumed: true,
      promptHadContent: false,
      resetAttempted: false
    }),
    true
  );
  assert.equal(
    shouldRetryEmptyResumedDshTurn({
      adapter: "dsh-acp",
      resumed: true,
      promptHadContent: false,
      resetAttempted: true
    }),
    false,
    "a second empty fresh turn must not start an infinite retry loop"
  );
  assert.equal(
    shouldDiscardAcpToolSession({
      adapter: "dsh-acp",
      status: "failed",
      promptStarted: true,
      promptHadContent: true,
      turnHadTerminalError: false
    }),
    true
  );
  assert.equal(
    shouldDiscardAcpToolSession({
      adapter: "dsh-acp",
      status: "done",
      promptStarted: true,
      promptHadContent: false,
      turnHadTerminalError: false
    }),
    true
  );
  assert.equal(
    shouldDiscardAcpToolSession({
      adapter: "dsh-acp",
      status: "done",
      promptStarted: true,
      promptHadContent: true,
      turnHadTerminalError: false
    }),
    false
  );
  assert.equal(
    shouldDiscardAcpToolSession({
      adapter: "codex-acp",
      status: "failed",
      promptStarted: true,
      promptHadContent: false,
      turnHadTerminalError: false
    }),
    false,
    "the compatibility policy is intentionally limited to DeepSeek Harness"
  );
});

test("ACP runtime reset instruction is fixed English for reliable model compliance", () => {
  assert.match(
    acpRuntimeSource,
    /activePrompt = \[\s*args\.prompt\.trimEnd\(\),\s*"",\s*contextResetInstruction\(\)\s*\]/,
    "reset instruction must be applied via the helper"
  );
  assert.match(
    acpRuntimeSource,
    /The previous agent session reached its context limit/,
    "reset instruction must be the fixed English agent-facing string"
  );
  assert.equal(
    /之前的智能体会话已达到上下文上限/.test(acpRuntimeSource),
    false,
    "reset instruction must not be localized; it is sent to the model"
  );
});

test("ACP runtime surfaces a friendly error when a fresh session still exceeds context", () => {
  assert.match(acpRuntimeSource, /contextWindowExceededAfterResetError/);
  assert.match(
    acpRuntimeSource,
    /重置会话后，请求仍超出模型的上下文窗口/,
    "friendly after-reset error must have a Simplified Chinese translation"
  );
  assert.match(
    acpRuntimeSource,
    /The request still exceeds the model's context window even after starting a fresh agent session/,
    "friendly after-reset error must explain the reset path is exhausted"
  );
});

test("parseAcpLine parses JSON-RPC messages and ignores blank lines", () => {
  assert.equal(parseAcpLine(""), undefined);
  assert.deepEqual(parseAcpLine('{"jsonrpc":"2.0","id":1,"result":{}}'), {
    jsonrpc: "2.0",
    id: 1,
    result: {}
  });
});

test("acpUpdateToItems maps message, thought, tool, session and usage updates", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hi" }
    }),
    [{ kind: "text", role: "assistant", content: "Hi", append: true }]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Thinking" }
    }),
    [{ kind: "thinking", content: "Thinking", append: true }]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Run tests",
      kind: "execute",
      rawInput: { command: "npm test" }
    }),
    [
      {
        kind: "tool-call",
        id: "tool-1",
        tool: "Run tests",
        input: { command: "npm test" },
        status: "pending",
        toolKind: "execute",
        toolOutputs: [{ kind: "command", command: "npm test" }]
      }
    ]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "usage_update",
      used: 53000,
      size: 200000,
      cost: { amount: 0.045, currency: "USD" }
    }),
    [
      {
        kind: "usage",
        contextUsed: 53000,
        contextSize: 200000,
        costAmount: 0.045,
        costCurrency: "USD"
      }
    ]
  );
});

test("acpUpdateToItems maps session metadata, commands and config options", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "session_info_update",
      sessionId: "sess-2",
      title: "Work",
      updatedAt: "2026-06-23T12:00:00.000Z"
    }),
    [
      {
        kind: "session",
        sessionId: "sess-2",
        title: "Work",
        updatedAt: "2026-06-23T12:00:00.000Z"
      }
    ]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "brainstorming", description: "Explore ideas" }]
    }),
    [
      {
        kind: "available-commands",
        commands: [{ name: "brainstorming", description: "Explore ideas" }]
      }
    ]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "gpt-5",
          options: {
            values: [{ id: "gpt-5", name: "GPT-5" }]
          }
        }
      ]
    }),
    [
      {
        kind: "config-options",
        options: [
          {
            id: "model",
            name: "Model",
            type: "select",
            category: "model",
            currentValue: "gpt-5",
            currentLabel: "GPT-5",
            values: [{ id: "gpt-5", name: "GPT-5" }]
          }
        ]
      }
    ]
  );
});

test("acpUpdateToItems surfaces codex gateway errors and marks permanent 4xx terminal", () => {
  // Real shape from codex-acp 1.1.7 when an upstream gateway returns HTTP 422
  // and codex begins its Reconnecting 1..5 retry loop (issues #340 / #355).
  const retrying = acpUpdateToItems({
    sessionUpdate: "session_info_update",
    sessionId: "019fcd3a-5586-7932-8860-b6fb71aafbfd",
    _meta: {
      codex: {
        error: {
          message: "Reconnecting... 1/5",
          additionalDetails:
            "unexpected status 422 Unprocessable Entity: content input null",
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: 422 }
          },
          willRetry: true
        }
      }
    }
  });
  assert.deepEqual(retrying, [
    {
      kind: "session",
      sessionId: "019fcd3a-5586-7932-8860-b6fb71aafbfd"
    },
    {
      kind: "error",
      message:
        "Upstream gateway error (HTTP 422): content input null — the request was rejected; the turn did not complete.",
      details: [
        "Retry attempt 1.",
        "Reconnecting... 1/5",
        "unexpected status 422 Unprocessable Entity: content input null"
      ],
      terminal: true
    }
  ]);

  // No session fields, only the structured error: still emit the error item
  // so retries never render as silent assistant replies.
  const errorOnly = acpUpdateToItems({
    sessionUpdate: "session_info_update",
    _meta: {
      codex: {
        error: {
          message: "Reconnecting... 5/5",
          additionalDetails: "unexpected status 422 Unprocessable Entity",
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: 422 }
          },
          willRetry: false
        }
      }
    }
  });
  assert.deepEqual(errorOnly, [
    {
      kind: "error",
      message:
        "Upstream gateway error (HTTP 422) — the request was rejected; the turn did not complete.",
      details: [
        "Retry attempt 5.",
        "Reconnecting... 5/5",
        "unexpected status 422 Unprocessable Entity"
      ],
      terminal: true
    }
  ]);

  // Provider reasons surface in the headline instead of the collapsed log,
  // including gateway-specific bodies relayed by the local bridge (url suffix
  // stripped, reason stable across retries so dedupe still collapses them).
  const balance = acpUpdateToItems({
    sessionUpdate: "session_info_update",
    _meta: {
      codex: {
        error: {
          message: "Reconnecting... 1/5",
          additionalDetails:
            "unexpected status 403 Forbidden: Insufficient account balance, url: http://127.0.0.1:61874/v1/chat81e2eadc6030/responses",
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: 403 }
          },
          willRetry: true
        }
      }
    }
  });
  assert.equal(
    balance[0].message,
    "Upstream gateway error (HTTP 403): Insufficient account balance — the request was rejected; the turn did not complete."
  );
  assert.equal(balance[0].terminal, true);
  const balanceRetry = acpUpdateToItems({
    sessionUpdate: "session_info_update",
    _meta: {
      codex: {
        error: {
          message: "Reconnecting... 2/5",
          additionalDetails:
            "unexpected status 403 Forbidden: Insufficient account balance, url: http://127.0.0.1:61874/v1/chat81e2eadc6030/responses",
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: 403 }
          },
          willRetry: true
        }
      }
    }
  });
  assert.equal(balance[0].message, balanceRetry[0].message);

  assert.equal(
    acpNonRetryableUpstreamError({
      ...balanceRetry[0],
      _meta: {
        codex: {
          error: {
            message: "Reconnecting... 2/5",
            additionalDetails:
              "unexpected status 403 Forbidden: Insufficient account balance (request id: req-secret)",
            codexErrorInfo: {
              responseStreamDisconnected: { httpStatusCode: 403 }
            },
            willRetry: true
          }
        }
      }
    }),
    "Upstream gateway error (HTTP 403): Insufficient account balance — the request was rejected; the turn did not complete."
  );

  // Stable headline across retry attempts: attempt 1 and 2 produce the same
  // message so downstream adjacent-error dedupe collapses them into one entry.
  const attempt1 = acpUpdateToItems({
    sessionUpdate: "session_info_update",
    _meta: {
      codex: {
        error: {
          message: "Reconnecting... 1/5",
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 422 } },
          willRetry: true
        }
      }
    }
  });
  const attempt2 = acpUpdateToItems({
    sessionUpdate: "session_info_update",
    _meta: {
      codex: {
        error: {
          message: "Reconnecting... 2/5",
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 422 } },
          willRetry: true
        }
      }
    }
  });
  assert.equal(attempt1[0].message, attempt2[0].message);

  // Non-codex _meta (or missing error) is ignored — backward compatible.
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "session_info_update",
      sessionId: "s1",
      _meta: { kimi: { session: { title: "hi" } } }
    }),
    [{ kind: "session", sessionId: "s1" }]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "session_info_update",
      sessionId: "s1"
    }),
    [{ kind: "session", sessionId: "s1" }]
  );
});

test("acpUpdateToItems never renders terminal Codex failures as assistant text", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "unexpected status 403 Forbidden: deposit required"
      }
    }),
    [
      {
        kind: "error",
        message: "The upstream model request failed; the turn did not complete.",
        details: ["unexpected status 403 Forbidden: deposit required"],
        terminal: true
      }
    ]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "session_info_update",
      _meta: { codex: { threadStatus: { type: "systemError" } } }
    }),
    [
      {
        kind: "error",
        message: "Codex reported a system error; the turn did not complete.",
        terminal: true
      }
    ]
  );
});

test("buildPromptContentBlocks maps text and resource links for attachments", () => {
  assert.deepEqual(buildPromptContentBlocks("hello"), [{ type: "text", text: "hello" }]);
  const blocks = buildPromptContentBlocks("see file", [
    {
      path: "/tmp/readme.md",
      kind: "document",
      mimeType: "text/markdown",
      name: "readme.md"
    }
  ]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: "text", text: "see file" });
  assert.equal(blocks[1].type, "resource_link");
  assert.match(String(blocks[1].uri), /readme\.md$/);
});

test("acpUpdateToItems ignores ACP control updates that are not chat content", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "current_mode_update",
      currentModeId: "build"
    }),
    []
  );
});

test("acpUpdateToItems maps OpenCode todo tool calls as plan updates", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call",
      toolCallId: "call_todos",
      title: "7 todos",
      kind: "other",
      status: "pending",
      rawInput: {
        todos: [
          {
            content: "Explore project context",
            status: "completed",
            priority: "high"
          },
          {
            content: "Ask clarifying questions",
            status: "in_progress",
            priority: "high"
          },
          {
            content: "Write implementation plan",
            status: "pending",
            priority: "medium"
          }
        ]
      }
    }),
    [
      {
        kind: "plan",
        entries: [
          {
            content: "Explore project context",
            status: "completed",
            priority: "high"
          },
          {
            content: "Ask clarifying questions",
            status: "in_progress",
            priority: "high"
          },
          {
            content: "Write implementation plan",
            status: "pending",
            priority: "medium"
          }
        ]
      }
    ]
  );
});

test("acpUpdateToItems maps OpenCode todo metadata updates as plan updates", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_todowrite",
      title: "todowrite",
      kind: "other",
      status: "completed",
      rawOutput: {
        metadata: {
          todos: [
            {
              content: "Handoff execution",
              status: "in_progress",
              priority: "medium"
            }
          ]
        }
      }
    }),
    [
      {
        kind: "plan",
        entries: [
          {
            content: "Handoff execution",
            status: "in_progress",
            priority: "medium"
          }
        ]
      }
    ]
  );
});

test("acpUpdateToItems ignores mode updates that are not chat content", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "current_mode_update",
      currentModeId: "build"
    }),
    []
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "config_option_update",
      configOptions: []
    }),
    []
  );
});

test("acpUpdateToItems ignores ACP user message chunks because FreeBuddy renders user messages separately", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "user_message_chunk",
      messageId: "msg-user-1",
      content: { type: "text", text: "nihao" }
    }),
    []
  );
});

test("contentBlockToItems maps ACP ContentBlock variants", () => {
  assert.deepEqual(
    contentBlockToItems({ type: "text", text: "Hello" }, { role: "assistant", append: true }),
    [{ kind: "text", role: "assistant", content: "Hello", append: true }]
  );
  assert.deepEqual(
    contentBlockToItems({ type: "text", text: "Plan" }, { asThinking: true, append: true }),
    [{ kind: "thinking", content: "Plan", append: true }]
  );
  assert.deepEqual(
    contentBlockToItems({
      type: "image",
      mimeType: "image/png",
      data: "aGVsbG8="
    }),
    [
      {
        kind: "content-block",
        blockType: "image",
        mimeType: "image/png",
        data: "aGVsbG8="
      }
    ]
  );
  assert.deepEqual(
    contentBlockToItems({
      type: "audio",
      mimeType: "audio/wav",
      data: "YXVkaW8="
    }),
    [
      {
        kind: "content-block",
        blockType: "audio",
        mimeType: "audio/wav",
        data: "YXVkaW8="
      }
    ]
  );
  assert.deepEqual(
    contentBlockToItems({
      type: "resource_link",
      uri: "file:///tmp/readme.md",
      name: "readme.md",
      title: "README",
      mimeType: "text/markdown",
      size: 2048
    }),
    [
      {
        kind: "content-block",
        blockType: "resource_link",
        uri: "file:///tmp/readme.md",
        name: "readme.md",
        title: "README",
        mimeType: "text/markdown",
        size: 2048
      }
    ]
  );
  assert.deepEqual(
    contentBlockToItems({
      type: "resource",
      resource: {
        uri: "file:///tmp/context.txt",
        mimeType: "text/plain",
        text: "embedded context"
      }
    }),
    [
      {
        kind: "content-block",
        blockType: "resource",
        uri: "file:///tmp/context.txt",
        mimeType: "text/plain",
        text: "embedded context"
      }
    ]
  );
});

test("acpUpdateToItems maps image and resource_link message chunks", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "image",
        mimeType: "image/jpeg",
        data: "Zm9v"
      }
    }),
    [
      {
        kind: "content-block",
        blockType: "image",
        mimeType: "image/jpeg",
        data: "Zm9v"
      }
    ]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        uri: "/workspace/README.md",
        name: "README.md"
      }
    }),
    [
      {
        kind: "content-block",
        blockType: "resource_link",
        uri: "/workspace/README.md",
        name: "README.md"
      }
    ]
  );
});

test("acpUpdateToItems maps tool_call_update content blocks", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-4",
      title: "Read file",
      content: [
        {
          type: "content",
          content: {
            type: "resource",
            resource: {
              mimeType: "text/plain",
              text: "file body"
            }
          }
        }
      ]
    }),
    [
      {
        kind: "tool-call",
        id: "tool-4",
        tool: "Read file",
        toolOutputs: [
          {
            kind: "content-block",
            blockType: "resource",
            mimeType: "text/plain",
            text: "file body"
          }
        ],
        replaceToolOutputs: true
      }
    ]
  );
});

test("acpUpdateToItems maps structured tool_call_update diff and terminal content", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-5",
      title: "Edit file",
      kind: "edit",
      status: "running",
      locations: [{ path: "/tmp/app.ts", line: 12 }],
      content: [
        {
          type: "diff",
          path: "/tmp/app.ts",
          oldText: "const a = 1;",
          newText: "const a = 2;"
        },
        {
          type: "terminal",
          terminalId: "term-1"
        }
      ]
    }),
    [
      {
        kind: "tool-call",
        id: "tool-5",
        tool: "Edit file",
        status: "running",
        toolKind: "edit",
        locations: [{ path: "/tmp/app.ts", line: 12 }],
        toolOutputs: [
          {
            kind: "file-edit",
            path: "/tmp/app.ts",
            action: "update",
            oldText: "const a = 1;",
            newText: "const a = 2;"
          },
          { kind: "terminal-embed", terminalId: "term-1" }
        ],
        replaceToolOutputs: true
      }
    ]
  );
});

test("acpUpdateToItems keeps legacy tool_call_update without toolCallId", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call_update",
      title: "Run tests",
      rawOutput: "ok",
      status: "completed"
    }),
    [{ kind: "tool-result", tool: "Run tests", content: "ok" }]
  );
});

test("acpUpdateToItems carries messageId for agent chunks", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_message_chunk",
      messageId: "msg-a-1",
      content: { type: "text", text: "Hi" }
    }),
    [
      {
        kind: "text",
        role: "assistant",
        content: "Hi",
        append: true,
        messageId: "msg-a-1"
      }
    ]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_thought_chunk",
      messageId: "msg-t-1",
      content: { type: "text", text: "Thinking" }
    }),
    [
      {
        kind: "thinking",
        content: "Thinking",
        append: true,
        messageId: "msg-t-1"
      }
    ]
  );
});

test("shouldEmitAcpUpdate suppresses replay updates before the current prompt starts", () => {
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "previous answer" }
      },
      { promptStarted: false, replaySuppressionEnabled: false }
    ),
    false
  );
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "current answer" }
      },
      { promptStarted: true, replaySuppressionEnabled: false }
    ),
    true
  );
});

test("shouldEmitAcpUpdate always emits session metadata updates", () => {
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "session_info_update",
        title: "Renamed session"
      },
      { promptStarted: false, replaySuppressionEnabled: false }
    ),
    true
  );
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "config_option_update",
        configOptions: [{ id: "model", name: "Model", type: "select" }]
      },
      { promptStarted: false, replaySuppressionEnabled: false }
    ),
    true
  );
});

test("saved ACP sessions that fall back to session/new keep matching live chunks", () => {
  const sessionStartMode = selectAcpSessionStartMode("saved-session", {
    sessionCapabilities: {}
  });
  const replayContentSignatures = new Set(["same as a previous answer"]);

  assert.equal(sessionStartMode, "new");
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "same as a previous answer" }
      },
      {
        promptStarted: true,
        replaySuppressionEnabled: sessionStartMode !== "new",
        replayContentSignatures
      }
    ),
    true
  );
});

test("shouldEmitAcpUpdate suppresses persisted messageId replay after prompt starts", () => {
  const replayMessageIds = new Set(["msg-old-1"]);
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-old-1",
        content: { type: "text", text: "previous answer" }
      },
      {
        promptStarted: true,
        replaySuppressionEnabled: true,
        replayMessageIds
      }
    ),
    false
  );
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-new-1",
        content: { type: "text", text: "fresh answer" }
      },
      {
        promptStarted: true,
        replaySuppressionEnabled: true,
        replayMessageIds
      }
    ),
    true
  );
});

test("shouldEmitAcpUpdate suppresses replayed tool calls by toolCallId", () => {
  const replayMessageIds = new Set(["tool-old-1"]);
  assert.equal(
    shouldEmitAcpUpdate(
      { sessionUpdate: "tool_call", toolCallId: "tool-old-1", title: "Read" },
      {
        promptStarted: true,
        replaySuppressionEnabled: true,
        replayMessageIds
      }
    ),
    false
  );
  assert.equal(
    shouldEmitAcpUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "tool-old-1", status: "completed" },
      {
        promptStarted: true,
        replaySuppressionEnabled: true,
        replayMessageIds
      }
    ),
    false
  );
  assert.equal(
    shouldEmitAcpUpdate(
      { sessionUpdate: "tool_call", toolCallId: "tool-new-1", title: "Read" },
      {
        promptStarted: true,
        replaySuppressionEnabled: true,
        replayMessageIds
      }
    ),
    true
  );
});

test("shouldEmitAcpUpdate suppresses replayed chunks by content signature", () => {
  const replayContentSignatures = new Set(["你好！我是 Qoder"]);
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "fresh-id-never-persisted",
        content: { type: "text", text: "  你好！我是 Qoder  " }
      },
      {
        promptStarted: true,
        replaySuppressionEnabled: true,
        replayContentSignatures
      }
    ),
    false
  );
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "抱歉，" }
      },
      {
        promptStarted: true,
        replaySuppressionEnabled: true,
        replayContentSignatures
      }
    ),
    true
  );
});

test("shouldDropReplayPhaseAgentChunk drops messageId chunks before any live chunk", () => {
  const state = { suppressReplayByPhase: true, turnHadLiveAgentChunk: false };
  assert.equal(
    shouldDropReplayPhaseAgentChunk(
      { sessionUpdate: "agent_thought_chunk", messageId: "replay-mid-1", content: { type: "text", text: "a" } },
      state
    ),
    true
  );
  assert.equal(
    shouldDropReplayPhaseAgentChunk(
      { sessionUpdate: "agent_message_chunk", messageId: "replay-mid-2", content: { type: "text", text: "b" } },
      state
    ),
    true
  );
});

test("shouldDropReplayPhaseAgentChunk keeps live (messageId-less) chunks and post-live chunks", () => {
  assert.equal(
    shouldDropReplayPhaseAgentChunk(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "live" } },
      { suppressReplayByPhase: true, turnHadLiveAgentChunk: false }
    ),
    false
  );
  assert.equal(
    shouldDropReplayPhaseAgentChunk(
      { sessionUpdate: "agent_message_chunk", messageId: "mid-late", content: { type: "text", text: "x" } },
      { suppressReplayByPhase: true, turnHadLiveAgentChunk: true }
    ),
    false
  );
  assert.equal(
    shouldDropReplayPhaseAgentChunk(
      { sessionUpdate: "tool_call", toolCallId: "call-1" },
      { suppressReplayByPhase: true, turnHadLiveAgentChunk: false }
    ),
    false
  );
  assert.equal(
    shouldDropReplayPhaseAgentChunk(
      { sessionUpdate: "agent_message_chunk", messageId: "mid-1", content: { type: "text", text: "x" } },
      { suppressReplayByPhase: false, turnHadLiveAgentChunk: false }
    ),
    false
  );
});

test("shouldSkipUserMessageChunk deduplicates echoed user messages", () => {
  assert.equal(
    shouldSkipUserMessageChunk(
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "hello" }
      },
      { userMessageId: "user-1", promptText: "hello" }
    ),
    true
  );
  assert.equal(
    shouldSkipUserMessageChunk(
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-2",
        content: { type: "text", text: "hello" }
      },
      { userMessageId: "user-1", promptText: "hello" }
    ),
    true
  );
  assert.equal(
    shouldSkipUserMessageChunk(
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-2",
        content: { type: "text", text: "different" }
      },
      { userMessageId: "user-1", promptText: "hello" }
    ),
    false
  );
});

test("acpSessionSetupToItems maps OpenCode session/new configOptions", () => {
  const items = acpSessionSetupToItems("sess-opencode", {
    sessionId: "sess-opencode",
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "anthropic/claude-sonnet-4",
        options: [
          {
            value: "anthropic/claude-sonnet-4",
            name: "Anthropic/Claude Sonnet 4"
          }
        ]
      },
      {
        id: "mode",
        name: "Session Mode",
        category: "mode",
        type: "select",
        currentValue: "build",
        options: [{ value: "build", name: "Build" }]
      }
    ]
  });

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    kind: "session",
    sessionId: "sess-opencode"
  });
  assert.equal(items[1].kind, "config-options");
  assert.equal(items[1].options.length, 2);
  assert.equal(items[1].options[0].currentLabel, "Anthropic/Claude Sonnet 4");
});

test("acpSessionSetupToItems maps Kimi legacy modes and models", () => {
  const items = acpSessionSetupToItems("sess-kimi", {
    session_id: "sess-kimi",
    modes: {
      current_mode_id: "default",
      available_modes: [
        { id: "default", name: "Default", description: "The default mode." }
      ]
    },
    models: {
      current_model_id: "kimi-k2",
      available_models: [
        { model_id: "kimi-k2", name: "kimi-k2" },
        { model_id: "kimi-k2,thinking", name: "kimi-k2 (thinking)" }
      ]
    }
  });

  assert.equal(items[1].kind, "config-options");
  assert.deepEqual(
    items[1].options.map((option) => option.id),
    ["mode", "model"]
  );
  assert.equal(items[1].options[1].currentValue, "kimi-k2");
});

test("acpSessionListToItems maps session/list titles", () => {
  const items = acpSessionListToItems("sess-1", {
    sessions: [
      {
        sessionId: "sess-1",
        cwd: "/tmp/project",
        title: "Implement auth flow",
        updatedAt: "2026-06-23T12:00:00.000Z"
      }
    ]
  });

  assert.deepEqual(items, [
    {
      kind: "session",
      sessionId: "sess-1",
      title: "Implement auth flow",
      updatedAt: "2026-06-23T12:00:00.000Z"
    }
  ]);
});
