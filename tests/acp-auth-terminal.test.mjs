import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  appendAuthenticationTerminalOutput,
  authenticationTerminalLaunch,
  collapseCarriageReturns,
  comateLoginUrls,
  runAuthenticationTerminal,
  windowsComateNoBrowserLogin,
  writeAuthenticationTerminal
} from "../dist-electron/cli/acpAuthTerminal.js";

test("Windows terminal login runs npm cmd shims through cmd.exe", () => {
  const launch = authenticationTerminalLaunch(
    "C:\\Program Files\\nodejs\\comate-acp.cmd",
    ["--login"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe"
  );
  assert.equal(launch.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(launch.args, [
    "/d",
    "/s",
    "/c",
    "\"C:\\Program Files\\nodejs\\comate-acp.cmd\" --login"
  ]);
  assert.deepEqual(
    authenticationTerminalLaunch(
      "C:\\npm\\comate-acp.cmd",
      ["--login"],
      "win32",
      "cmd.exe"
    ).args[2],
    "/c"
  );
  assert.equal(
    authenticationTerminalLaunch(
      "C:\\npm\\comate-acp.cmd",
      ["--login"],
      "win32",
      "cmd.exe"
    ).args[3],
    "C:\\npm\\comate-acp.cmd --login"
  );
  assert.deepEqual(
    authenticationTerminalLaunch("comate-acp", ["--login"], "darwin"),
    { file: "comate-acp", args: ["--login"] }
  );
});

test("login countdown keeps the URL and only the latest carriage-return update", () => {
  const url =
    "https://comate.baidu.com/zh/login?track=COMATE_CLI&clientId=d1b93ea8-f59a-4fd3-b726-96380da51702&device=Morefine";
  const rendered = collapseCarriageReturns(
    `  ${url}\n\n\r等待授权完成… 剩余 180s（Ctrl+C 取消）   \r等待授权完成… 剩余 179s（Ctrl+C 取消）   `
  );
  assert.match(rendered, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(rendered, /剩余 179s/);
  assert.doesNotMatch(rendered, /剩余 180s/);
  assert.deepEqual(comateLoginUrls(rendered), [url]);

  assert.equal(
    collapseCarriageReturns(
      "Opening login...\r\r\n\u001b[31mLogin failed: membership is inactive.\u001b[0m\r\r\n"
    ),
    "Opening login...\n\u001b[31mLogin failed: membership is inactive.\u001b[0m\n"
  );
  assert.equal(
    collapseCarriageReturns("等待授权完成… 剩余 180s\r等待授权完成… 剩余 179s\r"),
    "等待授权完成… 剩余 179s"
  );

  // Streaming chunks may end with `\r` before an overwrite or split `\r\r\n` newline.
  let state = appendAuthenticationTerminalOutput("", `  ${url}\n\n\r等待 180s\r`);
  assert.equal(state.output, `  ${url}\n\n等待 180s`);
  state = appendAuthenticationTerminalOutput(state.buffer, "等待 179s\r");
  assert.equal(state.output, `  ${url}\n\n等待 179s`);
  state = appendAuthenticationTerminalOutput(state.buffer, "\r\nDone\r\r\n");
  assert.equal(state.output, `  ${url}\n\n等待 179s\nDone\n`);
});

test("Windows Comate login does not let cmd.exe split the authorization URL", () => {
  const bin = "C:\\npm\\comate-acp.cmd";
  const exists = (candidate) => candidate.endsWith("\\comatecli.cmd");
  assert.deepEqual(
    windowsComateNoBrowserLogin(bin, ["--login"], "win32", exists),
    { bin: "C:\\npm\\comatecli.cmd", args: ["login", "--no-browser"] }
  );
  assert.deepEqual(
    windowsComateNoBrowserLogin(bin, ["--login"], "darwin", exists),
    { bin, args: ["--login"] }
  );
});

test("terminal authentication uses a PTY, accepts input, and reports completion", async () => {
  const sessionId = "auth-terminal-test";
  const events = [];
  let requestId;
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });

  const completed = runAuthenticationTerminal({
    sessionId,
    agentName: "Mock Agent",
    method: { id: "terminal-login", name: "Terminal Login", type: "terminal" },
    command: {
      bin: process.execPath,
      args: [
        "-e",
        "process.stdin.setEncoding('utf8'); process.stdout.write('LOGIN> '); process.stdin.on('data', data => { if (data.includes('secret')) { process.stdout.write('AUTH_OK'); process.exit(0); } }); setTimeout(() => process.exit(2), 5000);"
      ],
      env: process.env
    },
    emit(event) {
      events.push(event);
      if (event.type === "authentication-terminal-started") {
        requestId = event.request.requestId;
        startedResolve();
      }
    }
  });

  await started;
  assert.ok(requestId);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (writeAuthenticationTerminal(sessionId, requestId, "secret\r")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await completed;

  assert.ok(
    events.some(
      (event) =>
        event.type === "authentication-terminal-update" &&
        event.output.includes("AUTH_OK")
    )
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "authentication-terminal-update" &&
        event.running === false &&
        event.exitCode === 0
    )
  );
  assert.ok(
    events.some((event) => event.type === "authentication-terminal-resolved")
  );
});

test("terminal authentication preserves the agent's failure reason", async () => {
  const events = [];

  await assert.rejects(
    runAuthenticationTerminal({
      sessionId: "auth-terminal-failure-test",
      agentName: "Mock Agent",
      method: {
        id: "terminal-login",
        name: "Terminal Login",
        type: "terminal"
      },
      command: {
        bin: process.execPath,
        args: [
          "-e",
          "process.stdout.write('Opening login...\\r\\n\\u001b[31mLogin failed: membership is inactive.\\u001b[0m\\r\\n'); process.exit(1);"
        ],
        env: process.env
      },
      emit(event) {
        events.push(event);
      }
    }),
    /Authentication terminal exited with code 1\. Login failed: membership is inactive\./
  );

  assert.ok(
    events.some(
      (event) =>
        event.type === "authentication-terminal-update" &&
        event.running === false &&
        event.exitCode === 1
    )
  );
});

test("packaging keeps node-pty and its spawn helper outside asar", () => {
  const builder = fs.readFileSync(
    new URL("../electron-builder.yml", import.meta.url),
    "utf8"
  );
  const scripts = fs.readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8"
  );
  assert.match(builder, /node_modules\/node-pty\/\*\*\/\*/);
  assert.match(scripts, /fix-node-pty-permissions\.mjs/);
});
