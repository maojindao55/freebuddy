import test from "node:test";
import assert from "node:assert/strict";

const roster = [
  {
    id: "role-coord",
    label: "总协调与集成",
    agentId: "cli-codex-acp",
    capability: "协调",
    canWrite: false
  },
  {
    id: "role-host",
    label: "ELECTRON HOST 负责人",
    agentId: "cli-codex-acp",
    capability: "桌面宿主",
    canWrite: true
  },
  {
    id: "role-protocol",
    label: "协议负责人",
    agentId: "cli-cursor-acp",
    capability: "协议",
    canWrite: false
  }
];

function event(overrides) {
  return {
    id: "evt",
    runId: "run-1",
    parentEventId: null,
    agentId: "cli-codex-acp",
    agentName: "Codex",
    roleLabel: "总协调与集成",
    taskText: "work",
    depth: 0,
    status: "done",
    resultSummary: null,
    result: null,
    canWrite: false,
    acceptedAt: null,
    startedAt: null,
    endedAt: null,
    verdict: null,
    verdictSummary: null,
    ...overrides
  };
}

async function load() {
  return import("../packages/delegation-core/dist/index.js");
}

test("shared CLI adapter: only the running child role is live, not sibling roles", async () => {
  const { resolveActiveDelegationRoleId, eventsForRosterRole } = await load();
  const events = [
    event({
      id: "e-coord",
      roleLabel: "总协调与集成",
      status: "done",
      depth: 0
    }),
    event({
      id: "e-host",
      roleLabel: "ELECTRON HOST 负责人",
      status: "running",
      depth: 1,
      canWrite: true
    })
  ];

  const activeRoleId = resolveActiveDelegationRoleId({
    roster,
    entryRoleId: "role-coord",
    events,
    runStatus: "running"
  });

  assert.equal(activeRoleId, "role-host");
  assert.deepEqual(
    eventsForRosterRole(events, roster.find((r) => r.id === "role-coord"), roster).map(
      (row) => row.id
    ),
    ["e-coord"]
  );
  assert.deepEqual(
    eventsForRosterRole(events, roster.find((r) => r.id === "role-host"), roster).map(
      (row) => row.id
    ),
    ["e-host"]
  );
});

test("shared CLI adapter: a live entry turn does not mark idle sibling roles running", async () => {
  const { resolveActiveDelegationRoleId } = await load();
  const events = [
    event({
      id: "e-coord",
      roleLabel: "总协调与集成",
      status: "running",
      depth: 0
    }),
    event({
      id: "e-host",
      roleLabel: "ELECTRON HOST 负责人",
      status: "done",
      depth: 1,
      canWrite: true
    })
  ];

  const activeRoleId = resolveActiveDelegationRoleId({
    roster,
    entryRoleId: "role-coord",
    events,
    runStatus: "running",
    liveStatus: "running"
  });

  assert.equal(activeRoleId, "role-coord");
});

test("shared CLI adapter: completed sibling keeps its own done events", async () => {
  const { resolveActiveDelegationRoleId, eventsForRosterRole } = await load();
  const events = [
    event({
      id: "e-host",
      roleLabel: "ELECTRON HOST 负责人",
      status: "done",
      depth: 1,
      canWrite: true
    })
  ];

  const host = roster.find((r) => r.id === "role-host");
  const coord = roster.find((r) => r.id === "role-coord");
  assert.equal(eventsForRosterRole(events, host, roster).length, 1);
  assert.equal(eventsForRosterRole(events, coord, roster).length, 0);
  assert.equal(
    resolveActiveDelegationRoleId({
      roster,
      entryRoleId: "role-coord",
      events,
      runStatus: "completed"
    }),
    undefined
  );
});

test("distinct adapters still mark a running child and park the entry", async () => {
  const { resolveActiveDelegationRoleId } = await load();
  const activeRoleId = resolveActiveDelegationRoleId({
    roster,
    entryRoleId: "role-coord",
    events: [
      event({
        id: "e-proto",
        agentId: "cli-cursor-acp",
        agentName: "Cursor",
        roleLabel: "协议负责人",
        status: "running",
        depth: 1
      })
    ],
    runStatus: "running"
  });
  assert.equal(activeRoleId, "role-protocol");
});
