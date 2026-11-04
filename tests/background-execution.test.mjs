import test from "node:test";
import assert from "node:assert/strict";
import {
  authenticationExecutionEnv, backgroundExecutionArgs, backgroundExecutionEnv, backgroundExecutionPrompt
} from "../dist-electron/cli/backgroundExecution.js";

test("background Git guards override inherited interaction flags without changing auth helpers or install policy", () => {
  const original = { Path: "runtime", GCM_INTERACTIVE: "true", git_terminal_prompt: "1", GIT_ASKPASS: "existing-helper", SSH_AUTH_SOCK: "agent" };
  const env = backgroundExecutionEnv(original);
  assert.equal(env.GCM_INTERACTIVE, "0");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.git_terminal_prompt, undefined);
  assert.equal(env.GIT_ASKPASS, "existing-helper");
  assert.equal(env.SSH_AUTH_SOCK, "agent");
  assert.equal(env.CI, undefined);
  assert.equal(env.npm_config_yes, undefined);
  assert.equal(original.GCM_INTERACTIVE, "true");
});

test("explicit authentication restores original interaction policy and keeps prepared runtime environment", () => {
  const original = { GCM_INTERACTIVE: "true", git_terminal_prompt: "1" };
  const env = authenticationExecutionEnv({ ...backgroundExecutionEnv(original), NODE_OPTIONS: "runtime-hook" }, original);
  assert.equal(env.GCM_INTERACTIVE, "true");
  assert.equal(env.git_terminal_prompt, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, undefined);
  assert.equal(env.NODE_OPTIONS, "runtime-hook");
  assert.deepEqual(authenticationExecutionEnv(backgroundExecutionEnv({}), {}), {});
});

test("PowerShell startup flags are inserted before script payload without rewriting its variables", () => {
  const script = '$taskDir = Join-Path $env:USERPROFILE "www"; Test-Path $taskDir';
  for (const command of ["powershell", "pwsh.exe", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "/usr/bin/pwsh"]) {
    assert.deepEqual(backgroundExecutionArgs(command, ["-Command", script]), ["-NonInteractive", "-Command", script]);
  }
  assert.deepEqual(backgroundExecutionArgs("powershell", ["-Command", "-NonInteractive"]), ["-NonInteractive", "-Command", "-NonInteractive"]);
  assert.deepEqual(backgroundExecutionArgs("powershell", ["-NonInteractive", "-File", "script.ps1"]), ["-NonInteractive", "-File", "script.ps1"]);
  assert.deepEqual(backgroundExecutionArgs("node", ["-e", script]), ["-e", script]);
});

test("Windows native tools receive command quoting and noninteractive execution guidance", () => {
  const prompt = backgroundExecutionPrompt("do the task", "win32");
  assert.ok(prompt.endsWith("do the task"));
  assert.match(prompt, /-NonInteractive/);
  assert.match(prompt, /outer shell expands \$variables/);
  assert.equal(backgroundExecutionPrompt("do the task", "darwin"), "do the task");
});
