import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

test("summarizeDelegateOutput joins assistant text items", async () => {
  const { summarizeDelegateOutput } = await import("../dist-electron/cli/delegationRunner.js");
  const items = [
    { kind: "text", role: "assistant", content: "hello " },
    { kind: "thinking", content: "internal" },
    { kind: "text", role: "assistant", content: "world" },
    { kind: "text", role: "user", content: "ignored task echo" },
    { kind: "tool-call", tool: "shell" }
  ];
  assert.equal(summarizeDelegateOutput(items), "hello world");
});

test("summarizeDelegateOutput does not treat tool activity as completed output", async () => {
  const { summarizeDelegateOutput } = await import("../dist-electron/cli/delegationRunner.js");
  assert.match(summarizeDelegateOutput([{ kind: "tool-call", tool: "x" }, { kind: "tool-call", tool: "y" }]), /no assistant response or artifact/i);
  assert.ok(summarizeDelegateOutput([]).length > 0);
  // user-only text is NOT treated as output
  assert.match(summarizeDelegateOutput([{ kind: "text", role: "user", content: "task" }]), /no assistant response or artifact/i);
});

test("delegation output evidence preserves a nested tool failure diagnostic", async () => {
  const { analyzeDelegationOutput } = await import("@freebuddy/delegation-core");
  const evidence = analyzeDelegationOutput([
    {
      kind: "tool-call",
      tool: "skill_load",
      status: "completed",
      toolOutputs: [
        {
          kind: "tool-result",
          tool: "skill_load",
          isError: true,
          content: "Skill is not active: hyperframes"
        }
      ]
    }
  ]);
  assert.equal(evidence.hasOutput, false);
  assert.match(evidence.toolError, /Skill is not active: hyperframes/);
  assert.doesNotMatch(evidence.summary, /Completed/);
});

test("file edits count as artifact output even without assistant text", async () => {
  const { analyzeDelegationOutput } = await import("@freebuddy/delegation-core");
  const evidence = analyzeDelegationOutput([
    { kind: "file-edit", path: "src/a.ts", action: "update" }
  ]);
  assert.equal(evidence.hasOutput, true);
  assert.equal(evidence.hasArtifactOutput, true);
});

test("silent team turns fail while upstream errors remain unchanged", async () => {
  const { EMPTY_AGENT_OUTPUT_ERROR, resolveAgentRunError } = await import(
    "../packages/agent-runtime/dist/index.js"
  );
  assert.equal(resolveAgentRunError([], null, 0), EMPTY_AGENT_OUTPUT_ERROR);
  assert.equal(
    resolveAgentRunError(
      [{ kind: "text", role: "user", content: "echoed prompt" }],
      null,
      0
    ),
    EMPTY_AGENT_OUTPUT_ERROR
  );
  assert.equal(
    resolveAgentRunError([], "Internal error: turn failed: rpm exhausted", -1),
    "Internal error: turn failed: rpm exhausted"
  );
  assert.equal(resolveAgentRunError([], null, 9), "Agent exited with code 9.");
  assert.equal(
    resolveAgentRunError(
      [{ kind: "text", role: "assistant", content: "done" }],
      null,
      0
    ),
    null
  );
  assert.equal(resolveAgentRunError([{ kind: "tool-call", tool: "read" }], null, 0), null);
});

test("summarizeDelegateOutput truncates very long assistant text", async () => {
  const { summarizeDelegateOutput } = await import("../dist-electron/cli/delegationRunner.js");
  const out = summarizeDelegateOutput([{ kind: "text", role: "assistant", content: "x".repeat(50_000) }]);
  assert.ok(out.length < 50_000);
  assert.match(out, /truncated/);
});
