import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanDshAcpManagedNodeModules,
  dshAcpCompositionReady,
  windowsExtendedPath
} from "../dist-electron/cli/adapters.js";

const checkSource = fs.readFileSync(
  new URL("../electron/cli/check.ts", import.meta.url),
  "utf8"
);

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Layout of a modern standalone harness: our bin, plus the three core packages it boots. */
function modernHarness(root) {
  const pkg = path.join(root, "node_modules", "deepseek-harness-acp");
  fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "deepseek-harness-acp",
      dependencies: { "@deepseek-ai/dsh-base": "0.1.6-alpha.2" }
    })
  );
  const bin = path.join(pkg, "lib", "bin.js");
  fs.writeFileSync(bin, "");
  const base = path.join(root, "node_modules", "@deepseek-ai", "dsh-base");
  for (const name of ["dsh-base", "dsh-acp", "dsh-app-boot"]) {
    const dir = path.join(root, "node_modules", "@deepseek-ai", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
  }
  return { bin, base };
}

function writeComposition(base, names) {
  fs.writeFileSync(
    path.join(base, "cordis.patch.yml"),
    names.map((n) => `- id: row\n  name: '${n}'\n`).join("\n")
  );
}

function installScopeDir(root, name, scope) {
  const dir = path.join(root, scope, ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  return dir;
}

test("dshAcpCompositionReady rejects a plugin row npm demoted out of the harness's reach", () => {
  const root = tempRoot("freebuddy-dsh-demote-");
  try {
    const { bin, base } = modernHarness(root);
    writeComposition(base, ["@deepseek-ai/dsh-tool-fs", "@deepseek-ai/dsh-bash-local"]);
    installScopeDir(root, "@deepseek-ai/dsh-tool-fs", "node_modules");
    const demoted = installScopeDir(
      base,
      "@deepseek-ai/dsh-bash-local",
      "node_modules"
    );

    // boot() anchors bare-specifier resolution at the harness, so a row that only
    // exists inside dsh-base aborts startup instead of loading.
    assert.equal(dshAcpCompositionReady(bin), false);

    fs.rmSync(demoted, { recursive: true, force: true });
    installScopeDir(root, "@deepseek-ai/dsh-bash-local", "node_modules");
    assert.equal(dshAcpCompositionReady(bin), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dshAcpCompositionReady keeps its core-package verdict when no composition ships", () => {
  const root = tempRoot("freebuddy-dsh-nopatch-");
  try {
    const { bin } = modernHarness(root);
    assert.equal(dshAcpCompositionReady(bin), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanDshAcpManagedNodeModules reports whether the managed tree really went away", () => {
  const root = tempRoot("freebuddy-dsh-wipe-");
  try {
    installScopeDir(root, "@deepseek-ai/dsh-base", "node_modules");
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}");

    assert.equal(cleanDshAcpManagedNodeModules(root), true);
    assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(root, "package-lock.json")), false);
    assert.equal(cleanDshAcpManagedNodeModules(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed installs abort rather than run npm over a surviving runtime tree", () => {
  assert.match(checkSource, /await prepareDshAcpManagedInstall\(\)/);
  assert.match(checkSource, /await removeDshAcpWindowsResidue\(\)/);
  assert.match(checkSource, /if \(!cleanDshAcpManagedNodeModules\(root\)\)/);
});

test("windowsExtendedPath only rewrites Windows paths", () => {
  if (process.platform === "win32") {
    assert.equal(windowsExtendedPath("C:\\tmp\\dsh"), "\\\\?\\C:\\tmp\\dsh");
    assert.equal(windowsExtendedPath("\\\\?\\C:\\tmp\\dsh"), "\\\\?\\C:\\tmp\\dsh");
  } else {
    assert.equal(windowsExtendedPath("/tmp/dsh"), "/tmp/dsh");
  }
});
