import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("usage is a first-class workspace directly after teams", () => {
  const app = read("../src/App.tsx");
  const sidebar = read("../src/components/CLI/SidebarNavigation.tsx");

  assert.match(sidebar, /WorkspaceView = [^;]*"usage"/);
  assert.match(sidebar, /const usageActive = workspaceView === "usage"/);
  assert.match(sidebar, /aria-current=\{usageActive \? "page" : undefined\}/);
  assert.match(
    sidebar,
    /<UsersRound \/>[\s\S]*?sidebar\.teams[\s\S]*?<ChartNoAxesCombined \/>[\s\S]*?sidebar\.usage/
  );
  assert.match(app, /onOpenUsage=\{openUsage\}/);
  assert.match(app, /setWorkspaceView\("usage"\)/);
  assert.match(app, /workspaceView === "usage"/);
  assert.match(app, /<AgentUsagePage \/>/);
});

test("usage page reads cached totals, refreshes, and supports agent filtering", () => {
  const page = read("../src/components/Usage/AgentUsagePage.tsx");

  assert.match(page, /cliClient\.usageSummary\(targetPeriod\)/);
  assert.match(page, /cliClient\.refreshUsage\(targetPeriod\)/);
  assert.match(page, /USAGE_PERIODS\.map/);
  assert.match(page, /setPeriod\(value\)/);
  assert.match(page, /summary\.usageSessionCount/);
  assert.match(page, /summary\?\.scan\?\.status !== "running"/);
  assert.match(page, /setSelectedAgentId/);
  assert.match(page, /aria-pressed=\{selectedAgentId === agent\.agentId\}/);
  assert.match(page, /summary\.coverageGaps\.map/);
  assert.match(page, /summary\.ambiguousSessionCount/);
  assert.match(page, /<table className="usage-table">/);
  assert.match(page, /<progress/);
});

test("usage period crosses the renderer and Electron bridge", () => {
  const client = read("../src/services/cli/client.ts");
  const preload = read("../electron/preload.ts");
  const ipc = read("../electron/cli/ipc.ts");
  const types = read("../src/types/freebuddy.d.ts");

  assert.match(client, /usageSummary\(period: AgentUsagePeriod = "all"\)/);
  assert.match(client, /refreshUsage\(period: AgentUsagePeriod = "all"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("cli:usageSummary", period\)/);
  assert.match(preload, /ipcRenderer\.invoke\("cli:refreshUsage", period\)/);
  assert.match(ipc, /normalizeAgentUsagePeriod\(rawPeriod\)/);
  assert.match(ipc, /reconcileAgentUsage\(period\)/);
  assert.match(types, /usageSummary\(period\?: AgentUsagePeriod\)/);
});

test("usage page has localized copy and responsive product styles", () => {
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  const styles = read("../styles.css");
  const required = [
    "title",
    "description",
    "totalTokens",
    "byAgent",
    "byModel",
    "coverage",
    "methodNote"
  ];

  assert.equal(en.sidebar.usage, "Usage");
  assert.equal(zh.sidebar.usage, "用量统计");
  assert.deepEqual(Object.keys(en.usage.period), ["label", "today", "week", "month", "year", "all"]);
  assert.deepEqual(Object.keys(zh.usage.period), ["label", "today", "week", "month", "year", "all"]);
  for (const key of required) {
    assert.ok(en.usage?.[key], `missing en.usage.${key}`);
    assert.ok(zh.usage?.[key], `missing zh-CN.usage.${key}`);
  }
  assert.match(styles, /\.usage-metric-grid\s*\{/);
  assert.match(styles, /\.usage-period-picker\s*\{/);
  assert.match(styles, /\.usage-overview-grid\s*\{/);
  assert.match(styles, /\.usage-table-wrap\s*\{/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /\.usage-agent-row:focus-visible/);
});
