import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Use electron-builder's existing toolchain so Windows CI actually runs these
// tests even when makensis is not on PATH. Packaging reuses the same cache.
const nsis = process.platform === "win32"
  ? process.env.MAKENSIS_PATH
    ? { path: process.env.MAKENSIS_PATH }
    : await import("app-builder-lib/out/toolsets/windows.js")
      .then(({ getMakeNsisPath }) => getMakeNsisPath())
  : null;

// Execute the real NSIS macros against temporary installations. No FreeBuddy
// registry entries, shortcuts, or user data are accessed by this harness.
test("Windows installer directory locking", {
  skip: process.platform !== "win32" ? "Windows directory locking only" : false,
  timeout: 120_000
}, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fb-nsis-lock-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const executable = path.join(workspace, "installer-test.exe");
  const legacyHelper = path.join(workspace, "legacy-uninstaller.cjs");
  fs.writeFileSync(legacyHelper, `
    const fs = require("node:fs");
    const path = require("node:path");
    process.chdir(require("node:os").tmpdir());
    fs.unlinkSync(path.join(process.argv[2], "FreeBuddy.exe"));
    fs.rmdirSync(process.argv[2]);
  `);

  const source = path.join(workspace, "installer-test.nsi");
  fs.writeFileSync(source, `
    Unicode true
    RequestExecutionLevel user
    SilentInstall silent
    Name "FreeBuddy installer regression test"
    OutFile "${executable}"
    !include "LogicLib.nsh"
    !include "FileFunc.nsh"
    !addincludedir "${path.join(rootDir, "node_modules/app-builder-lib/templates/nsis/include")}"
    Var testMode
    Var testUpdated
    Var testResult
    Var testFileLock
    !define isUpdated '$testUpdated == 1'
    !include "${path.join(rootDir, "desktop/windows/installer.nsh")}"

    Function .onInit
      InitPluginsDir
      \${GetParameters} $R0
      \${GetOptions} $R0 "/TARGET=" $INSTDIR
      \${GetOptions} $R0 "/MODE=" $testMode
      StrCpy $testUpdated 0
      \${if} $testMode == "update"
      \${orIf} $testMode == "locked-file-update"
        StrCpy $testUpdated 1
      \${endif}
      ; Match electron-builder's .onInit, which initially owns $INSTDIR.
      SetOutPath $INSTDIR
      \${if} $testMode == "init"
        !ifmacrodef customInit
          !insertmacro customInit
        !endif
      \${endif}
    FunctionEnd

    Section
      \${if} $testMode == "init"
        ; The existing uninstaller requires removal of the empty root too.
        nsExec::Exec '\"${process.execPath}\" \"${legacyHelper}\" \"$INSTDIR\"'
        Pop $testResult
      \${else}
        \${if} $testMode == "locked-file-update"
          System::Call 'kernel32::CreateFileW(w "$INSTDIR\\FreeBuddy.exe", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p.r0'
          StrCpy $testFileLock $0
          \${if} $testFileLock == -1
            SetErrorLevel 24
            Quit
          \${endif}
        \${endif}
        !insertmacro FreeBuddyRemoveInstallDir "$INSTDIR"
        StrCpy $testResult 0
        \${if} \${Errors}
          StrCpy $testResult 23
        \${endif}
        \${if} $testMode == "locked-file-update"
          System::Call 'kernel32::CloseHandle(p $testFileLock)'
        \${endif}
      \${endif}
      SetErrorLevel $testResult
    SectionEnd
  `);
  execFileSync(nsis.path, ["/V2", source], {
    env: { ...process.env, ...nsis.env },
    windowsHide: true,
    timeout: 30_000
  });

  function installation(name, { longPath = false } = {}) {
    const target = path.join(workspace, name);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "FreeBuddy.exe"), "old application");
    if (longPath) {
      const nested = path.join(target, ...Array(18).fill("legacy-node-modules"));
      assert.ok(nested.length > 260);
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "index.js"), "legacy runtime");
    }
    return target;
  }

  function run(target, mode) {
    return spawnSync(executable, [`/TARGET=${target}`, `/MODE=${mode}`], {
      windowsHide: true,
      timeout: 30_000
    });
  }

  async function lockDirectory(target, callback) {
    const holder = spawn(process.execPath, ["-e", `
      setInterval(() => {}, 1000);
      process.stdout.write("ready");
    `], { cwd: target, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const exited = once(holder, "exit");
    try {
      await once(holder.stdout, "data");
      assert.throws(() => fs.rmdirSync(target), { code: "EBUSY" });
      await callback();
    } finally {
      holder.kill();
      await exited;
    }
  }

  await t.test("installer releases its directory before the old uninstaller runs", () => {
    const target = installation("old-version");
    assert.equal(run(target, "init").status, 0);
    assert.equal(fs.existsSync(target), false);
  });

  await t.test("upgrade clears long paths while another process holds the directory", async () => {
    const target = installation("upgrade", { longPath: true });
    await lockDirectory(target, () => {
      assert.equal(run(target, "update").status, 0);
      assert.deepEqual(fs.readdirSync(target), []);
    });
  });

  await t.test("ordinary uninstall removes the root and long paths", () => {
    const target = installation("uninstall", { longPath: true });
    assert.equal(run(target, "uninstall").status, 0);
    assert.equal(fs.existsSync(target), false);
  });

  await t.test("ordinary uninstall still reports a directory lock", async () => {
    const target = installation("locked-uninstall");
    await lockDirectory(target, () => {
      assert.equal(run(target, "uninstall").status, 23);
    });
  });

  await t.test("upgrade still reports files that cannot be deleted", () => {
    const target = installation("locked-file");
    const result = run(target, "locked-file-update");
    assert.deepEqual({
      status: result.status,
      contents: fs.readFileSync(path.join(target, "FreeBuddy.exe"), "utf8")
    }, { status: 23, contents: "old application" });
  });
});
