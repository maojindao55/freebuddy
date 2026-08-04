import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

let resolveCodexBinaryHint;
let resolveBundledCodexFromAcpRoot;
let resolveNodeBinaryHint;
let codexAcpInstallRoots;

try {
  ({
    resolveCodexBinaryHint,
    resolveBundledCodexFromAcpRoot,
    resolveNodeBinaryHint,
    codexAcpInstallRoots
  } = await import("../dist-electron/cli/codexBinaryHint.js"));
} catch {
  // build:electron runs before tests in npm test
}

test("bundled Codex under codex-acp wins over missing global codex", async (t) => {
  if (!resolveCodexBinaryHint) {
    t.skip("dist-electron codexBinaryHint not built yet");
    return;
  }

  const acpRoot = path.join(
    "C:",
    "Users",
    "demo",
    "AppData",
    "Roaming",
    "npm",
    "node_modules",
    "@agentclientprotocol",
    "codex-acp"
  );
  const bundled = path.join(
    acpRoot,
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js"
  );
  const files = new Set([
    path.join(acpRoot, "package.json"),
    path.join(acpRoot, "dist", "index.js"),
    bundled
  ]);

  const resolved = resolveCodexBinaryHint({
    platform: "win32",
    env: {
      APPDATA: path.join("C:", "Users", "demo", "AppData", "Roaming"),
      PATH: ""
    },
    pathEnv: "",
    isFile: (candidate) => files.has(path.normalize(candidate))
  });

  assert.equal(path.normalize(resolved), path.normalize(bundled));
});

test("explicit FREEBUDDY_CODEX_BIN overrides bundled lookup", async (t) => {
  if (!resolveCodexBinaryHint) {
    t.skip("dist-electron codexBinaryHint not built yet");
    return;
  }

  const explicit = path.join("D:", "tools", "codex.exe");
  const resolved = resolveCodexBinaryHint({
    platform: "win32",
    env: {
      FREEBUDDY_CODEX_BIN: explicit,
      APPDATA: path.join("C:", "Users", "demo", "AppData", "Roaming")
    },
    isFile: (candidate) => path.normalize(candidate) === path.normalize(explicit)
  });
  assert.equal(path.normalize(resolved), path.normalize(explicit));
});

test("resolveBundledCodexFromAcpRoot checks nested and hoisted layouts", async (t) => {
  if (!resolveBundledCodexFromAcpRoot) {
    t.skip("dist-electron codexBinaryHint not built yet");
    return;
  }

  const acpRoot = "/usr/local/lib/node_modules/@agentclientprotocol/codex-acp";
  const hoisted = "/usr/local/lib/node_modules/@openai/codex/bin/codex.js";
  assert.equal(
    resolveBundledCodexFromAcpRoot(acpRoot, {
      isFile: (candidate) => path.normalize(candidate) === path.normalize(hoisted)
    }),
    path.normalize(hoisted)
  );
});

test("codexAcpInstallRoots includes Windows npm global package path", async (t) => {
  if (!codexAcpInstallRoots) {
    t.skip("dist-electron codexBinaryHint not built yet");
    return;
  }

  const appData = path.join("C:", "Users", "demo", "AppData", "Roaming");
  const roots = codexAcpInstallRoots({
    platform: "win32",
    env: { APPDATA: appData, PATH: "" },
    pathEnv: ""
  });
  assert.ok(
    roots.some((root) =>
      root.endsWith(
        path.join(
          "npm",
          "node_modules",
          "@agentclientprotocol",
          "codex-acp"
        )
      )
    )
  );
});

test("resolveNodeBinaryHint finds node.exe on PATH", async (t) => {
  if (!resolveNodeBinaryHint) {
    t.skip("dist-electron codexBinaryHint not built yet");
    return;
  }

  const nodeExe = path.join("C:", "Program Files", "nodejs", "node.exe");
  assert.equal(
    path.normalize(
      resolveNodeBinaryHint({
        platform: "win32",
        env: { PATH: path.dirname(nodeExe) },
        pathEnv: path.dirname(nodeExe),
        isFile: (candidate) => path.normalize(candidate) === path.normalize(nodeExe)
      })
    ),
    path.normalize(nodeExe)
  );
});
