import test from "node:test";
import assert from "node:assert/strict";

const {
  WINDOWS_CREDENTIAL_MAX_BYTES,
  validateKeyringTarget,
  buildMacSecurityInteractiveWriteInput,
  buildWindowsCredReadScript,
  buildWindowsCredWriteScript,
  buildWindowsCredDeleteScript
} = await import("../dist-electron/cli/systemKeyring.js");

test("validateKeyringTarget accepts clean names and rejects unsafe characters", () => {
  assert.deepEqual(validateKeyringTarget("gemini", "antigravity"), {
    service: "gemini",
    account: "antigravity"
  });

  for (const [service, account] of [
    ["", "antigravity"],
    ["gemini", ""],
    ["   ", "antigravity"],
    ["gemini\nadd", "antigravity"],
    ["gemini", "anti\rgravity"],
    ['gemini"quote', "antigravity"],
    ["gemini", "anti'gravity"],
    ["gemini\0null", "antigravity"]
  ]) {
    assert.throws(() => validateKeyringTarget(service, account));
  }
});

test("buildMacSecurityInteractiveWriteInput hex-encodes secret for stdin without plaintext leakage", () => {
  const secret = 'go-keyring-base64:{"token":"super-secret-\nline"}';
  const input = buildMacSecurityInteractiveWriteInput(
    "gemini",
    "antigravity",
    secret
  );
  const expectedHex = Buffer.from(secret, "utf8").toString("hex");
  assert.equal(
    input,
    `add-generic-password -U -s "gemini" -a "antigravity" -X "${expectedHex}"\n`
  );
  assert.doesNotMatch(input, /super-secret/);
});

test("Windows credential PowerShell script builders enforce stdin UTF-8, Persist=2, 2560-byte cap, and ERROR_NOT_FOUND", () => {
  const readScript = buildWindowsCredReadScript("gemini", "antigravity");
  assert.match(readScript, /CredReadW/);
  assert.match(readScript, /'gemini:antigravity'/);

  const writeScript = buildWindowsCredWriteScript("gemini", "antigravity");
  assert.match(writeScript, /CredWriteW/);
  assert.match(writeScript, /cred\.Persist = 2;/);
  assert.match(writeScript, /\[Console\]::InputEncoding = \[System\.Text\.Encoding\]::UTF8/);
  assert.match(writeScript, /\[Console\]::In\.ReadToEnd\(\)/);
  assert.match(writeScript, new RegExp(String(WINDOWS_CREDENTIAL_MAX_BYTES)));
  assert.match(writeScript, /Marshal\.ZeroFreeCoTaskMemUnicode/);

  const deleteScript = buildWindowsCredDeleteScript("gemini", "antigravity");
  assert.match(deleteScript, /CredDeleteW/);
  assert.match(deleteScript, /'gemini:antigravity'/);
  assert.match(deleteScript, /if \(err == 1168\)/);
});
