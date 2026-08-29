import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";

test("roster prompt lists teammates minus self with depth", async () => {
  const { buildDelegationRosterPrompt } = await import("../dist-electron/cli/delegationPrompt.js");
  const roster = [
    { id: "r-impl", label: "实现", agentId: "a", capability: "写代码", canWrite: true },
    { id: "r-rev", label: "评审", agentId: "b", capability: "审代码", canWrite: false }
  ];
  const p = buildDelegationRosterPrompt(roster, "r-impl", 1, 3);
  assert.match(p, /当前深度 1 \/ 上限 3/);
  assert.match(p, /\[r-rev\]/);
  assert.doesNotMatch(p, /\[r-impl\]/);
  assert.match(p, /只读|可写/);
});

test("task prompt wraps the task with the roster header", async () => {
  const { buildDelegateTaskPrompt } = await import("../dist-electron/cli/delegationPrompt.js");
  const roster = [{ id: "r-x", label: "X", agentId: "a", capability: "do x", canWrite: false }];
  const p = buildDelegateTaskPrompt("审 auth", roster, "r-x", 2, 3);
  assert.match(p, /审 auth/);
  assert.match(p, /协作团队/);
});

test("task and wake prompts separate routing capability from execution instructions", async () => {
  const { buildDelegateTaskPrompt, buildDelegateWakePrompt } = await import(
    "../dist-electron/cli/delegationPrompt.js"
  );
  const roster = [
    {
      id: "r-lead",
      label: "总编导",
      agentId: "a",
      capability: "用于别人判断是否委派的视频统筹能力",
      instructions: "收到任务后直接执行；不得只复述计划或等待用户说开始。",
      canWrite: true
    },
    {
      id: "r-review",
      label: "审核员",
      agentId: "b",
      capability: "审核视频和图像",
      instructions: "必须给出逐项审核结论。",
      canWrite: false
    }
  ];
  const context = {
    sharedInstructions: "交付前必须产生可验证产物并汇总结果。",
    roleInstructions: roster[0].instructions,
    selfLabel: roster[0].label
  };
  const task = buildDelegateTaskPrompt("制作宣传片", roster, "r-lead", 0, 3, context);
  assert.match(task, /团队共享指令/);
  assert.match(task, /可验证产物/);
  assert.match(task, /角色自身执行指令/);
  assert.match(task, /不得只复述计划/);
  assert.doesNotMatch(task, /用于别人判断是否委派的视频统筹能力/);
  assert.match(task, /审核视频和图像/);

  const wake = buildDelegateWakePrompt(
    { taskText: "审核", roleLabel: "审核员", status: "done", resultSummary: "通过", verdict: "pass" },
    roster,
    "r-lead",
    0,
    3,
    context
  );
  assert.match(wake, /可验证产物/);
  assert.match(wake, /不得只复述计划/);
});
