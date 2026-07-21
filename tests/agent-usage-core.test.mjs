import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTokscaleDailyUsageArgs,
  buildTokscaleHourlyUsageArgs,
  buildTokscaleUsageArgs,
  normalizeAgentUsagePeriod,
  normalizeUsageSessionKey,
  parseTokscaleDailyUsageReport,
  parseTokscaleHourlyUsageReport,
  parseTokscaleUsageReport,
  tokscalePeriodArgs,
  tokscaleClientForAdapter
} from "../dist-electron/cli/usageCore.js";

test("usage adapter mapping only includes session-attributable tokscale clients", () => {
  assert.equal(tokscaleClientForAdapter("codex-acp"), "codex");
  assert.equal(tokscaleClientForAdapter("custom", "claude-agent-acp"), "claude");
  assert.equal(tokscaleClientForAdapter("grok-acp"), "grok");
  assert.equal(tokscaleClientForAdapter("cursor-agent-acp"), undefined);
  assert.equal(tokscaleClientForAdapter("qoder-acp"), undefined);
});

test("Codex rollout filenames and ACP UUIDs normalize to the same session key", () => {
  const uuid = "019f1048-c7e7-78d3-8ec6-a9e6b5c48ac4";
  assert.equal(normalizeUsageSessionKey("codex", uuid), uuid);
  assert.equal(
    normalizeUsageSessionKey(
      "codex",
      `rollout-2026-06-29T06-10-33-${uuid}`
    ),
    uuid
  );
  assert.equal(
    normalizeUsageSessionKey("opencode", "ses_08ae1ad2fffec4ut3jvMgqT9Yx"),
    "ses_08ae1ad2fffec4ut3jvMgqT9Yx"
  );
});

test("tokscale JSON keeps Cursor for the explicit unattributed usage bucket", () => {
  const report = parseTokscaleUsageReport(`notice before json
    {
      "entries": [
        {
          "client": "codex",
          "sessionId": "rollout-date-019f1048-c7e7-78d3-8ec6-a9e6b5c48ac4",
          "model": "gpt-5.5",
          "provider": "openai",
          "input": 12.9,
          "output": 5,
          "cacheRead": 100,
          "cacheWrite": -2,
          "reasoning": 3,
          "messageCount": 2,
          "cost": 0.25
        },
        {
          "client": "cursor",
          "sessionId": "cursor-account-day",
          "model": "auto",
          "input": 999
        }
      ],
      "processingTimeMs": 7
    }`);

  assert.equal(report.entries.length, 2);
  assert.deepEqual(report.entries[0], {
    client: "codex",
    sessionId: "rollout-date-019f1048-c7e7-78d3-8ec6-a9e6b5c48ac4",
    sessionKey: "019f1048-c7e7-78d3-8ec6-a9e6b5c48ac4",
    modelId: "gpt-5.5",
    providerId: "openai",
    inputTokens: 12,
    outputTokens: 5,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    reasoningTokens: 3,
    messageCount: 2,
    estimatedCostUsd: 0.25
  });
  assert.deepEqual(report.entries[1], {
    client: "cursor",
    sessionId: "cursor-account-day",
    sessionKey: "cursor-account-day",
    modelId: "auto",
    providerId: "",
    inputTokens: 999,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    messageCount: 0,
    estimatedCostUsd: 0
  });
  assert.equal(report.processingTimeMs, 7);
});

test("tokscale scan groups by client, session and model", () => {
  assert.deepEqual(buildTokscaleUsageArgs(["grok", "codex", "codex"]), [
    "models",
    "--json",
    "--no-spinner",
    "--client",
    "codex,grok",
    "--group-by",
    "client,session,model"
  ]);
});

test("tokscale graph parses and aggregates daily usage by client", () => {
  const report = parseTokscaleDailyUsageReport(JSON.stringify({
    contributions: [
      {
        date: "2026-07-20",
        clients: [
          {
            client: "codex",
            tokens: { input: 10, output: 2, cacheRead: 20, reasoning: 1 },
            messages: 3
          },
          {
            client: "codex",
            tokens: { input: 5, output: 1, cacheWrite: 4 },
            messages: 1
          },
          {
            client: "unsupported",
            tokens: { input: 999 },
            messages: 9
          }
        ]
      }
    ]
  }));

  assert.deepEqual(report.entries, [{
    date: "2026-07-20",
    client: "codex",
    inputTokens: 15,
    outputTokens: 3,
    cacheReadTokens: 20,
    cacheWriteTokens: 4,
    reasoningTokens: 1,
    messageCount: 4
  }]);
  assert.deepEqual(
    buildTokscaleDailyUsageArgs(
      ["cursor", "codex", "codex"],
      "week",
      new Date(2026, 6, 21, 12, 0, 0)
    ),
    ["graph", "--client", "codex,cursor", "--week", "--no-spinner"]
  );
});

test("tokscale hourly report supports the adaptive today trend", () => {
  const report = parseTokscaleHourlyUsageReport(JSON.stringify({
    entries: [
      {
        hour: "2026-07-21 05:00",
        input: 10,
        output: 2,
        cacheRead: 20,
        cacheWrite: 4,
        messageCount: 3
      },
      { hour: "invalid", input: 999 }
    ]
  }));
  assert.deepEqual(report.entries, [{
    hour: "2026-07-21 05:00",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 20,
    cacheWriteTokens: 4,
    messageCount: 3
  }]);
  assert.deepEqual(buildTokscaleHourlyUsageArgs(["cursor", "codex", "codex"]), [
    "hourly",
    "--json",
    "--client",
    "codex,cursor",
    "--today",
    "--no-spinner"
  ]);
});

test("tokscale period filters use rolling local-date windows", () => {
  const now = new Date(2026, 6, 19, 12, 0, 0);
  assert.deepEqual(tokscalePeriodArgs("today", now), ["--today"]);
  assert.deepEqual(tokscalePeriodArgs("week", now), ["--week"]);
  assert.deepEqual(tokscalePeriodArgs("month", now), [
    "--since",
    "2026-06-20",
    "--until",
    "2026-07-19"
  ]);
  assert.deepEqual(tokscalePeriodArgs("year", now), [
    "--since",
    "2025-07-20",
    "--until",
    "2026-07-19"
  ]);
  assert.deepEqual(tokscalePeriodArgs("all", now), []);
  assert.equal(normalizeAgentUsagePeriod("month"), "month");
  assert.equal(normalizeAgentUsagePeriod("invalid"), "all");
});

test("tokscale keeps session attribution when a period is selected", () => {
  assert.deepEqual(
    buildTokscaleUsageArgs(
      ["codex"],
      "month",
      new Date(2026, 6, 19, 12, 0, 0)
    ),
    [
      "models",
      "--json",
      "--no-spinner",
      "--client",
      "codex",
      "--since",
      "2026-06-20",
      "--until",
      "2026-07-19",
      "--group-by",
      "client,session,model"
    ]
  );
});
