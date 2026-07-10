import assert from "node:assert/strict";
import test from "node:test";

import {
  categorizeTelemetryError,
  normalizeTelemetryAdapter,
  telemetryDurationMs
} from "../dist-electron/telemetryPrivacy.js";

test("telemetry adapter values are bounded", () => {
  assert.equal(normalizeTelemetryAdapter("codex-acp"), "codex-acp");
  assert.equal(normalizeTelemetryAdapter("private-agent-name"), "custom");
  assert.equal(normalizeTelemetryAdapter(), "custom");
});

test("telemetry errors are reduced to safe categories", () => {
  assert.equal(categorizeTelemetryError("spawn ENOENT /private/path"), "binary_not_found");
  assert.equal(categorizeTelemetryError("401 invalid API key: secret"), "authentication_failed");
  assert.equal(categorizeTelemetryError("request timeout at internal host"), "network_error");
  assert.equal(categorizeTelemetryError("private uncategorized details"), "unknown");
});

test("telemetry duration is non-negative and tolerates invalid dates", () => {
  assert.equal(telemetryDurationMs("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:00:01.250Z")), 1250);
  assert.equal(telemetryDurationMs("invalid", 1000), 0);
  assert.equal(telemetryDurationMs("2026-01-01T00:00:02.000Z", Date.parse("2026-01-01T00:00:01.000Z")), 0);
});
