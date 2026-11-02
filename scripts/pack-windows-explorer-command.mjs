import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileWindowsExplorerCommandDll } from "./build-windows-explorer-command.mjs";
import {
  WINDOWS_EXPLORER_COMMAND,
  buildWindowsExplorerCommandAppxManifest,
  buildWindowsExplorerCommandTrustScript,
  buildWindowsExplorerCommandUnregisterScript,
  toMsixVersion,
  windowsExplorerCommandPackageName
} from "../dist-electron/cli/windowsExplorerCommand.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function kitRootCandidates() {
  return [
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Windows Kits", "10", "bin"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Windows Kits", "10", "bin")
  ];
}

function kitArch() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "ia32") return "x86";
  return "x64";
}

export function findWindowsKitTool(toolName) {
  const arch = kitArch();
  for (const root of kitRootCandidates()) {
    if (!fs.existsSync(root)) continue;
    const versions = fs
      .readdirSync(root)
      .filter((name) => /^\d+\./.test(name))
      .sort()
      .reverse();
    for (const version of versions) {
      const candidate = path.join(root, version, arch, toolName);
      if (fs.existsSync(candidate)) return candidate;
    }
    const flat = path.join(root, arch, toolName);
    if (fs.existsSync(flat)) return flat;
  }
  return null;
}

function mapMsixArchitecture(_arch) {
  // Sparse identity packages used by Zed/VS Code are architecture-neutral;
  // the real DLL lives at ExternalLocation.
  return "neutral";
}

export function buildWindowsExplorerCommandCertScript(spec) {
  const pfx = String(spec.pfxPath || "").replace(/'/g, "''");
  const cer = String(spec.cerPath || "").replace(/'/g, "''");
  const subject = String(spec.subject || WINDOWS_EXPLORER_COMMAND.publisher).replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
$pfx = '${pfx}'
$cer = '${cer}'
$plain = $env:FB_EXPLORER_CERT_PASSWORD
if (-not $plain) { throw 'FB_EXPLORER_CERT_PASSWORD is missing' }
$subject = New-Object System.Security.Cryptography.X509Certificates.X500DistinguishedName '${subject}'
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest($subject, $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$ekuOids = New-Object System.Security.Cryptography.OidCollection
[void]$ekuOids.Add((New-Object System.Security.Cryptography.Oid '1.3.6.1.5.5.7.3.3'))
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($ekuOids, $false)))
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $true)))
$cert = $req.CreateSelfSigned([DateTime]::UtcNow.AddDays(-1), [DateTime]::UtcNow.AddYears(10))
[System.IO.File]::WriteAllBytes($pfx, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $plain))
[System.IO.File]::WriteAllBytes($cer, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
@{ thumbprint = $cert.Thumbprint; pfx = $pfx; cer = $cer } | ConvertTo-Json -Compress
`.trim();
}

function powershellJson(script, env = {}) {
  const stdout = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...env }
    }
  );
  return JSON.parse(String(stdout).trim());
}

function createCodeSigningCert(workDir) {
  const pfxPath = path.join(workDir, "explorer-command.pfx");
  const cerPath = path.join(workDir, WINDOWS_EXPLORER_COMMAND.cerName);
  const password = crypto.randomBytes(16).toString("hex");
  const result = powershellJson(
    buildWindowsExplorerCommandCertScript({
      pfxPath,
      cerPath,
      subject: WINDOWS_EXPLORER_COMMAND.publisher
    }),
    { FB_EXPLORER_CERT_PASSWORD: password }
  );
  return {
    thumbprint: String(result.thumbprint || "").replace(/\s/g, ""),
    pfxPath,
    cerPath,
    password
  };
}

function signMsix(signtool, pfxPath, password, msixPath) {
  const common = ["/fd", "SHA256", "/f", pfxPath, "/p", password];
  try {
    execFileSync(
      signtool,
      ["sign", ...common, "/td", "SHA256", "/tr", "http://timestamp.digicert.com", msixPath],
      { stdio: "inherit", windowsHide: true }
    );
  } catch {
    execFileSync(signtool, ["sign", ...common, msixPath], {
      stdio: "inherit",
      windowsHide: true
    });
  }
}

export async function packWindowsExplorerCommand(context) {
  if (context.electronPlatformName !== "win32") return;
  const appOutDir = context.appOutDir;
  const isDev =
    context.packager.appInfo.productFilename?.toLowerCase().includes("dev") ||
    context.packager.config?.appId?.includes(".dev") ||
    false;
  const executable = `${context.packager.appInfo.productFilename}.exe`;
  const version = toMsixVersion(String(context.packager.appInfo.version || "0.0.0"));
  const packageName = windowsExplorerCommandPackageName(isDev);
  const architecture = mapMsixArchitecture(context.arch);

  let dllPath;
  try {
    dllPath = compileWindowsExplorerCommandDll(appOutDir);
    console.log(`[afterPack] Built ${dllPath}`);
    fs.writeFileSync(
      path.join(appOutDir, "uninstall-explorer-command.ps1"),
      `${buildWindowsExplorerCommandUnregisterScript()}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(appOutDir, "trust-explorer-command.ps1"),
      `${buildWindowsExplorerCommandTrustScript()}\n`,
      "utf8"
    );
  } catch (err) {
    console.warn("[afterPack] Windows Explorer command DLL skipped:", err);
    return;
  }

  const makeAppx = findWindowsKitTool("MakeAppx.exe");
  const signtool = findWindowsKitTool("signtool.exe");
  if (!makeAppx || !signtool) {
    console.warn(
      "[afterPack] Windows SDK MakeAppx/SignTool not found; Win11 first-level Explorer menu package was not built."
    );
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-explorer-msix-"));
  try {
    const payloadDir = path.join(workDir, "payload");
    const assetsDir = path.join(payloadDir, "Assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const logoSource = path.join(rootDir, "assets", "app-icon.png");
    fs.copyFileSync(logoSource, path.join(assetsDir, "StoreLogo.png"));
    const manifest = buildWindowsExplorerCommandAppxManifest({
      packageName,
      version,
      executable,
      architecture,
      displayName: context.packager.appInfo.productName || "FreeBuddy"
    });
    fs.writeFileSync(path.join(payloadDir, "AppxManifest.xml"), manifest, "utf8");

    const msixPath = path.join(appOutDir, WINDOWS_EXPLORER_COMMAND.msixName);
    try {
      fs.unlinkSync(msixPath);
    } catch {
      /* ignore */
    }
    execFileSync(makeAppx, ["pack", "/d", payloadDir, "/p", msixPath, "/nv"], {
      stdio: "inherit",
      windowsHide: true
    });

    const cert = createCodeSigningCert(workDir);
    signMsix(signtool, cert.pfxPath, cert.password, msixPath);
    fs.copyFileSync(cert.cerPath, path.join(appOutDir, WINDOWS_EXPLORER_COMMAND.cerName));
    const meta = {
      packageName,
      version,
      publisher: WINDOWS_EXPLORER_COMMAND.publisher,
      thumbprint: cert.thumbprint,
      clsid: WINDOWS_EXPLORER_COMMAND.clsid,
      dllName: WINDOWS_EXPLORER_COMMAND.dllName,
      msixName: WINDOWS_EXPLORER_COMMAND.msixName,
      cerName: WINDOWS_EXPLORER_COMMAND.cerName
    };
    fs.writeFileSync(
      path.join(appOutDir, WINDOWS_EXPLORER_COMMAND.metaName),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf8"
    );
    console.log(`[afterPack] Packed Win11 Explorer command ${msixPath}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return dllPath;
}

export default packWindowsExplorerCommand;
