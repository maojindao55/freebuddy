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

test("workspace panel does not auto-refresh Codex limit status", () => {
  assert.equal(source.includes("cliClient.codexStatus"), false);
  assert.equal(source.includes("codex-limits-card"), false);
  assert.equal(source.includes("workspace.codexLimits"), false);
  assert.equal(styles.includes("codex-limit-track"), false);
  assert.equal(styles.includes("codex-limit-fill"), false);
});

test("workspace panel no longer renders the execution queue card", () => {
  assert.equal(source.includes("run-queue-card"), false);
  assert.equal(source.includes("workspace.executionQueue"), false);
});
