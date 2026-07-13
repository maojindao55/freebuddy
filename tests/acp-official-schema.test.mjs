import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

import {
  buildAuthenticateRequest,
  buildInitializeRequest,
  buildLogoutRequest,
  buildSessionCancelNotification,
  buildSessionCloseRequest,
  buildSessionListRequest,
  buildSessionLoadRequest,
  buildSessionNewRequest,
  buildSessionPromptRequest,
  buildSessionResumeRequest,
  buildSessionSetConfigOptionRequest,
  buildTerminalOutputResponse
} from "../dist-electron/cli/acp.js";

const schema = JSON.parse(
  fs.readFileSync(
    new URL(
      "../node_modules/@agentclientprotocol/sdk/schema/schema.json",
      import.meta.url
    ),
    "utf8"
  )
);

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(schema, "acp-official");

function officialDefinition(name) {
  return ajv.compile({ $ref: `acp-official#/$defs/${name}` });
}

function assertValid(validate, value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}

test("FreeBuddy ACP requests validate against the official SDK schema", () => {
  const validateMessage = ajv.getSchema("acp-official");
  assert.ok(validateMessage);
  const messages = [
    buildInitializeRequest(1, "0.4.9-test"),
    buildAuthenticateRequest(2, "browser-login"),
    buildLogoutRequest(3),
    buildSessionNewRequest(4, "/tmp/project"),
    buildSessionLoadRequest(5, "session-1", "/tmp/project"),
    buildSessionResumeRequest(6, "session-1", "/tmp/project"),
    buildSessionPromptRequest(7, "session-1", "hello"),
    buildSessionCancelNotification("session-1"),
    buildSessionCloseRequest(8, "session-1"),
    buildSessionSetConfigOptionRequest(9, "session-1", "model", "fast"),
    buildSessionListRequest(10, "/tmp/project")
  ];
  for (const message of messages) assertValid(validateMessage, message);
});

test("initialize opts into terminal auth only with the implemented PTY flow", () => {
  const request = buildInitializeRequest(1, "0.4.9-test");
  assertValid(officialDefinition("InitializeRequest"), request.params);
  assert.equal(request.params.clientCapabilities?.auth?.terminal, true);
});

test("terminal/output response validates against the official SDK schema", () => {
  const response = buildTerminalOutputResponse({
    output: "tail",
    truncated: true,
    exited: true,
    exitCode: 0,
    signal: null
  });
  assertValid(officialDefinition("TerminalOutputResponse"), response);
});
