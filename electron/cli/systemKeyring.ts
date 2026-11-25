import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolveWindowsPowerShell } from "./windowsEnv.js";

const execFileAsync = promisify(execFile);

export const WINDOWS_CREDENTIAL_MAX_BYTES = 2560;

const INVALID_TARGET_PATTERN = /[\u0000-\u001F\u007F"']/;

export function validateKeyringTarget(service: string, account: string): {
  service: string;
  account: string;
} {
  const cleanService = service.trim();
  const cleanAccount = account.trim();
  if (!cleanService || !cleanAccount) {
    throw new Error("Keyring service and account are required.");
  }
  if (
    INVALID_TARGET_PATTERN.test(cleanService) ||
    INVALID_TARGET_PATTERN.test(cleanAccount)
  ) {
    throw new Error("Invalid keyring target characters.");
  }
  return { service: cleanService, account: cleanAccount };
}

export function buildMacSecurityInteractiveWriteInput(
  service: string,
  account: string,
  secret: string
): string {
  const valid = validateKeyringTarget(service, account);
  const hex = Buffer.from(secret, "utf8").toString("hex");
  return `add-generic-password -U -s "${valid.service}" -a "${valid.account}" -X "${hex}"\n`;
}

export function buildWindowsCredReadScript(service: string, account: string): string {
  const valid = validateKeyringTarget(service, account);
  const target = `${valid.service}:${valid.account}`;
  return `
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinCredReader {
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr buffer);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    public static string ReadGeneric(string target) {
        IntPtr credPtr = IntPtr.Zero;
        if (!CredRead(target, 1, 0, out credPtr) || credPtr == IntPtr.Zero) {
            return null;
        }
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
            if (cred.CredentialBlobSize == 0 || cred.CredentialBlob == IntPtr.Zero) {
                return string.Empty;
            }
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);
            if (bytes.Length >= 2 && bytes[1] == 0 && (bytes.Length < 4 || bytes[3] == 0)) {
                return Encoding.Unicode.GetString(bytes);
            }
            return Encoding.UTF8.GetString(bytes);
        } finally {
            CredFree(credPtr);
        }
    }
}
'@;
Add-Type -TypeDefinition $code;
$secret = [WinCredReader]::ReadGeneric('${target}');
if ($null -eq $secret -and '${valid.service}') {
    $secret = [WinCredReader]::ReadGeneric('${valid.service}');
}
if ($null -ne $secret) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
    [Console]::Out.Write($secret);
} else {
    exit 1;
}
`;
}

export function buildWindowsCredWriteScript(service: string, account: string): string {
  const valid = validateKeyringTarget(service, account);
  const target = `${valid.service}:${valid.account}`;
  return `
$code = @'
using System;
using System.Runtime.InteropServices;

public class WinCredWriter {
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    public static int WriteGeneric(string target, string userName, byte[] blobBytes) {
        if (blobBytes.Length > ${WINDOWS_CREDENTIAL_MAX_BYTES}) {
            throw new ArgumentException("Credential blob exceeds Windows ${WINDOWS_CREDENTIAL_MAX_BYTES}-byte limit.");
        }
        CREDENTIAL cred = new CREDENTIAL();
        cred.Flags = 0;
        cred.Type = 1;
        cred.Persist = 2;
        cred.TargetName = IntPtr.Zero;
        cred.Comment = IntPtr.Zero;
        cred.LastWritten = 0;
        cred.CredentialBlobSize = (uint)blobBytes.Length;
        cred.CredentialBlob = IntPtr.Zero;
        cred.AttributeCount = 0;
        cred.Attributes = IntPtr.Zero;
        cred.TargetAlias = IntPtr.Zero;
        cred.UserName = IntPtr.Zero;
        try {
            cred.TargetName = Marshal.StringToCoTaskMemUni(target);
            if (!string.IsNullOrEmpty(userName)) {
                cred.UserName = Marshal.StringToCoTaskMemUni(userName);
            }
            if (blobBytes.Length > 0) {
                cred.CredentialBlob = Marshal.AllocCoTaskMem(blobBytes.Length);
                Marshal.Copy(blobBytes, 0, cred.CredentialBlob, blobBytes.Length);
            }
            if (!CredWrite(ref cred, 0)) {
                return Marshal.GetLastWin32Error();
            }
            return 0;
        } finally {
            if (cred.TargetName != IntPtr.Zero) Marshal.ZeroFreeCoTaskMemUnicode(cred.TargetName);
            if (cred.UserName != IntPtr.Zero) Marshal.ZeroFreeCoTaskMemUnicode(cred.UserName);
            if (cred.CredentialBlob != IntPtr.Zero) {
                Marshal.Copy(new byte[blobBytes.Length], 0, cred.CredentialBlob, blobBytes.Length);
                Marshal.FreeCoTaskMem(cred.CredentialBlob);
            }
        }
    }
}
'@;
Add-Type -TypeDefinition $code;
[Console]::InputEncoding = [System.Text.Encoding]::UTF8;
$secret = [Console]::In.ReadToEnd();
$bytes = [System.Text.Encoding]::UTF8.GetBytes($secret);
if ($bytes.Length -gt ${WINDOWS_CREDENTIAL_MAX_BYTES}) {
    [Console]::Error.WriteLine("Credential exceeds Windows ${WINDOWS_CREDENTIAL_MAX_BYTES}-byte limit.");
    exit 2;
}
$win32Err = [WinCredWriter]::WriteGeneric('${target}', '${valid.account}', $bytes);
if ($win32Err -ne 0) {
    [Console]::Error.WriteLine("CredWriteW failed with Win32 error $win32Err");
    exit 1;
}
`;
}

export function buildWindowsCredDeleteScript(service: string, account: string): string {
  const valid = validateKeyringTarget(service, account);
  const target = `${valid.service}:${valid.account}`;
  return `
$code = @'
using System;
using System.Runtime.InteropServices;

public class WinCredDeleter {
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, int type, int flags);

    public static int DeleteGeneric(string target) {
        if (CredDelete(target, 1, 0)) {
            return 0;
        }
        int err = Marshal.GetLastWin32Error();
        if (err == 1168) {
            return 0;
        }
        return err;
    }
}
'@;
Add-Type -TypeDefinition $code;
$win32Err = [WinCredDeleter]::DeleteGeneric('${target}');
if ($win32Err -ne 0) {
    [Console]::Error.WriteLine("CredDeleteW failed with Win32 error $win32Err");
    exit 1;
}
`;
}

function isMacNotFoundError(error: unknown): boolean {
  const e = error as { code?: unknown; stderr?: unknown; message?: unknown };
  const text = `${String(e?.stderr ?? "")}\n${String(e?.message ?? "")}`;
  return (
    e?.code === 44 ||
    /SecKeychainItemCopyAttributesAndData|could not be found|not found/i.test(text)
  );
}

function isLinuxNotFoundError(error: unknown): boolean {
  const e = error as { code?: unknown; stderr?: unknown; message?: unknown };
  const text = `${String(e?.stderr ?? "")}\n${String(e?.message ?? "")}`.trim();
  return e?.code === 1 && text.length === 0;
}

function spawnWithStdin(
  file: string,
  args: string[],
  stdinText: string,
  options: { windowsHide?: boolean; failOnStderrPattern?: RegExp } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: options.windowsHide
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      const detail = stderr.trim();
      const stderrFailed = Boolean(
        options.failOnStderrPattern &&
          detail &&
          options.failOnStderrPattern.test(detail)
      );
      if (code === 0 && !stderrFailed) {
        resolve();
        return;
      }
      reject(
        new Error(
          detail || `${file} exited with code ${code ?? -1}`
        )
      );
    });
    child.stdin?.end(stdinText, "utf8");
  });
}

export async function readSystemKeyringSecret(
  service: string,
  account: string
): Promise<string | null> {
  const valid = validateKeyringTarget(service, account);
  const platform = process.platform;

  if (platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        valid.service,
        "-a",
        valid.account,
        "-w"
      ]);
      const value = stdout.replace(/\r?\n$/, "");
      return value.length > 0 ? value : null;
    } catch (error) {
      if (isMacNotFoundError(error)) return null;
      throw error;
    }
  }

  if (platform === "linux") {
    try {
      const { stdout } = await execFileAsync("secret-tool", [
        "lookup",
        "service",
        valid.service,
        "account",
        valid.account
      ]);
      const value = stdout.replace(/\r?\n$/, "");
      return value.length > 0 ? value : null;
    } catch (error) {
      if (isLinuxNotFoundError(error)) return null;
      throw error;
    }
  }

  if (platform === "win32") {
    const psScript = buildWindowsCredReadScript(valid.service, valid.account);
    const encodedCommand = Buffer.from(psScript, "utf16le").toString("base64");
    const pwshPath = resolveWindowsPowerShell(process.env);
    try {
      const { stdout } = await execFileAsync(pwshPath, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand
      ], { windowsHide: true });
      return stdout;
    } catch (error) {
      const e = error as { code?: unknown; stderr?: unknown };
      const stderrText = String(e?.stderr ?? "").trim();
      if (e?.code === 1 && !stderrText) {
        return null;
      }
      throw error;
    }
  }

  throw new Error(`Unsupported keyring platform: ${platform}`);
}

export async function writeSystemKeyringSecret(
  service: string,
  account: string,
  secret: string
): Promise<void> {
  const valid = validateKeyringTarget(service, account);
  const platform = process.platform;

  if (platform === "darwin") {
    const input = buildMacSecurityInteractiveWriteInput(
      valid.service,
      valid.account,
      secret
    );
    await spawnWithStdin("security", ["-i"], input, {
      failOnStderrPattern: /security:\s+/i
    });
    return;
  }

  if (platform === "linux") {
    await spawnWithStdin(
      "secret-tool",
      [
        "store",
        "--label",
        `${valid.service}:${valid.account}`,
        "service",
        valid.service,
        "account",
        valid.account
      ],
      secret
    );
    return;
  }

  if (platform === "win32") {
    const byteLength = Buffer.byteLength(secret, "utf8");
    if (byteLength > WINDOWS_CREDENTIAL_MAX_BYTES) {
      throw new Error(
        `Credential exceeds Windows ${WINDOWS_CREDENTIAL_MAX_BYTES}-byte limit (${byteLength} bytes).`
      );
    }
    const psScript = buildWindowsCredWriteScript(valid.service, valid.account);
    const encodedCommand = Buffer.from(psScript, "utf16le").toString("base64");
    const pwshPath = resolveWindowsPowerShell(process.env);
    await spawnWithStdin(
      pwshPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand
      ],
      secret,
      { windowsHide: true }
    );
    return;
  }

  throw new Error(`Unsupported keyring platform: ${platform}`);
}

export async function deleteSystemKeyringSecret(
  service: string,
  account: string
): Promise<void> {
  const valid = validateKeyringTarget(service, account);
  const platform = process.platform;

  if (platform === "darwin") {
    try {
      await execFileAsync("security", [
        "delete-generic-password",
        "-s",
        valid.service,
        "-a",
        valid.account
      ]);
    } catch (error) {
      if (isMacNotFoundError(error)) return;
      throw error;
    }
    return;
  }

  if (platform === "linux") {
    try {
      await execFileAsync("secret-tool", [
        "clear",
        "service",
        valid.service,
        "account",
        valid.account
      ]);
    } catch (error) {
      if (isLinuxNotFoundError(error)) return;
      throw error;
    }
    return;
  }

  if (platform === "win32") {
    const psScript = buildWindowsCredDeleteScript(valid.service, valid.account);
    const encodedCommand = Buffer.from(psScript, "utf16le").toString("base64");
    const pwshPath = resolveWindowsPowerShell(process.env);
    await execFileAsync(pwshPath, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedCommand
    ], { windowsHide: true });
    return;
  }

  throw new Error(`Unsupported keyring platform: ${platform}`);
}
