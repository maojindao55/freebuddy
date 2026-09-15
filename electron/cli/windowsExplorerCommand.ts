import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Keep in sync with desktop/windows/explorer-command/identity.json */
export const WINDOWS_EXPLORER_COMMAND = {
  clsid: "{5C8A1E2D-9B74-4A16-8F3C-6E2D91B0487A}",
  packageName: "dev.freebuddy.app.shell",
  devPackageName: "dev.freebuddy.app.dev.shell",
  publisher: "CN=FreeBuddy",
  publisherDisplayName: "FreeBuddy",
  dllName: "FreeBuddyExplorerCommand.dll",
  msixName: "FreeBuddyExplorerCommand.msix",
  cerName: "FreeBuddyExplorerCommand.cer",
  metaName: "FreeBuddyExplorerCommand.json"
} as const;

export function windowsExplorerCommandPackageName(isDevInstance: boolean): string {
  return isDevInstance
    ? WINDOWS_EXPLORER_COMMAND.devPackageName
    : WINDOWS_EXPLORER_COMMAND.packageName;
}

export function toMsixVersion(version: string): string {
  const core = (version.split("-")[0] || "0").trim();
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  while (parts.length < 4) parts.push(0);
  if (parts.length > 4) parts.length = 4;
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 65535)) {
    throw new Error(`Invalid MSIX version: ${version}`);
  }
  return parts.join(".");
}

export function clsidWithoutBraces(clsid: string): string {
  return clsid.replace(/[{}]/g, "");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface WindowsExplorerCommandManifestSpec {
  packageName: string;
  version: string;
  publisher?: string;
  publisherDisplayName?: string;
  executable: string;
  dllName?: string;
  clsid?: string;
  architecture?: "x64" | "x86" | "arm64" | "neutral";
  displayName?: string;
}

export function buildWindowsExplorerCommandAppxManifest(
  spec: WindowsExplorerCommandManifestSpec
): string {
  const clsid = clsidWithoutBraces(spec.clsid || WINDOWS_EXPLORER_COMMAND.clsid);
  const publisher = spec.publisher || WINDOWS_EXPLORER_COMMAND.publisher;
  const publisherDisplayName =
    spec.publisherDisplayName || WINDOWS_EXPLORER_COMMAND.publisherDisplayName;
  const dllName = spec.dllName || WINDOWS_EXPLORER_COMMAND.dllName;
  const architecture = spec.architecture || "neutral";
  const displayName = spec.displayName || "FreeBuddy";
  const version = toMsixVersion(spec.version);
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:desktop4="http://schemas.microsoft.com/appx/manifest/desktop/windows10/4"
  xmlns:desktop5="http://schemas.microsoft.com/appx/manifest/desktop/windows10/5"
  xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  xmlns:com="http://schemas.microsoft.com/appx/manifest/com/windows10"
  IgnorableNamespaces="uap uap10 desktop4 desktop5 desktop6 rescap com">
  <Identity
    Name="${escapeXml(spec.packageName)}"
    Publisher="${escapeXml(publisher)}"
    Version="${escapeXml(version)}"
    ProcessorArchitecture="${escapeXml(architecture)}" />
  <Properties>
    <DisplayName>${escapeXml(displayName)}</DisplayName>
    <PublisherDisplayName>${escapeXml(publisherDisplayName)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <uap10:AllowExternalContent>true</uap10:AllowExternalContent>
    <desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization>
    <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>
  </Properties>
  <Resources>
    <Resource Language="en-us" />
    <Resource Language="zh-cn" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
    <rescap:Capability Name="unvirtualizedResources" />
  </Capabilities>
  <Applications>
    <Application
      Id="FreeBuddy"
      Executable="${escapeXml(spec.executable)}"
      uap10:TrustLevel="mediumIL"
      uap10:RuntimeBehavior="win32App">
      <uap:VisualElements
        AppListEntry="none"
        DisplayName="${escapeXml(displayName)}"
        Description="FreeBuddy Explorer Command"
        BackgroundColor="transparent"
        Square150x150Logo="Assets\\StoreLogo.png"
        Square44x44Logo="Assets\\StoreLogo.png" />
      <Extensions>
        <desktop4:Extension Category="windows.fileExplorerContextMenus">
          <desktop4:FileExplorerContextMenus>
            <desktop5:ItemType Type="Directory">
              <desktop5:Verb Id="OpenWithFreeBuddy" Clsid="${clsid}" />
            </desktop5:ItemType>
            <desktop5:ItemType Type="Directory\\Background">
              <desktop5:Verb Id="OpenWithFreeBuddy" Clsid="${clsid}" />
            </desktop5:ItemType>
            <desktop5:ItemType Type="*">
              <desktop5:Verb Id="OpenWithFreeBuddy" Clsid="${clsid}" />
            </desktop5:ItemType>
          </desktop4:FileExplorerContextMenus>
        </desktop4:Extension>
        <com:Extension Category="windows.comServer">
          <com:ComServer>
            <com:SurrogateServer DisplayName="FreeBuddy Explorer Command">
              <com:Class Id="${clsid}" Path="${escapeXml(dllName)}" ThreadingModel="STA" />
            </com:SurrogateServer>
          </com:ComServer>
        </com:Extension>
      </Extensions>
    </Application>
  </Applications>
</Package>
`;
}

export interface WindowsExplorerCommandPayload {
  packageName: string;
  version: string;
  publisher: string;
  thumbprint: string;
  clsid: string;
  dllName: string;
  msixName: string;
  cerName: string;
}

export interface WindowsExplorerCommandPaths {
  dll: string;
  msix: string;
  cer: string;
  meta: string;
}

export function windowsExplorerCommandPaths(installDir: string): WindowsExplorerCommandPaths {
  return {
    dll: path.join(installDir, WINDOWS_EXPLORER_COMMAND.dllName),
    msix: path.join(installDir, WINDOWS_EXPLORER_COMMAND.msixName),
    cer: path.join(installDir, WINDOWS_EXPLORER_COMMAND.cerName),
    meta: path.join(installDir, WINDOWS_EXPLORER_COMMAND.metaName)
  };
}

export function readWindowsExplorerCommandPayload(
  installDir: string
): WindowsExplorerCommandPayload | null {
  const metaPath = windowsExplorerCommandPaths(installDir).meta;
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Partial<WindowsExplorerCommandPayload>;
    if (
      typeof parsed.packageName !== "string" ||
      typeof parsed.version !== "string" ||
      typeof parsed.publisher !== "string" ||
      typeof parsed.thumbprint !== "string" ||
      typeof parsed.msixName !== "string" ||
      typeof parsed.cerName !== "string"
    ) {
      return null;
    }
    return {
      packageName: parsed.packageName,
      version: parsed.version,
      publisher: parsed.publisher,
      thumbprint: parsed.thumbprint,
      clsid: parsed.clsid || WINDOWS_EXPLORER_COMMAND.clsid,
      dllName: parsed.dllName || WINDOWS_EXPLORER_COMMAND.dllName,
      msixName: parsed.msixName,
      cerName: parsed.cerName
    };
  } catch {
    return null;
  }
}

export interface WindowsExplorerCommandStamp {
  packageName: string;
  version: string;
  installDir: string;
  thumbprint: string;
}

export function shouldRegisterWindowsExplorerCommand(
  stamp: WindowsExplorerCommandStamp | null,
  next: WindowsExplorerCommandStamp
): boolean {
  if (!stamp) return true;
  return (
    stamp.packageName !== next.packageName ||
    stamp.version !== next.version ||
    path.resolve(stamp.installDir) !== path.resolve(next.installDir) ||
    stamp.thumbprint.toLowerCase() !== next.thumbprint.toLowerCase()
  );
}

export function readWindowsExplorerCommandStamp(
  stampPath: string
): WindowsExplorerCommandStamp | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath, "utf8")) as Partial<WindowsExplorerCommandStamp>;
    if (
      typeof parsed.packageName !== "string" ||
      typeof parsed.version !== "string" ||
      typeof parsed.installDir !== "string" ||
      typeof parsed.thumbprint !== "string"
    ) {
      return null;
    }
    return {
      packageName: parsed.packageName,
      version: parsed.version,
      installDir: parsed.installDir,
      thumbprint: parsed.thumbprint
    };
  } catch {
    return null;
  }
}

export function writeWindowsExplorerCommandStamp(
  stampPath: string,
  stamp: WindowsExplorerCommandStamp
): void {
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

export function buildWindowsExplorerCommandTrustScript(): string {
  return `
param(
  [Parameter(Mandatory = $true)]
  [string]$CerPath
)
$ErrorActionPreference = 'Stop'
Import-Certificate -FilePath $CerPath -CertStoreLocation 'Cert:\\LocalMachine\\TrustedPeople' | Out-Null
`.trim();
}

export function buildWindowsExplorerCommandRegisterScript(spec: {
  installDir: string;
  msixPath: string;
  cerPath: string;
  packageName: string;
  thumbprint: string;
}): string {
  const installDir = escapePowerShellSingleQuoted(spec.installDir);
  const msixPath = escapePowerShellSingleQuoted(spec.msixPath);
  const cerPath = escapePowerShellSingleQuoted(spec.cerPath);
  const packageName = escapePowerShellSingleQuoted(spec.packageName);
  const thumbprint = escapePowerShellSingleQuoted(spec.thumbprint.replace(/\s/g, ""));
  return `
$ErrorActionPreference = 'Stop'
$cer = '${cerPath}'
$msix = '${msixPath}'
$loc = '${installDir}'
$name = '${packageName}'
$thumb = '${thumbprint}'.ToUpperInvariant()
$trustScript = Join-Path $loc 'trust-explorer-command.ps1'
function Test-ThumbprintInStore([string]$storePath) {
  return [bool](Get-ChildItem $storePath -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $thumb })
}
function Import-CurrentUserTrust {
  if (Test-ThumbprintInStore 'Cert:\\CurrentUser\\TrustedPeople') { return }
  Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\\CurrentUser\\TrustedPeople' | Out-Null
}
function Import-LocalMachineTrust {
  if (Test-ThumbprintInStore 'Cert:\\LocalMachine\\TrustedPeople') { return $true }
  try {
    Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\\LocalMachine\\TrustedPeople' | Out-Null
    return $true
  } catch {
    return $false
  }
}
function Install-ExplorerCommandPackage {
  Get-AppxPackage -Name $name -ErrorAction SilentlyContinue | Remove-AppxPackage -ErrorAction SilentlyContinue
  Add-AppxPackage -Path $msix -ExternalLocation $loc -ForceUpdateFromAnyVersion
}
function Request-ElevatedLocalMachineTrust {
  if (-not (Test-Path $trustScript)) { throw "missing $trustScript" }
  $powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  $proc = Start-Process -FilePath $powershell -Verb RunAs -Wait -PassThru -ArgumentList @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $trustScript,
    '-CerPath',
    $cer
  )
  if ($null -eq $proc) { throw 'UAC certificate trust was cancelled' }
  if ($proc.ExitCode -ne 0) { throw "elevated certificate trust failed with $($proc.ExitCode)" }
  if (-not (Test-ThumbprintInStore 'Cert:\\LocalMachine\\TrustedPeople')) {
    throw 'LocalMachine TrustedPeople still missing FreeBuddy certificate'
  }
}
Import-CurrentUserTrust
$machineTrusted = Import-LocalMachineTrust
try {
  Install-ExplorerCommandPackage
} catch {
  $text = "$($_.Exception.Message) $($_.FullyQualifiedErrorId) $($_.Exception.HResult)"
  if (-not $machineTrusted -and ($text -match '800B0109|80073CF0')) {
    Request-ElevatedLocalMachineTrust
    Install-ExplorerCommandPackage
  } else {
    throw
  }
}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FreeBuddyShellNotify {
  [DllImport("shell32.dll")]
  public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
"@
[FreeBuddyShellNotify]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) {
  Start-Process explorer
}
Get-AppxPackage -Name $name | Select-Object -ExpandProperty PackageFullName
`.trim();
}

export function buildWindowsExplorerCommandUnregisterScript(): string {
  const names = [
    WINDOWS_EXPLORER_COMMAND.packageName,
    WINDOWS_EXPLORER_COMMAND.devPackageName
  ];
  const list = names.map((name) => `'${escapePowerShellSingleQuoted(name)}'`).join(", ");
  const publisher = escapePowerShellSingleQuoted(WINDOWS_EXPLORER_COMMAND.publisher);
  return `
Get-AppxPackage | Where-Object { @(${list}) -contains $_.Name } | Remove-AppxPackage -ErrorAction SilentlyContinue
Get-ChildItem Cert:\\CurrentUser\\TrustedPeople -ErrorAction SilentlyContinue | Where-Object { $_.Subject -eq '${publisher}' } | Remove-Item -ErrorAction SilentlyContinue
Get-ChildItem Cert:\\LocalMachine\\TrustedPeople -ErrorAction SilentlyContinue | Where-Object { $_.Subject -eq '${publisher}' } | Remove-Item -ErrorAction SilentlyContinue
`.trim();
}

export interface ApplyWindowsExplorerCommandSpec {
  packaged: boolean;
  installDir: string;
  stampPath: string;
  isDevInstance: boolean;
}

export async function applyWindowsExplorerCommandPackage(
  spec: ApplyWindowsExplorerCommandSpec,
  runPowerShell: (script: string) => Promise<string> = runPowerShellScript
): Promise<"skipped" | "unchanged" | "registered"> {
  if (process.platform !== "win32") return "skipped";
  if (!spec.packaged) return "skipped";
  const payload = readWindowsExplorerCommandPayload(spec.installDir);
  if (!payload) return "skipped";
  const paths = windowsExplorerCommandPaths(spec.installDir);
  if (!fs.existsSync(paths.dll) || !fs.existsSync(paths.msix) || !fs.existsSync(paths.cer)) {
    return "skipped";
  }
  const next: WindowsExplorerCommandStamp = {
    packageName: payload.packageName,
    version: payload.version,
    installDir: path.resolve(spec.installDir),
    thumbprint: payload.thumbprint
  };
  const stamp = readWindowsExplorerCommandStamp(spec.stampPath);
  if (!shouldRegisterWindowsExplorerCommand(stamp, next)) return "unchanged";
  const script = buildWindowsExplorerCommandRegisterScript({
    installDir: next.installDir,
    msixPath: paths.msix,
    cerPath: paths.cer,
    packageName: payload.packageName,
    thumbprint: payload.thumbprint
  });
  await runPowerShell(script);
  writeWindowsExplorerCommandStamp(spec.stampPath, next);
  return "registered";
}

async function runPowerShellScript(script: string): Promise<string> {
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, timeout: 180000, encoding: "utf8" }
  );
  return String(result.stdout || "").trim();
}
