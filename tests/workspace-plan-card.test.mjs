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

test("workspace panel no longer renders the execution queue card", () => {
  assert.equal(source.includes("run-queue-card"), false);
  assert.equal(source.includes("workspace.executionQueue"), false);
});
