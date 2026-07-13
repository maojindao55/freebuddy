import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  runAuthenticationTerminal,
  writeAuthenticationTerminal
} from "../dist-electron/cli/acpAuthTerminal.js";

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
