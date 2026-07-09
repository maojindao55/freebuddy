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
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
}

test("handlePos winds up over the top, then cracks through a big circular throw", async () => {
  const { handlePos, WHIP_ATTACH_POINT } = await loadWhipMotion();
  const rest = handlePos(0);
  assert.equal(rest.x, WHIP_ATTACH_POINT.x);
  assert.equal(rest.y, WHIP_ATTACH_POINT.y);

  const windup = handlePos(0.35);
  assert.ok(windup.y < WHIP_ATTACH_POINT.y - 40, "wind-up lifts the grip high");
  assert.ok(windup.x < WHIP_ATTACH_POINT.x, "wind-up leans back toward the pivot");

  // Mid-snap should still be high/left — the long way over the top.
  const midSnap = handlePos(0.5);
  assert.ok(midSnap.x < windup.x, "snap continues left over the top");

  const snap = handlePos(0.6);
  assert.ok(snap.y > WHIP_ATTACH_POINT.y, "crack lands below rest after the circular throw");
  assert.ok(snap.x < WHIP_ATTACH_POINT.x, "crack still aims left toward the tip");

  // Arc length of the throw should be large ("抡圆了"), not a short jab.
  let arc = 0;
  let prev = handlePos(0.35);
  for (let i = 1; i <= 20; i += 1) {
    const cur = handlePos(0.35 + (0.25 * i) / 20);
    arc += Math.hypot(cur.x - prev.x, cur.y - prev.y);
    prev = cur;
  }
  assert.ok(arc > 350, `expected a long circular snap arc, got ${arc.toFixed(0)}`);

  const end = handlePos(1);
  assert.ok(Math.abs(end.x - WHIP_ATTACH_POINT.x) < 2);
  assert.ok(Math.abs(end.y - WHIP_ATTACH_POINT.y) < 2);
});

test("swingProgress maps crackAtMs onto the snap phase (~0.6)", async () => {
  const { swingProgress, DEFAULT_CRACK_AT_MS } = await loadWhipMotion();
  assert.ok(Math.abs(swingProgress(0) - 0) < 1e-9);
  const atCrack = swingProgress(DEFAULT_CRACK_AT_MS);
  assert.ok(Math.abs(atCrack - 0.6) < 1e-6, `expected ~0.6, got ${atCrack}`);
  assert.ok(swingProgress(DEFAULT_CRACK_AT_MS * 0.42) < 0.36);
  assert.ok(swingProgress(2300) >= 0.99);
});

test("Verlet sim starts hanging from the attach point", async () => {
  const { createWhipSimulation, WHIP_ATTACH_POINT } = await loadWhipMotion();
  const sim = createWhipSimulation();
  const frame = sim.step(0);
  assert.ok(frame.ropeD.startsWith(`M${WHIP_ATTACH_POINT.x} ${WHIP_ATTACH_POINT.y}`));
  assert.ok(Number.isFinite(frame.tipX));
  assert.ok(Number.isFinite(frame.tipY));
  assert.ok(frame.tipX < WHIP_ATTACH_POINT.x, "tip hangs to the left of the grip");
  assert.ok(frame.tipY > WHIP_ATTACH_POINT.y, "tip hangs below the grip");
});

test("Verlet sim produces continuous motion through the swing", async () => {
  const { createWhipSimulation } = await loadWhipMotion();
  const sim = createWhipSimulation();
  const a = sim.step(0);
  const b = sim.step(0.2);
  const c = sim.step(0.5);
  assert.notEqual(b.ropeD, a.ropeD);
  assert.notEqual(c.ropeD, b.ropeD);
  assert.ok(Number.isFinite(c.tipSpeed));
});

test("tip speed peaks hard during the forward snap", async () => {
  const { createWhipSimulation } = await loadWhipMotion();
  const sim = createWhipSimulation();
  let peak = 0;
  let peakP = 0;
  let cracked = false;
  for (let i = 0; i <= 90; i += 1) {
    const p = i / 90;
    const frame = sim.step(p);
    if (frame.cracked) cracked = true;
    if (frame.tipSpeed > peak) {
      peak = frame.tipSpeed;
      peakP = p;
    }
  }
  assert.ok(peak > 40, `expected a hard crack-speed peak, got ${peak}`);
  // Soft rope lags the handle, so the tip peak lands near/just after snap.
  assert.ok(peakP >= 0.4 && peakP <= 0.9, `peak at progress ${peakP}`);
  assert.equal(cracked, true, "tip speed should trigger a crack burst");
});

test("computeWhipFrame stays finite across the full effect duration", async () => {
  const { computeWhipFrame } = await loadWhipMotion();
  for (let t = 0; t <= 2300; t += 100) {
    const frame = computeWhipFrame(t);
    assert.ok(Number.isFinite(frame.tipX), `tipX finite at t=${t}`);
    assert.ok(Number.isFinite(frame.tipY), `tipY finite at t=${t}`);
    assert.ok(Number.isFinite(frame.tipAngle), `tipAngle finite at t=${t}`);
    assert.match(frame.ropeD, /^M[\d.-]/);
    assert.match(frame.baseD, /^M[\d.-]/);
    assert.ok(frame.opacity >= 0 && frame.opacity <= 1);
  }
});

test("computeStageFade fades in then out; no independent arm rotation", async () => {
  const { computeStageFade, computeArmSwing } = await loadWhipMotion();
  const start = computeStageFade(0, 2300);
  assert.ok(start.opacity < 0.05);
  assert.equal(start.deg, 0);

  const mid = computeStageFade(800, 2300);
  assert.equal(mid.opacity, 1);
  assert.equal(mid.deg, 0);

  const end = computeStageFade(2300, 2300);
  assert.ok(end.opacity < 0.05);

  // Back-compat alias still exports and matches the fade helper.
  const alias = computeArmSwing(800, 1050, 2300);
  assert.equal(alias.deg, 0);
  assert.equal(alias.opacity, 1);
});
