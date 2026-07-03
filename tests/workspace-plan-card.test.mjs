import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("../src/components/CLI/WorkspacePanel.tsx", import.meta.url),
  "utf8"
);
const styles = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("workspace panel owns the ACP plan card in the third column", () => {
  assert.match(source, /latestPlanFromMessages/);
  assert.match(source, /className="side-card plan-card"/);
  assert.match(source, /workspace\.plan/);
  assert.match(source, /workspace\.planProgress/);
});

test("agent plan card scrolls internally when it has many entries", () => {
  assert.match(styles, /\.workspace-panel\s*\{[^}]*display:\s*flex/s);
  assert.match(styles, /\.workspace-panel\s*\{[^}]*min-height:\s*0/s);
  assert.match(styles, /\.plan-card\s*\{[^}]*flex:\s*1/s);
  assert.match(styles, /\.plan-card\s*\{[^}]*min-height:\s*0/s);
  assert.match(styles, /\.plan-list\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.plan-list\s*\{[^}]*flex:\s*1/s);
  assert.equal(/\.plan-list\s*\{[^}]*max-height:/s.test(styles), false);
});

test("session config card truncates values and scrolls when crowded", () => {
  assert.match(source, /session-config-scroll/);
  assert.match(source, /session-config-label" title=\{label\}/);
  assert.match(source, /<dd title=\{value\}>/);
  assert.match(styles, /\.session-config-scroll\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.session-config-scroll\s*\{[^}]*max-height:/s);
  assert.match(styles, /\.session-config-list dd\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(styles, /\.session-config-list \.session-config-label\s*\{[^}]*text-overflow:\s*ellipsis/s);
});

test("workspace panel renders the Codex usage card from the CLI bridge", () => {
  assert.match(source, /cliClient\.codexUsage\(\)/);
  assert.match(source, /className="side-card codex-usage-card"/);
  assert.match(source, /workspace\.codexUsage/);
  assert.match(source, /workspace\.codexUsageRefresh/);
  assert.match(source, /workspace\.codexUsageUnavailable/);
  assert.match(source, /workspace\.codexResetCredits/);
  assert.match(source, /workspace\.codexResetCreditsCount/);
  assert.match(source, /resetCreditsExpanded/);
  assert.match(source, /CodexResetCreditRow/);
  assert.match(styles, /\.codex-usage-card\s*\{/);
  assert.match(styles, /\.codex-limit-track\s*\{/);
  assert.match(styles, /\.codex-limit-fill\s*\{/);
  assert.match(styles, /\.codex-reset-credits\s*\{/);
  assert.match(styles, /\.codex-reset-credit-list\s*\{/);
  assert.match(styles, /\.codex-reset-credit-row\s*\{/);
});

test("Codex usage card is rendered after the primary workspace cards", () => {
  const codexCard = source.indexOf('className="side-card codex-usage-card"');
  const runState = source.indexOf('t("workspace.runState")');
  const configCard = source.indexOf('className="side-card session-config-card"');
  const planCard = source.indexOf('className="side-card plan-card"');

  assert.ok(codexCard > runState);
  assert.ok(codexCard > configCard);
  assert.ok(codexCard > planCard);
});

test("feed card is rendered last because it is a secondary workspace affordance", () => {
  const feedCard = source.lastIndexOf("<FeedCard />");
  const codexCard = source.indexOf('className="side-card codex-usage-card"');
  const runState = source.indexOf('t("workspace.runState")');
  const planCard = source.indexOf('className="side-card plan-card"');

  assert.ok(feedCard > runState);
  assert.ok(feedCard > planCard);
  assert.ok(feedCard > codexCard);
});

test("Codex usage bridge is exposed without leaking token fields to renderer types", () => {
  const preload = fs.readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../src/services/cli/client.ts", import.meta.url), "utf8");
  const types = fs.readFileSync(new URL("../src/types/freebuddy.d.ts", import.meta.url), "utf8");
  const cliTypes = fs.readFileSync(new URL("../src/services/cli/types.ts", import.meta.url), "utf8");

  assert.match(preload, /codexUsage:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("cli:codexUsage"\)/);
  assert.match(client, /codexUsage\(\): Promise<CodexUsageResult>/);
  assert.match(types, /codexUsage\(\): Promise<CodexUsageResult>/);
  assert.match(cliTypes, /export type CodexUsageResult/);
  assert.equal(cliTypes.includes("access_token"), false);
  assert.equal(cliTypes.includes("refresh_token"), false);
  assert.equal(cliTypes.includes("authorization"), false);
});

test("workspace panel no longer renders the execution queue card", () => {
  assert.equal(source.includes("run-queue-card"), false);
  assert.equal(source.includes("workspace.executionQueue"), false);
});
