import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  SHELL_OPEN_FILE_EXTENSIONS,
  collectShellOpenPaths,
  classifyShellOpenPaths,
  windowsContextMenuVerb,
  windowsContextMenuLabel,
  windowsContextMenuCommand,
  windowsContextMenuKeys,
  buildWindowsContextMenuReg,
  macOpenWithServiceLabel,
  macOpenWithServiceFileName,
  macOpenWithServiceScript,
  buildMacOpenWithServiceInfoPlist,
  buildMacOpenWithServiceWorkflow,
  writeMacOpenWithService
} = await import("../dist-electron/cli/shellOpen.js");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("collectShellOpenPaths reads --open and dropped paths", () => {
  const exe = "C:\\Program Files\\FreeBuddy\\FreeBuddy.exe";
  const appPath = "C:\\src\\freebuddy";
  assert.deepEqual(
    collectShellOpenPaths(
      [exe, "--open", "D:\\work\\project"],
      { execPath: exe }
    ),
    ["D:\\work\\project"]
  );
  assert.deepEqual(
    collectShellOpenPaths(
      [exe, "--open=D:\\notes\\todo.md"],
      { execPath: exe }
    ),
    ["D:\\notes\\todo.md"]
  );
  assert.deepEqual(
    collectShellOpenPaths([exe, "D:\\dropped\\folder"], { execPath: exe }),
    ["D:\\dropped\\folder"]
  );
  assert.deepEqual(
    collectShellOpenPaths(
      ["electron.exe", appPath, "--open", "D:\\work\\app"],
      { execPath: "electron.exe", appPath }
    ),
    ["D:\\work\\app"]
  );
  assert.deepEqual(
    collectShellOpenPaths(
      ["electron.exe", appPath],
      { execPath: "electron.exe", appPath }
    ),
    []
  );
  assert.deepEqual(
    collectShellOpenPaths(
      [exe, "freebuddy://share?id=1", "--inspect=9229", "--open", "D:\\a"],
      { execPath: exe }
    ),
    ["D:\\a"]
  );
});

test("classifyShellOpenPaths prefers a folder cwd and keeps supported files", () => {
  const repo = path.resolve("fixture-repo");
  const readme = path.join(repo, "readme.md");
  const secret = path.join(repo, "secret.bin");
  const photo = path.join(path.resolve("fixture-only"), "photo.png");
  const kinds = new Map([
    [repo, "directory"],
    [readme, "file"],
    [secret, "file"],
    [photo, "file"]
  ]);
  const kindOf = (candidate) => kinds.get(candidate) ?? "missing";

  assert.deepEqual(classifyShellOpenPaths([repo, readme, secret], kindOf), {
    cwd: repo,
    files: [readme]
  });
  assert.deepEqual(classifyShellOpenPaths([photo], kindOf), {
    cwd: path.dirname(photo),
    files: [photo]
  });
  assert.deepEqual(classifyShellOpenPaths([path.join(repo, "missing.md")], kindOf), {
    files: []
  });
});

test("Windows context menu registry uses Open with FreeBuddy and --open", () => {
  const spec = {
    exePath: "C:\\Program Files\\FreeBuddy\\FreeBuddy.exe",
    packaged: true,
    locale: "zh-CN",
    productName: "FreeBuddy",
    isDevInstance: false
  };
  assert.equal(windowsContextMenuVerb(false), "FreeBuddy");
  assert.equal(windowsContextMenuVerb(true), "FreeBuddyDev");
  assert.equal(windowsContextMenuLabel("zh-CN", "FreeBuddy"), "使用 FreeBuddy 打开");
  assert.equal(windowsContextMenuLabel("en-US", "FreeBuddy"), "Open with FreeBuddy");
  assert.equal(
    windowsContextMenuCommand(spec, "%1"),
    '"C:\\Program Files\\FreeBuddy\\FreeBuddy.exe" --open "%1"'
  );
  assert.equal(
    windowsContextMenuCommand(spec, "%V"),
    '"C:\\Program Files\\FreeBuddy\\FreeBuddy.exe" --open "%V"'
  );
  assert.deepEqual(windowsContextMenuKeys("FreeBuddy"), [
    "HKCU\\Software\\Classes\\Directory\\shell\\FreeBuddy",
    "HKCU\\Software\\Classes\\Directory\\Background\\shell\\FreeBuddy",
    "HKCU\\Software\\Classes\\Drive\\shell\\FreeBuddy",
    "HKCU\\Software\\Classes\\*\\shell\\FreeBuddy"
  ]);

  const reg = buildWindowsContextMenuReg(spec);
  assert.match(reg, /Windows Registry Editor Version 5\.00/);
  assert.match(reg, /使用 FreeBuddy 打开/);
  assert.match(reg, /Directory\\shell\\FreeBuddy/);
  assert.match(reg, /Directory\\Background\\shell\\FreeBuddy/);
  assert.match(reg, /Classes\\\*\\shell\\FreeBuddy/);
  assert.match(reg, /--open \\"%1\\"/);
  assert.match(reg, /--open \\"%V\\"/);
  assert.equal(reg.includes("C:\\\\Program Files\\\\FreeBuddy\\\\FreeBuddy.exe"), true);
});

test("shell-open file extensions stay aligned with attachment allowlist", () => {
  const attachments = fs.readFileSync(
    path.join(rootDir, "electron", "cli", "attachments.ts"),
    "utf8"
  );
  const match = attachments.match(
    /const ATTACHMENT_EXTENSIONS = new Set\(\[([\s\S]*?)\]\)/
  );
  assert.ok(match, "ATTACHMENT_EXTENSIONS should exist");
  const listed = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assert.deepEqual([...SHELL_OPEN_FILE_EXTENSIONS], listed);
});

test("macOS Finder service opens items through the app bundle id", () => {
  const spec = { bundleId: "dev.freebuddy.app", productName: "FreeBuddy" };
  assert.equal(macOpenWithServiceLabel("zh-CN", "FreeBuddy"), "使用 FreeBuddy 打开");
  assert.equal(macOpenWithServiceLabel("en-US", "FreeBuddy"), "Open with FreeBuddy");
  assert.equal(macOpenWithServiceFileName("FreeBuddy"), "Open with FreeBuddy.workflow");
  assert.equal(macOpenWithServiceScript(spec.bundleId), `open -b 'dev.freebuddy.app' "$@"`);

  const plist = buildMacOpenWithServiceInfoPlist(spec);
  assert.match(plist, /Open with FreeBuddy/);
  assert.match(plist, /public\.folder/);
  assert.match(plist, /public\.item/);
  assert.match(plist, /com\.apple\.finder/);
  assert.match(plist, /runWorkflowAsService/);

  const workflow = buildMacOpenWithServiceWorkflow(spec);
  assert.match(workflow, /open -b 'dev\.freebuddy\.app'/);
  assert.match(workflow, /com\.apple\.Automator\.quickAction/);
  assert.match(workflow, /inputMethod<\/key>\s*<integer>1<\/integer>/);

  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mac-open-"));
  try {
    const written = writeMacOpenWithService(appRoot, spec);
    assert.equal(path.basename(written), "Open with FreeBuddy.workflow");
    assert.ok(fs.existsSync(path.join(written, "Contents", "Info.plist")));
    assert.ok(fs.existsSync(path.join(written, "Contents", "document.wflow")));
    const zh = fs.readFileSync(
      path.join(written, "Contents", "Resources", "zh_CN.lproj", "InfoPlist.strings"),
      "utf8"
    );
    assert.match(zh, /使用 FreeBuddy 打开/);
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

