import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(rootDir, "desktop", "windows", "explorer-command");

export function explorerCommandSourceDir() {
  return sourceDir;
}

function which(command) {
  const ext = process.platform === "win32" ? [".exe", ".bat", ".cmd", ""] : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    for (const suffix of ext) {
      const candidate = path.join(dir, command + suffix);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findVsInstall() {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  if (!fs.existsSync(vswhere)) return null;
  try {
    const install = execFileSync(
      vswhere,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath"
      ],
      { encoding: "utf8", windowsHide: true }
    ).trim();
    return install || null;
  } catch {
    return null;
  }
}

function findClExe(vsInstall) {
  const msvcRoot = path.join(vsInstall, "VC", "Tools", "MSVC");
  if (!fs.existsSync(msvcRoot)) return null;
  const versions = fs.readdirSync(msvcRoot).sort().reverse();
  for (const version of versions) {
    const cl = path.join(msvcRoot, version, "bin", "Hostx64", "x64", "cl.exe");
    if (fs.existsSync(cl)) return cl;
  }
  return null;
}

export function findMsvcCl() {
  const vsInstall = findVsInstall();
  if (!vsInstall) return null;
  const vcvars = path.join(vsInstall, "VC", "Auxiliary", "Build", "vcvars64.bat");
  if (!fs.existsSync(vcvars) || !findClExe(vsInstall)) return null;
  return { vcvars };
}

export function findMingwGxx() {
  const fromPath = which("g++");
  const candidates = [
    fromPath,
    "C:\\msys64\\mingw64\\bin\\g++.exe",
    "C:\\mingw64\\bin\\g++.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export function compileWindowsExplorerCommandDll(outDir, options = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const cpp = path.join(sourceDir, "ExplorerCommand.cpp");
  const def = path.join(sourceDir, "ExplorerCommand.def");
  const outDll = path.join(outDir, options.dllName || "FreeBuddyExplorerCommand.dll");
  const msvc = findMsvcCl();
  const gxx = findMingwGxx();
  if (msvc) {
    try {
      const cmd = `call "${msvc.vcvars}" && cl /nologo /O2 /LD /EHsc /MT /DUNICODE /D_UNICODE /W3 /Fe:"${outDll}" "${cpp}" /DEF:"${def}" ole32.lib oleaut32.lib shell32.lib shlwapi.lib uuid.lib`;
      execFileSync("cmd.exe", ["/d", "/s", "/c", cmd], {
        stdio: options.silent ? "pipe" : "inherit",
        windowsHide: true
      });
      cleanupMsvcByproducts(outDir, outDll);
      return outDll;
    } catch (err) {
      if (!gxx) throw err;
      if (!options.silent) {
        console.warn("[explorer-command] MSVC build failed, falling back to MinGW:", err.message || err);
      }
    }
  }
  if (gxx) {
    execFileSync(
      gxx,
      [
        "-shared",
        "-O2",
        "-fno-exceptions",
        "-fno-rtti",
        "-static-libgcc",
        "-o",
        outDll,
        cpp,
        def,
        "-lole32",
        "-loleaut32",
        "-lshell32",
        "-lshlwapi",
        "-luuid",
        "-Wl,--kill-at"
      ],
      { stdio: options.silent ? "pipe" : "inherit", windowsHide: true }
    );
    return outDll;
  }
  throw new Error("No MSVC cl.exe or MinGW g++ found to build FreeBuddyExplorerCommand.dll");
}

function cleanupMsvcByproducts(outDir, outDll) {
  const base = path.basename(outDll, ".dll");
  for (const ext of [".exp", ".lib", ".obj"]) {
    const leftover = path.join(outDir, `${base}${ext}`);
    try {
      if (fs.existsSync(leftover)) fs.unlinkSync(leftover);
    } catch {
      /* ignore */
    }
  }
  const objFromSource = path.join(outDir, "ExplorerCommand.obj");
  try {
    if (fs.existsSync(objFromSource)) fs.unlinkSync(objFromSource);
  } catch {
    /* ignore */
  }
}
