import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

const telemetry = read("../electron/telemetry.ts");
const ipc = read("../electron/cli/ipc.ts");
const runtime = read("../electron/cli/runtimeShared.ts");
const workflowRuntime = read("../electron/cli/workflowRuntime.ts");
const check = read("../electron/cli/check.ts");
const preload = read("../electron/preload.ts");
const client = read("../src/services/cli/client.ts");
const installStore = read("../src/store/cliInstallStore.ts");

test("telemetry declares the six privacy-safe product events", () => {
  for (const event of [
    "conversation_created",
    "agent_run_started",
    "agent_run_finished",
    "workflow_run_started",
    "workflow_run_finished",
    "agent_setup_completed"
  ]) {
    assert.match(telemetry, new RegExp(`"${event}"`));
  }
  assert.match(telemetry, /event_schema_version:\s*1/);
  assert.match(telemetry, /export function trackTelemetryEvent/);
});

test("conversation and agent run lifecycle use authoritative Electron events", () => {
  assert.match(ipc, /"conversation_created"/);
  assert.match(runtime, /"agent_run_started"/);
  assert.match(runtime, /"agent_run_finished"/);
  assert.match(runtime, /resumed_session/);
  assert.match(runtime, /attachment_count/);
  assert.match(runtime, /duration_ms/);
});

test("workflow lifecycle records bounded aggregate properties", () => {
  assert.match(workflowRuntime, /"workflow_run_started"/);
  assert.match(workflowRuntime, /"workflow_run_finished"/);
  assert.match(workflowRuntime, /team_source/);
  assert.match(workflowRuntime, /step_count/);
  assert.match(workflowRuntime, /agent_count/);
  assert.match(workflowRuntime, /loop_count/);
});

test("agent setup keeps adapter context across the install bridge", () => {
  assert.match(check, /"agent_setup_completed"/);
  assert.match(preload, /installStream:\s*\(\s*adapter:\s*string,\s*command:\s*string/);
  assert.match(client, /installStream\(\s*adapter:\s*string,\s*command:\s*string/);
  assert.match(installStore, /cliClient\.installStream\(adapterId,\s*command/);
  assert.match(ipc, /cliInstallStream\(\s*args\.command,[\s\S]*args\.adapter/);
});

test("product telemetry never forwards business content fields", () => {
  for (const source of [telemetry, runtime, workflowRuntime, check]) {
    assert.doesNotMatch(source, /trackTelemetryEvent\([\s\S]{0,500}\b(prompt|cwd|goal|summary|command|error_message):/);
  }
});
