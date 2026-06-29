import test from "node:test";
import assert from "node:assert/strict";

test("business assignment planner groups enabled surfaces and creates dependencies", async () => {
  const { previewBusinessAssignment } = await import("../dist-electron/cli/businessAssignmentPlanner.js");
  const workspace = {
    id: "biz-membership",
    name: "Membership",
    surfaces: [
      {
        id: "server",
        name: "Server",
        kind: "server",
        repoPath: "/repo/server",
        defaultAgentId: "cli-codex-acp",
        allowedPaths: [],
        verifyCommands: ["npm test"],
        responsibilities: ["API", "database"],
        contractRole: "provider",
        enabled: true
      },
      {
        id: "client",
        name: "Client",
        kind: "client",
        repoPath: "/repo/client",
        defaultAgentId: "cli-claude-agent-acp",
        allowedPaths: ["src"],
        verifyCommands: ["npm run build"],
        responsibilities: ["UI", "API consumption"],
        contractRole: "consumer",
        enabled: true
      }
    ],
    policy: {
      requireAssignmentApproval: true,
      requireCommitApproval: true,
      blockCommitOnVerificationFailure: true,
      requireCleanRepoBeforeRun: true,
      branchNameTemplate: "fb/{{runSlug}}/{{surfaceKey}}"
    },
    createdAt: "",
    updatedAt: ""
  };
  const result = previewBusinessAssignment(workspace, "add member discount");
  assert.equal(result.ok, true);
  assert.equal(result.assignmentPlan.surfaces.length, 2);
  assert.equal(result.assignmentPlan.needsContractDraft, true);
  assert.deepEqual(result.contractDraft.providerSurfaceIds, ["server"]);
  assert.deepEqual(result.contractDraft.consumerSurfaceIds, ["client"]);
  assert.deepEqual(result.assignmentPlan.surfaces.find((s) => s.surfaceId === "client").dependsOnSurfaceIds, ["server"]);
});
