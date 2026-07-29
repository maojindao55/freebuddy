import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildCodexAppServerWrapper
} from "../dist-electron/cli/codexByokWrapper.js";

test("Codex BYOK uses a Windows command wrapper and bundled Codex fallback", () => {
  const wrapper = buildCodexAppServerWrapper({
    platform: "win32",
    modelCatalogPath:
      "C:\\Users\\Kai\\AppData\\Roaming\\FreeBuddy\\catalog with spaces.json",
    codexAcpPath: "C:\\Users\\Kai\\AppData\\Roaming\\npm\\codex-acp.cmd"
  });

  assert.equal(wrapper.extension, ".cmd");
  assert.doesNotMatch(wrapper.contents, /#!\/bin\/sh|command -v|\/opt\/homebrew/);
  assert.match(wrapper.contents, /FREEBUDDY_CODEX_BIN/);
  assert.match(
    wrapper.contents,
    /@agentclientprotocol\\codex-acp\\node_modules\\\.bin\\codex\.cmd/
  );
  assert.match(
    wrapper.contents,
    /model_catalog_json=C:\\Users\\Kai\\AppData\\Roaming\\FreeBuddy\\catalog with spaces\.json/
  );
  assert.match(wrapper.contents, /%\\*/);
  assert.doesNotMatch(wrapper.contents, /exit \/b %ERRORLEVEL%/i);
  assert.match(wrapper.contents, /call "[^"]+" %\* -c "[^"]+"\r\n  exit \/b\r\n/);
});

test(
  "Codex BYOK Windows wrapper preserves the Codex process exit status",
  { skip: process.platform !== "win32" },
  () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-codex-wrapper-"));
    try {
      const stub = path.join(temp, "codex-stub.cmd");
      fs.writeFileSync(stub, "@echo off\r\nexit /b 7\r\n");
      const wrapper = buildCodexAppServerWrapper({
        platform: "win32",
        modelCatalogPath: path.join(temp, "catalog with spaces.json")
      });
      const wrapperPath = path.join(temp, `freebuddy${wrapper.extension}`);
      fs.writeFileSync(wrapperPath, wrapper.contents);

      const result = spawnSync(
        "cmd.exe",
        ["/d", "/s", "/c", `""${wrapperPath}" smoke"`],
        {
          env: { ...process.env, FREEBUDDY_CODEX_BIN: stub },
          encoding: "utf8"
        }
      );
      assert.equal(result.status, 7, result.stderr);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
);

test("Codex BYOK keeps a POSIX wrapper on macOS and Linux", () => {
  const wrapper = buildCodexAppServerWrapper({
    platform: "darwin",
    modelCatalogPath: "/Users/kai/Library/Application Support/catalog.json",
    codexAcpPath: "/usr/local/bin/codex-acp"
  });

  assert.equal(wrapper.extension, ".sh");
  assert.match(wrapper.contents, /^#!\/bin\/sh/);
  assert.match(wrapper.contents, /\$FREEBUDDY_CODEX_BIN/);
  assert.match(wrapper.contents, /node_modules\/\.bin\/codex/);
  assert.match(wrapper.contents, /"\$@"/);
});
