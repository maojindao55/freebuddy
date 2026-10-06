import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadModule() {
  const source = fs.readFileSync(
    new URL("../src/utils/agentAvailability.ts", import.meta.url),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
}

const member = (id, name, enabled = true) => ({
  id: `cli-${id}`,
  kind: "cli",
  name,
  source: "builtin",
  enabled,
  cli: { adapter: id, approvalMode: "auto" }
});

const runtime = (adapter, installed, overrides = {}) => ({
  adapter,
  installed,
  lastCheckAt: "2026-07-17T01:00:00.000Z",
  updatedAt: "2026-07-17T01:00:00.000Z",
  ...overrides
});

test("groups agents by cached runtime availability and hides disabled entries", async () => {
  const { buildAgentAvailabilityGroups } = await loadModule();
  const groups = buildAgentAvailabilityGroups(
    [
      member("codex-acp", "Codex"),
      member("claude-agent-acp", "ClaudeCode"),
      member("opencode-acp", "OpenCode"),
      member("disabled", "Disabled", false)
    ],
    {
      "codex-acp": runtime("codex-acp", true),
      "opencode-acp": runtime("opencode-acp", false)
    },
    Date.parse("2026-07-17T02:00:00.000Z")
  );

  assert.deepEqual(groups.available.map((entry) => entry.member.name), ["Codex"]);
  assert.deepEqual(groups.checking.map((entry) => entry.member.name), ["ClaudeCode"]);
  assert.deepEqual(groups.unavailable.map((entry) => entry.member.name), ["OpenCode"]);
});

test("sorts available agents by most recent successful use", async () => {
  const { buildAgentAvailabilityGroups } = await loadModule();
  const groups = buildAgentAvailabilityGroups(
    [member("codex-acp", "Codex"), member("claude-agent-acp", "ClaudeCode")],
    {
      "codex-acp": runtime("codex-acp", true, {
        lastRunAt: "2026-07-17T01:10:00.000Z"
      }),
      "claude-agent-acp": runtime("claude-agent-acp", true, {
        lastRunAt: "2026-07-17T01:30:00.000Z"
      })
    },
    Date.parse("2026-07-17T02:00:00.000Z")
  );

  assert.deepEqual(groups.available.map((entry) => entry.member.name), [
    "ClaudeCode",
    "Codex"
  ]);
});

test("new tasks prefer the last selected member over another agent's newer runtime", async () => {
  const { buildAgentAvailabilityGroups, preferredAvailableAgentId } = await loadModule();
  const groups = buildAgentAvailabilityGroups(
    [member("codex-acp", "Codex"), member("claude-agent-acp", "ClaudeCode")],
    {
      "codex-acp": runtime("codex-acp", true, { lastRunAt: "2026-07-17T01:30:00.000Z" }),
      "claude-agent-acp": runtime("claude-agent-acp", true, { lastRunAt: "2026-07-17T01:10:00.000Z" })
    }
  );
  assert.equal(preferredAvailableAgentId(groups, "cli-claude-agent-acp"), "cli-claude-agent-acp");
  assert.equal(preferredAvailableAgentId(groups), "cli-codex-acp");
});

test("a missing, disabled or uninstalled preference falls back to an available agent", async () => {
  const { buildAgentAvailabilityGroups, preferredAvailableAgentId } = await loadModule();
  const groups = buildAgentAvailabilityGroups(
    [member("codex-acp", "Codex"), member("disabled", "Disabled", false), member("missing", "Missing")],
    { "codex-acp": runtime("codex-acp", true), missing: runtime("missing", false) }
  );
  for (const id of ["cli-removed", "cli-disabled", "cli-missing"]) {
    assert.equal(preferredAvailableAgentId(groups, id), "cli-codex-acp");
  }
  assert.equal(preferredAvailableAgentId({ available: [], checking: [], unavailable: [] }, "cli-codex-acp"), "");
});

test("a remembered member is restored when detection finishes, including cloned agents", async () => {
  const { buildAgentAvailabilityGroups, preferredAvailableAgentId } = await loadModule();
  const clone = { ...member("codex-clone", "Codex Clone"), cli: { adapter: "codex-acp" }, runtimeKey: "codex-clone" };
  const members = [member("codex-acp", "Codex"), clone];
  const runtimes = { "codex-acp": runtime("codex-acp", true) };
  assert.equal(preferredAvailableAgentId(buildAgentAvailabilityGroups(members, runtimes), clone.id), "cli-codex-acp");
  runtimes["codex-clone"] = runtime("codex-clone", true);
  assert.equal(preferredAvailableAgentId(buildAgentAvailabilityGroups(members, runtimes), clone.id), clone.id);
});

test("refreshes unknown and stale agents without hiding stale installed agents", async () => {
  const { agentEntriesNeedingRefresh, buildAgentAvailabilityGroups } =
    await loadModule();
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  const groups = buildAgentAvailabilityGroups(
    [member("codex-acp", "Codex"), member("claude-agent-acp", "ClaudeCode")],
    {
      "codex-acp": runtime("codex-acp", true, {
        lastCheckAt: "2026-07-16T01:00:00.000Z"
      })
    },
    now
  );

  assert.deepEqual(groups.available.map((entry) => entry.member.name), ["Codex"]);
  assert.deepEqual(
    agentEntriesNeedingRefresh(groups).map((entry) => entry.member.name).sort(),
    ["ClaudeCode", "Codex"]
  );
});

test("initial and manual detection retries fresh cached misses", async () => {
  const {
    agentEntriesNeedingDetection,
    agentEntriesNeedingRefresh,
    buildAgentAvailabilityGroups
  } = await loadModule();
  const now = Date.parse("2026-07-17T02:00:00.000Z");
  const groups = buildAgentAvailabilityGroups(
    [member("codex-acp", "Codex"), member("agy-acp", "Antigravity")],
    {
      "codex-acp": runtime("codex-acp", false),
      "agy-acp": runtime("agy-acp", true)
    },
    now
  );

  assert.deepEqual(
    agentEntriesNeedingRefresh(groups).map((entry) => entry.member.name),
    []
  );
  assert.deepEqual(
    agentEntriesNeedingDetection(groups).map((entry) => entry.member.name),
    ["Codex"]
  );
});
