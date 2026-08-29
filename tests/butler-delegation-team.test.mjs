import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { normalizeButlerDelegationTeamInput } from "../dist-electron/cli/butlerDelegationTeams.js";

const agents = [
  { id: "cli-butlerbuddy", enabled: true },
  { id: "cli-codex-acp", enabled: true },
  { id: "cli-disabled", enabled: false }
];

function validInput() {
  return {
    name: "Delivery crew",
    description: "Plans and reviews a delivery task.",
    sharedInstructions: "Do not report completion without an artifact.",
    enabled: true,
    entryRoleId: "lead",
    roster: [
      {
        id: "lead",
        label: "Lead",
        agentId: "cli-butlerbuddy",
        capability: "Route tasks and integrate results.",
        instructions: "Delegate specialist work and verify the returned evidence.",
        canWrite: false,
        skillIds: ["butlerbuddy", "butlerbuddy"]
      },
      {
        id: "builder",
        label: "Builder",
        agentId: "cli-codex-acp",
        capability: "Implement scoped code changes.",
        instructions: "Return changed files and test output.",
        canWrite: true,
        skillIds: []
      }
    ],
    policy: {
      allowWrites: true,
      requireApprovalBeforeDelegateWrite: true,
      maxDepth: 4,
      delegateTimeoutMinutes: 20,
      maxConcurrentDelegates: 2,
      stopOnDelegateFailure: true
    }
  };
}

test("Butler normalizes a complete self-organizing team contract", () => {
  const result = normalizeButlerDelegationTeamInput(validInput(), agents);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.input.entryRoleId, "lead");
  assert.equal(
    result.input.sharedInstructions,
    "Do not report completion without an artifact."
  );
  assert.equal(result.input.roster[0]?.capability, "Route tasks and integrate results.");
  assert.equal(
    result.input.roster[0]?.instructions,
    "Delegate specialist work and verify the returned evidence."
  );
  assert.deepEqual(result.input.roster[0]?.skillIds, ["butlerbuddy"]);
  assert.equal(result.input.policy.delegateTimeoutMs, 20 * 60_000);
  assert.equal(result.input.policy.maxConcurrentDelegates, 2);
});

test("Butler rejects invalid self-organizing team references and permissions", () => {
  const duplicate = validInput();
  duplicate.roster[1].id = "lead";
  assert.deepEqual(normalizeButlerDelegationTeamInput(duplicate, agents), {
    ok: false,
    error: "Duplicate role id: lead."
  });

  const missingEntry = validInput();
  missingEntry.entryRoleId = "missing";
  assert.equal(normalizeButlerDelegationTeamInput(missingEntry, agents).ok, false);

  const disabledAgent = validInput();
  disabledAgent.roster[1].agentId = "cli-disabled";
  assert.equal(normalizeButlerDelegationTeamInput(disabledAgent, agents).ok, false);

  const forbiddenWrite = validInput();
  forbiddenWrite.policy.allowWrites = false;
  assert.deepEqual(normalizeButlerDelegationTeamInput(forbiddenWrite, agents), {
    ok: false,
    error: "Writable roles require policy.allowWrites to be true."
  });
});

test("Butler MCP and core skill expose the self-organizing team tools", () => {
  const mcp = fs.readFileSync(
    new URL("../electron/mcp/butlerMcpServer.ts", import.meta.url),
    "utf8"
  );
  const service = fs.readFileSync(
    new URL("../electron/butlerToolService.ts", import.meta.url),
    "utf8"
  );
  const skill = fs.readFileSync(
    new URL("../assets/skills/butlerbuddy/SKILL.md", import.meta.url),
    "utf8"
  );

  for (const tool of [
    "freebuddy_delegation_team_list",
    "freebuddy_delegation_team_get",
    "freebuddy_delegation_team_create"
  ]) {
    assert.match(mcp, new RegExp(tool));
    assert.match(skill, new RegExp(tool));
  }
  assert.match(service, /normalizeButlerDelegationTeamInput\(params, agents\)/);
  assert.match(service, /insertDelegationTeam\(input\)/);
  assert.match(skill, /Role capability.*routing metadata/);
  assert.match(skill, /Role execution instructions.*mandatory behavior/);
});
