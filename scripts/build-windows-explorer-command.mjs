import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

function rvaToFileOffset(buf, rva) {
  const peOff = buf.readUInt32LE(0x3c);
  const coff = peOff + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const sizeOfOptional = buf.readUInt16LE(coff + 16);
  const sectionOff = coff + 20 + sizeOfOptional;
  for (let i = 0; i < numSections; i += 1) {
    const section = sectionOff + i * 40;
    const virtualAddress = buf.readUInt32LE(section + 12);
    const rawSize = buf.readUInt32LE(section + 16);
    const rawPtr = buf.readUInt32LE(section + 20);
    const virtualSize = buf.readUInt32LE(section + 8);
    const span = Math.max(virtualSize, rawSize);
    if (rva >= virtualAddress && rva < virtualAddress + span) {
      return rawPtr + (rva - virtualAddress);
    }
  }
  return -1;
}

export function listPeExportNames(dllPath) {
  const buf = fs.readFileSync(dllPath);
  if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`Not a PE image: ${dllPath}`);
  }
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff <= 0 || peOff + 24 > buf.length || buf.toString("ascii", peOff, peOff + 4) !== "PE\0\0") {
    throw new Error(`Invalid PE header: ${dllPath}`);
  }
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  const ddOff = magic === 0x20b ? optOff + 112 : optOff + 96;
  const exportRva = buf.readUInt32LE(ddOff);
  const exportSize = buf.readUInt32LE(ddOff + 4);
  if (!exportRva || !exportSize) return [];
  const expOff = rvaToFileOffset(buf, exportRva);
  if (expOff < 0) return [];
  const numberOfNames = buf.readUInt32LE(expOff + 24);
  const namesRva = buf.readUInt32LE(expOff + 32);
  const namesOff = rvaToFileOffset(buf, namesRva);
  if (namesOff < 0) return [];
  const names = [];
  for (let i = 0; i < numberOfNames; i += 1) {
    const nameRva = buf.readUInt32LE(namesOff + i * 4);
    const nameOff = rvaToFileOffset(buf, nameRva);
    if (nameOff < 0) continue;
    let end = nameOff;
    while (end < buf.length && buf[end] !== 0) end += 1;
    names.push(buf.toString("ascii", nameOff, end));
  }
  return names;
}

function assertComExports(dllPath) {
  const names = listPeExportNames(dllPath);
  const required = ["DllGetClassObject", "DllCanUnloadNow"];
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length) {
    throw new Error(
      `Explorer command DLL is missing COM exports (${missing.join(", ")}). Found: ${names.join(", ") || "(none)"}`
    );
  }
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
    const batDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-explorer-cl-"));
    try {
      const batPath = path.join(batDir, "build.bat");
      fs.writeFileSync(
        batPath,
        [
          "@echo off",
          `call "${msvc.vcvars}"`,
          `if errorlevel 1 exit /b %ERRORLEVEL%`,
          // cl.exe does not forward a bare /DEF: flag to the linker, which
          // ships a DLL with no exports. Explorer then hides the verb
          // (CO_E_ERRORINDLL / 0x800401F9).
          `cl /nologo /O2 /LD /EHsc /MT /utf-8 /DUNICODE /D_UNICODE /W3 /Fe:"${outDll}" "${cpp}" ole32.lib oleaut32.lib shell32.lib shlwapi.lib uuid.lib /link /DEF:"${def}"`,
          "exit /b %ERRORLEVEL%"
        ].join("\r\n"),
        "utf8"
      );
      execFileSync(batPath, {
        stdio: options.silent ? "pipe" : "inherit",
        windowsHide: true,
        shell: true
      });
      cleanupMsvcByproducts(outDir, outDll);
      assertComExports(outDll);
      return outDll;
    } catch (err) {
      if (!gxx) throw err;
      if (!options.silent) {
        console.warn("[explorer-command] MSVC build failed, falling back to MinGW:", err.message || err);
      }
    } finally {
      fs.rmSync(batDir, { recursive: true, force: true });
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
    assertComExports(outDll);
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
