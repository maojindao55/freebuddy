import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadWhipMotion() {
  const source = fs.readFileSync(
    new URL("../src/utils/whipMotion.ts", import.meta.url),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("computeWhipFrame starts at the rest shape before any wave arrives", async () => {
  const { computeWhipFrame, WHIP_ATTACH_POINT } = await loadWhipMotion();
  const frame = computeWhipFrame(0);
  assert.ok(frame.ropeD.startsWith(`M${WHIP_ATTACH_POINT.x} ${WHIP_ATTACH_POINT.y}`));
  assert.ok(Number.isFinite(frame.tipX));
  assert.ok(Number.isFinite(frame.tipY));
  // At t=0 no joint's wave has arrived yet, so the tip sits at the rest
  // bezier's endpoint (96, 230).
  assert.ok(Math.abs(frame.tipX - 96) < 1);
  assert.ok(Math.abs(frame.tipY - 230) < 1);
});

test("computeWhipFrame produces continuous motion as the wave travels", async () => {
  const { computeWhipFrame } = await loadWhipMotion();
  const rest = computeWhipFrame(0);
  const mid = computeWhipFrame(400);
  const nearCrack = computeWhipFrame(1050);
  // Upstream joints have already started bending well before the wave
  // reaches the tip itself, so the tip position visibly moves early too.
  assert.notEqual(mid.tipX.toFixed(3), rest.tipX.toFixed(3));
  assert.notEqual(mid.tipY.toFixed(3), rest.tipY.toFixed(3));
  assert.notEqual(nearCrack.ropeD, rest.ropeD);
  assert.notEqual(nearCrack.ropeD, mid.ropeD);
});

test("computeWhipFrame respects a custom crackAtMs", async () => {
  const { computeWhipFrame, DEFAULT_CRACK_AT_MS } = await loadWhipMotion();
  assert.equal(DEFAULT_CRACK_AT_MS, 1050);
  const withDefault = computeWhipFrame(300);
  const withCustom = computeWhipFrame(300, 5000);
  // A much later crackAtMs means the wave hasn't reached most joints yet
  // at t=300ms, so the shape should differ from the default timing.
  assert.notEqual(withDefault.ropeD, withCustom.ropeD);
});

test("computeWhipFrame stays finite across the full effect duration", async () => {
  const { computeWhipFrame } = await loadWhipMotion();
  for (let t = 0; t <= 2300; t += 50) {
    const frame = computeWhipFrame(t);
    assert.ok(Number.isFinite(frame.tipX), `tipX finite at t=${t}`);
    assert.ok(Number.isFinite(frame.tipY), `tipY finite at t=${t}`);
    assert.ok(Number.isFinite(frame.tipAngle), `tipAngle finite at t=${t}`);
    assert.match(frame.ropeD, /^M\d/);
    assert.match(frame.baseD, /^M\d/);
  }
});

test("computeWhipFrame settles back near the rest tip after the ring-down", async () => {
  const { computeWhipFrame } = await loadWhipMotion();
  const settled = computeWhipFrame(2300);
  assert.ok(Math.abs(settled.tipX - 96) < 6);
  assert.ok(Math.abs(settled.tipY - 230) < 6);
});
