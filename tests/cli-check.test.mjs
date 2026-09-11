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
  if (process.platform === "win32") {
    assert.equal(hint, "npm install -g deepseek-harness-acp @deepseek-ai/dsh-bash-local@next");
  } else {
    assert.equal(hint, "npm install -g deepseek-harness-acp");
  }
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
    dshAcpInstallCommand({ platform: "darwin" }),
    "npm install -g deepseek-harness-acp"
  );
  assert.equal(
    dshAcpInstallCommand({ platform: "linux" }),
    "npm install -g deepseek-harness-acp"
  );
  assert.equal(
    dshAcpInstallCommand({ platform: "win32" }),
    "npm install -g deepseek-harness-acp @deepseek-ai/dsh-bash-local@next"
  );
  const renderer = fs.readFileSync(
    new URL("../src/config/cliAdapters.ts", import.meta.url),
    "utf8"
  );
  assert.equal(renderer.includes("npm install -g deepseek-harness-acp"), true);
  const prefixedWin = dshAcpInstallCommand({ prefix: "C:\\tmp\\dsh", platform: "win32" });
  assert.match(prefixedWin, /--prefix /);
  assert.match(prefixedWin, /@deepseek-ai\/dsh-bash-local@next/);
  assert.equal(prefixedWin.includes(" -g "), false);
  const prefixedMac = dshAcpInstallCommand({ prefix: "/tmp/freebuddy-dsh", platform: "darwin" });
  assert.match(prefixedMac, /--prefix /);
  assert.equal(prefixedMac.includes(" -g "), false);
  assert.equal(prefixedMac.includes("@deepseek-ai/dsh-bash-local"), false);
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

test("cleanupLegacyDshAcpManagedFiles removes legacy granular package.json and lockfile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-legacy-cleanup-"));
  const legacyPkg = {
    dependencies: {
      "@deepseek-ai/dsh-acp-demo": "^0.1.0-rc.6",
      "@deepseek-ai/dsh-llm-deepseek": "^0.1.0-rc.6"
    }
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(legacyPkg));
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");

  cleanupLegacyDshAcpManagedFiles(root);
  assert.equal(fs.existsSync(path.join(root, "package.json")), false);
  assert.equal(fs.existsSync(path.join(root, "package-lock.json")), false);

  const cleanPkg = {
    dependencies: {
      "deepseek-harness-acp": "^0.1.16"
    }
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(cleanPkg));
  cleanupLegacyDshAcpManagedFiles(root);
  assert.equal(fs.existsSync(path.join(root, "package.json")), true);
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


