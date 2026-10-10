import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getAdapterDefinition, getCliCheckProbe, applyDshAcpNpmInstallEnv, dshAcpWindowsResiduePath, dshAcpInstallCommand, parseDshAcpCompositionPackages, bundledDshAcpConfigPath, dshAcpCompositionReady, dshAcpManagedDemoBin, resolveDshAcpDemoDirFromBinary, quoteForShell, resolveDshAcpDemoBinJs, cleanupLegacyDshAcpManagedFiles } from "../dist-electron/cli/adapters.js";

test("Codex ACP checks the new Agent Client Protocol package version", () => {
  assert.deepEqual(getCliCheckProbe("codex-acp"), {
    args: ["--version"],
    versionOptional: false
  });
});

test("Codex ACP install command force-overwrites the retired Zed package binary", () => {
  assert.equal(
    getAdapterDefinition("codex-acp")?.installHint,
    "npm install -g --force @agentclientprotocol/codex-acp"
  );
});

test("Claude ACP checks the delegated CLI version instead of starting ACP", () => {
  assert.deepEqual(getCliCheckProbe("claude-agent-acp"), {
    args: ["--cli", "--version"],
    versionOptional: false
  });
});

test("Claude ACP install includes its optional platform runtime", () => {
  assert.equal(
    getAdapterDefinition("claude-agent-acp")?.installHint,
    "npm install -g --include=optional @agentclientprotocol/claude-agent-acp"
  );
});

test("Grok ACP checks the local Grok CLI version command", () => {
  assert.deepEqual(getCliCheckProbe("grok-acp"), {
    args: ["version"],
    versionOptional: false
  });
});

test("legacy adapters still require a version response", () => {
  assert.deepEqual(getCliCheckProbe("codex"), {
    args: ["--version"],
    versionOptional: false
  });
});

test("agy-acp checks agy-acp binary probe", () => {
  assert.deepEqual(getCliCheckProbe("agy-acp"), {
    args: ["--version"],
    versionOptional: true
  });
});

test("zcode-acp checks zcode-acp-server binary probe", () => {
  assert.deepEqual(getCliCheckProbe("zcode-acp"), {
    args: ["--version"],
    versionOptional: false
  });
});

test("ZCode ACP install hint matches official package", () => {
  assert.equal(
    getAdapterDefinition("zcode-acp")?.installHint,
    "npm install -g zcode-acp-server"
  );
});

test("cline-acp checks cline binary probe", () => {
  assert.deepEqual(getCliCheckProbe("cline-acp"), {
    args: ["--version"],
    versionOptional: false
  });
});

test("Cline ACP install hint matches official package", () => {
  assert.equal(
    getAdapterDefinition("cline-acp")?.installHint,
    "npm install -g cline"
  );
});

test("devin-acp checks the Devin CLI and uses the official installer", () => {
  assert.deepEqual(getCliCheckProbe("devin-acp"), {
    args: ["--version"],
    versionOptional: false
  });
  assert.equal(getAdapterDefinition("devin-acp")?.defaultBinary, "devin");
  assert.equal(
    getAdapterDefinition("devin-acp")?.installHint,
    process.platform === "win32"
      ? "irm https://static.devin.ai/cli/setup.ps1 | iex"
      : "curl -fsSL https://cli.devin.ai/install.sh | bash"
  );
});

test("Windows fallback search includes the native Claude installer directory", () => {
  const source = fs.readFileSync(
    new URL("../electron/cli/check.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /path\.join\(userProfile, "\.local", "bin"\)/);
  assert.match(source, /adapter === "codex-acp"[\s\S]*\? "codex"/);
  assert.match(source, /adapter === "claude-agent-acp"[\s\S]*\? "claude"/);
});

test("dsh-acp uses standalone deepseek-harness-acp package", () => {
  assert.deepEqual(getCliCheckProbe("dsh-acp"), {
    args: [],
    versionOptional: true,
    skipSpawn: true
  });
  const hint = getAdapterDefinition("dsh-acp")?.installHint;
  assert.equal(hint, dshAcpInstallCommand());
  assert.equal(hint, "npm install -g deepseek-harness-acp");
  assert.equal(getAdapterDefinition("dsh-acp")?.defaultBinary, "deepseek-harness-acp");
});

test("bundled DeepSeek ACP config disables zstd persistence on Windows-safe defaults", () => {
  const yaml = fs.readFileSync(bundledDshAcpConfigPath(), "utf8");
  assert.match(yaml, /persistenceCompression:\s*none/);
  assert.doesNotMatch(
    yaml,
    /persistenceCompression:\s*!!js "process\.env\.DSH_SNAPSHOT === undefined \? 'zstd'/
  );
  assert.doesNotMatch(
    yaml,
    /dsh-sandbox-local'[\s\S]*disabled:\s*!!js process\.platform === 'win32'/
  );
});

test("dsh-acp install command matches standalone deepseek-harness-acp package", () => {
  assert.equal(
    dshAcpInstallCommand(),
    "npm install -g deepseek-harness-acp"
  );
  const renderer = fs.readFileSync(
    new URL("../src/config/cliAdapters.ts", import.meta.url),
    "utf8"
  );
  assert.equal(renderer.includes("npm install -g deepseek-harness-acp"), true);
  const prefixedWin = dshAcpInstallCommand({ prefix: "C:\\tmp\\dsh" });
  assert.match(prefixedWin, /--prefix /);
  assert.equal(prefixedWin.includes(" -g "), false);
  assert.equal(prefixedWin.includes("@deepseek-ai/dsh-bash-local"), false);
  const prefixedMac = dshAcpInstallCommand({ prefix: "/tmp/freebuddy-dsh" });
  assert.match(prefixedMac, /--prefix /);
  assert.equal(prefixedMac.includes(" -g "), false);
  assert.equal(prefixedMac.includes("@deepseek-ai/dsh-bash-local"), false);
});

test("managed DSH installs pin a checked version and refresh cached registry metadata", () => {
  const command = dshAcpInstallCommand({ prefix: "/tmp/free buddy", version: "0.1.31" });
  assert.match(command, /deepseek-harness-acp@0\.1\.31(?:\s|$)/);
  assert.match(command, /--offline=false/);
  assert.match(command, /--prefer-online/);
  assert.equal(command.includes(" -g "), false);
  assert.equal(command.includes("@deepseek-ai/dsh-bash-local"), false);
  assert.match(dshAcpInstallCommand({ prefix: "/tmp/dsh" }), /deepseek-harness-acp@latest/);
  assert.match(dshAcpInstallCommand({ prefix: "/tmp/dsh", version: "0.2.0-rc.1" }), /deepseek-harness-acp@0\.2\.0-rc\.1/);
  assert.throws(() => dshAcpInstallCommand({ version: "0.1.31; echo injected" }), /Invalid.*target version/);
});

test("dsh-acp npm installs skip koffi rebuild scripts", () => {
  const env = applyDshAcpNpmInstallEnv("dsh-acp", { PATH: "/usr/bin" });
  assert.equal(env.npm_config_ignore_scripts, "true");
  assert.equal(env.npm_config_include, "optional");
  assert.equal(env.npm_config_optional, undefined);
  assert.equal(
    applyDshAcpNpmInstallEnv("codex-acp", { PATH: "/usr/bin" }).npm_config_ignore_scripts,
    undefined
  );
  if (process.platform === "win32") {
    assert.equal(
      dshAcpWindowsResiduePath({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }),
      "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai"
    );
  } else {
    assert.equal(
      dshAcpWindowsResiduePath({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }),
      undefined
    );
  }
});

test("dsh-acp composition ready requires llm-deepseek beside the demo", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acp-ready-"));
  const demo = path.join(root, "node_modules", "@deepseek-ai", "dsh-acp-demo");
  fs.mkdirSync(path.join(demo, "lib"), { recursive: true });
  fs.writeFileSync(path.join(demo, "package.json"), "{}");
  const bin = path.join(demo, "lib", "bin.js");
  fs.writeFileSync(bin, "");
  assert.equal(dshAcpCompositionReady(bin), false);

  const probe = path.join(root, "node_modules", "@deepseek-ai", "dsh-llm-deepseek");
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, "package.json"), "{}");
  assert.equal(dshAcpCompositionReady(bin), true);
  assert.equal(resolveDshAcpDemoDirFromBinary(bin), fs.realpathSync(demo));
  assert.equal(
    dshAcpManagedDemoBin("/data"),
    path.join(
      "/data",
      "runtimes",
      "dsh-acp",
      "node_modules",
      "@deepseek-ai",
      "dsh-acp-demo",
      "lib",
      "bin.js"
    )
  );
});

test("quoteForShell leaves clean paths unquoted and quotes paths with spaces", () => {
  if (process.platform === "win32") {
    assert.equal(
      quoteForShell("C:\\Users\\Morefine\\AppData\\Roaming\\FreeBuddy\\runtimes\\dsh-acp"),
      "C:\\Users\\Morefine\\AppData\\Roaming\\FreeBuddy\\runtimes\\dsh-acp"
    );
    assert.equal(
      quoteForShell("C:\\Users\\John Doe\\AppData\\Roaming"),
      '"C:\\Users\\John Doe\\AppData\\Roaming"'
    );
  } else {
    assert.equal(quoteForShell("/tmp/freebuddy"), "/tmp/freebuddy");
    assert.equal(quoteForShell("/tmp/free buddy"), "'/tmp/free buddy'");
  }
});

test("resolveDshAcpDemoBinJs defaults to standalone binary instead of picking up residue demo unless requested", () => {
  const standalone = resolveDshAcpDemoBinJs({
    binary: "deepseek-harness-acp"
  });
  assert.equal(standalone, undefined);
});

test("cleanupLegacyDshAcpManagedFiles keeps only a single-package harness manifest", () => {
  const probe = (body) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-manifest-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), body);
      fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
      cleanupLegacyDshAcpManagedFiles(root);
      return {
        manifest: fs.existsSync(path.join(root, "package.json")),
        lockfile: fs.existsSync(path.join(root, "package-lock.json"))
      };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const deps = (dependencies) => probe(JSON.stringify({ dependencies }));
  const kept = { manifest: true, lockfile: true };
  const dropped = { manifest: false, lockfile: false };

  // The only shape npm resolves into a hoisted, bootable tree.
  assert.deepEqual(deps({ "deepseek-harness-acp": "^0.1.16" }), kept);
  // A sibling floating ahead of the harness core line forces npm to demote
  // dsh-base's plugin subtree, where the boot module cannot reach it.
  assert.deepEqual(
    deps({
      "@deepseek-ai/dsh-bash-local": "^0.2.0-rc.2",
      "deepseek-harness-acp": "^0.1.31"
    }),
    dropped
  );
  // The pre-standalone granular composition.
  assert.deepEqual(
    deps({
      "@deepseek-ai/dsh-acp-demo": "^0.1.0-rc.6",
      "@deepseek-ai/dsh-llm-deepseek": "^0.1.0-rc.6"
    }),
    dropped
  );
  // A local checkout link stops resolving as soon as the checkout moves.
  assert.deepEqual(deps({ "deepseek-harness-acp": "file:../deepseek-harness-acp" }), dropped);
  assert.deepEqual(deps({ "@deepseek-ai/dsh-base": "^0.1.6" }), dropped);
  assert.deepEqual(probe("{ not json"), dropped);
});

test("dshAcpCompositionReady validates required plugins in cordis.yml", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ready-cfg-"));
  const standalone = path.join(root, "node_modules", "deepseek-harness-acp");
  fs.mkdirSync(path.join(standalone, "lib"), { recursive: true });
  fs.writeFileSync(path.join(standalone, "package.json"), "{}");
  const bin = path.join(standalone, "lib", "bin.js");
  fs.writeFileSync(bin, "");

  const probe = path.join(root, "node_modules", "@deepseek-ai", "dsh-llm-deepseek");
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, "package.json"), "{}");

  const cordisYaml = path.join(root, "cordis.yml");
  fs.writeFileSync(
    cordisYaml,
    "- name: '@deepseek-ai/dsh-llm-deepseek'\n- name: '@deepseek-ai/dsh-attachment-local'\n"
  );

  // Missing attachment-local
  assert.equal(dshAcpCompositionReady(bin, cordisYaml), false);

  // Add attachment-local
  const attachment = path.join(root, "node_modules", "@deepseek-ai", "dsh-attachment-local");
  fs.mkdirSync(attachment, { recursive: true });
  fs.writeFileSync(path.join(attachment, "package.json"), "{}");

  assert.equal(dshAcpCompositionReady(bin, cordisYaml), true);
});
