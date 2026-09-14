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

function mapMsixArchitecture(arch) {
  if (arch === "ia32" || arch === "x86") return "x86";
  if (arch === "arm64") return "arm64";
  return "x64";
}

function powershellJson(script) {
  const stdout = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true }
  );
  return JSON.parse(String(stdout).trim());
}

function createCodeSigningCert(workDir) {
  const pfxPath = path.join(workDir, "explorer-command.pfx");
  const cerPath = path.join(workDir, WINDOWS_EXPLORER_COMMAND.cerName);
  const password = crypto.randomBytes(16).toString("hex");
  const script = `
$ErrorActionPreference = 'Stop'
$pfx = '${pfxPath.replace(/'/g, "''")}'
$cer = '${cerPath.replace(/'/g, "''")}'
$password = ConvertTo-SecureString -String '${password}' -Force -AsPlainText
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject '${WINDOWS_EXPLORER_COMMAND.publisher}' -FriendlyName 'FreeBuddy Explorer Command' -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(10)
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath $cer -Type CERT | Out-Null
Remove-Item $cert.PSPath -ErrorAction SilentlyContinue
@{ thumbprint = $cert.Thumbprint; pfx = $pfx; cer = $cer } | ConvertTo-Json -Compress
`;
  const result = powershellJson(script);
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
