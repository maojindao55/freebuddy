import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  WINDOWS_EXPLORER_COMMAND,
  windowsExplorerCommandPackageName,
  toMsixVersion,
  clsidWithoutBraces,
  buildWindowsExplorerCommandAppxManifest,
  windowsExplorerCommandPaths,
  readWindowsExplorerCommandPayload,
  shouldRegisterWindowsExplorerCommand,
  writeWindowsExplorerCommandStamp,
  readWindowsExplorerCommandStamp,
  buildWindowsExplorerCommandRegisterScript,
  buildWindowsExplorerCommandTrustScript,
  buildWindowsExplorerCommandUnregisterScript,
  applyWindowsExplorerCommandPackage
} = await import("../dist-electron/cli/windowsExplorerCommand.js");
const { buildWindowsExplorerCommandCertScript } = await import(
  "../scripts/pack-windows-explorer-command.mjs"
);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), "utf8");
const identity = JSON.parse(read("desktop/windows/explorer-command/identity.json"));

test("explorer-command identity is shared across cpp, def, and TS constants", () => {
  assert.equal(WINDOWS_EXPLORER_COMMAND.clsid, identity.clsid);
  assert.equal(WINDOWS_EXPLORER_COMMAND.packageName, identity.packageName);
  assert.equal(WINDOWS_EXPLORER_COMMAND.devPackageName, identity.devPackageName);
  assert.equal(WINDOWS_EXPLORER_COMMAND.publisher, identity.publisher);
  assert.equal(WINDOWS_EXPLORER_COMMAND.dllName, identity.dllName);
  assert.equal(windowsExplorerCommandPackageName(false), identity.packageName);
  assert.equal(windowsExplorerCommandPackageName(true), identity.devPackageName);

  const cpp = read("desktop/windows/explorer-command/ExplorerCommand.cpp");
  assert.match(cpp, /5C8A1E2D-9B74-4A16-8F3C-6E2D91B0487A/i);
  assert.match(cpp, /0x5c8a1e2d/i);
  assert.match(cpp, /DllGetClassObject/);
  assert.match(cpp, /IExplorerCommand/);
  assert.match(cpp, /--open/);
  assert.match(cpp, /使用 FreeBuddy 打开/);
  assert.match(cpp, /FreeBuddy\.exe/);

  const def = read("desktop/windows/explorer-command/ExplorerCommand.def");
  assert.match(def, /DllGetClassObject/);
  assert.match(def, /DllCanUnloadNow/);
});

test("MSIX version padding and AppxManifest wire COM + Explorer menus", () => {
  assert.equal(toMsixVersion("0.9.26"), "0.9.26.0");
  assert.equal(toMsixVersion("1.2.3-beta"), "1.2.3.0");
  assert.equal(clsidWithoutBraces(identity.clsid), "5C8A1E2D-9B74-4A16-8F3C-6E2D91B0487A");

  const xml = buildWindowsExplorerCommandAppxManifest({
    packageName: identity.packageName,
    version: "0.9.26",
    executable: "FreeBuddy.exe",
    architecture: "x64"
  });
  assert.match(xml, /uap10:AllowExternalContent>true/);
  assert.match(xml, /windows\.fileExplorerContextMenus/);
  assert.match(xml, /desktop5:ItemType Type="Directory"/);
  assert.match(xml, /desktop5:ItemType Type="Directory\\Background"/);
  assert.match(xml, /desktop5:ItemType Type="\*"/);
  assert.match(xml, /desktop5:Verb /);
  assert.doesNotMatch(xml, /desktop4:ItemType/);
  assert.match(xml, /windows\.comServer/);
  assert.match(xml, /FreeBuddyExplorerCommand\.dll/);
  assert.match(xml, /5C8A1E2D-9B74-4A16-8F3C-6E2D91B0487A/i);
  assert.match(xml, /CN=FreeBuddy/);
  assert.match(xml, /dev\.freebuddy\.app\.shell/);
  assert.match(xml, /Executable="FreeBuddy\.exe"/);
  assert.match(xml, /runFullTrust/);
});

test("sparse package registration script trusts the bundled cert then Add-AppxPackage", () => {
  const script = buildWindowsExplorerCommandRegisterScript({
    installDir: "C:\\Program Files\\FreeBuddy",
    msixPath: "C:\\Program Files\\FreeBuddy\\FreeBuddyExplorerCommand.msix",
    cerPath: "C:\\Program Files\\FreeBuddy\\FreeBuddyExplorerCommand.cer",
    packageName: identity.packageName,
    thumbprint: "abc123"
  });
  assert.match(script, /Import-Certificate/);
  assert.match(script, /TrustedPeople/);
  assert.match(script, /LocalMachine/);
  assert.match(script, /Verb RunAs/);
  assert.match(script, /trust-explorer-command\.ps1/);
  assert.match(script, /800B0109/);
  assert.match(script, /Add-AppxPackage/);
  assert.match(script, /ExternalLocation/);
  assert.match(script, /ForceUpdateFromAnyVersion/);
  assert.match(script, /FreeBuddyExplorerCommand\.msix/);
  assert.match(script, /abc123/);
  assert.match(script, /ToUpperInvariant/);

  const uninstall = buildWindowsExplorerCommandUnregisterScript();
  assert.match(uninstall, /dev\.freebuddy\.app\.shell/);
  assert.match(uninstall, /dev\.freebuddy\.app\.dev\.shell/);
  assert.match(uninstall, /Remove-AppxPackage/);
  assert.match(uninstall, /CN=FreeBuddy/);
  assert.match(uninstall, /LocalMachine/);

  const trust = buildWindowsExplorerCommandTrustScript();
  assert.match(trust, /LocalMachine\\TrustedPeople/);
  assert.match(trust, /CerPath/);
});

test("afterPack and NSIS uninstall ship the Win11 Explorer command", () => {
  const dispatcher = read("scripts/after-pack.mjs");
  assert.match(dispatcher, /after-pack-macos\.mjs/);
  assert.match(dispatcher, /packWindowsExplorerCommand/);

  const pack = read("scripts/pack-windows-explorer-command.mjs");
  assert.match(pack, /compileWindowsExplorerCommandDll/);
  assert.match(pack, /MakeAppx/);
  assert.match(pack, /signtool/i);
  assert.match(pack, /CertificateRequest/);
  assert.match(pack, /FB_EXPLORER_CERT_PASSWORD/);
  assert.doesNotMatch(pack, /ConvertTo-SecureString/);
  assert.doesNotMatch(pack, /New-SelfSignedCertificate/);
  assert.match(pack, /uninstall-explorer-command\.ps1/);
  assert.match(pack, /trust-explorer-command\.ps1/);
  assert.match(pack, /explorer-command\.pfx/);

  const buildDll = read("scripts/build-windows-explorer-command.mjs");
  assert.match(buildDll, /\/MT/);
  assert.match(buildDll, /build\.bat/);
  assert.match(buildDll, /static-libgcc/);
  assert.match(buildDll, /fno-exceptions/);
  assert.match(buildDll, /--kill-at/);

  const nsh = read("desktop/windows/installer.nsh");
  assert.match(nsh, /uninstall-explorer-command\.ps1/);
  assert.match(nsh, /nsExec::ExecToLog/);

  const certScript = buildWindowsExplorerCommandCertScript({
    pfxPath: "C:\\tmp\\explorer-command.pfx",
    cerPath: "C:\\tmp\\FreeBuddyExplorerCommand.cer",
    subject: identity.publisher
  });
  assert.match(certScript, /CertificateRequest/);
  assert.match(certScript, /FB_EXPLORER_CERT_PASSWORD/);
  assert.match(certScript, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.doesNotMatch(certScript, /ConvertTo-SecureString/);
});

test("code-signing cert export uses .NET and skips the Security module", {
  skip: process.platform !== "win32" ? "Windows only" : false
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-explorer-cert-"));
  try {
    const pfxPath = path.join(dir, "explorer-command.pfx");
    const cerPath = path.join(dir, "explorer-command.cer");
    const stdout = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        buildWindowsExplorerCommandCertScript({
          pfxPath,
          cerPath,
          subject: identity.publisher
        })
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, FB_EXPLORER_CERT_PASSWORD: "unit-test-password" }
      }
    );
    const parsed = JSON.parse(String(stdout).trim());
    assert.match(String(parsed.thumbprint), /^[0-9A-Fa-f]{40}$/);
    assert.ok(fs.existsSync(pfxPath));
    assert.ok(fs.existsSync(cerPath));
    assert.ok(fs.statSync(pfxPath).size > 0);
    assert.ok(fs.statSync(cerPath).size > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applyWindowsExplorerCommandPackage is idempotent and skips missing payloads", async () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-explorer-install-"));
  const stampPath = path.join(installDir, "stamp.json");
  try {
    const skipped = await applyWindowsExplorerCommandPackage({
      packaged: true,
      installDir,
      stampPath,
      isDevInstance: false
    });
    if (process.platform === "win32") {
      assert.equal(skipped, "skipped");
    }

    const paths = windowsExplorerCommandPaths(installDir);
    fs.writeFileSync(paths.dll, "dll");
    fs.writeFileSync(paths.msix, "msix");
    fs.writeFileSync(paths.cer, "cer");
    fs.writeFileSync(
      paths.meta,
      JSON.stringify({
        packageName: identity.packageName,
        version: "0.9.26.0",
        publisher: identity.publisher,
        thumbprint: "DEADBEEF",
        clsid: identity.clsid,
        dllName: identity.dllName,
        msixName: identity.msixName,
        cerName: identity.cerName
      }),
      "utf8"
    );
    assert.equal(readWindowsExplorerCommandPayload(installDir)?.thumbprint, "DEADBEEF");

    const next = {
      packageName: identity.packageName,
      version: "0.9.26.0",
      installDir,
      thumbprint: "DEADBEEF"
    };
    assert.equal(shouldRegisterWindowsExplorerCommand(null, next), true);
    writeWindowsExplorerCommandStamp(stampPath, next);
    assert.equal(shouldRegisterWindowsExplorerCommand(readWindowsExplorerCommandStamp(stampPath), next), false);

    const scripts = [];
    const result = await applyWindowsExplorerCommandPackage(
      {
        packaged: true,
        installDir,
        stampPath,
        isDevInstance: false
      },
      async (script) => {
        scripts.push(script);
        return "ok";
      }
    );
    if (process.platform === "win32") {
      assert.equal(result, "unchanged");
      assert.equal(scripts.length, 0);
    } else {
      assert.equal(result, "skipped");
    }

    fs.writeFileSync(
      paths.meta,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(paths.meta, "utf8")),
        version: "0.9.27.0"
      }),
      "utf8"
    );
    const updated = await applyWindowsExplorerCommandPackage(
      {
        packaged: true,
        installDir,
        stampPath,
        isDevInstance: false
      },
      async (script) => {
        scripts.push(script);
        return "ok";
      }
    );
    if (process.platform === "win32") {
      assert.equal(updated, "registered");
      assert.equal(scripts.length, 1);
      assert.match(scripts[0], /Add-AppxPackage/);
    }
  } finally {
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});
