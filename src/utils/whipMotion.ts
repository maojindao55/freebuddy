/**
 * Verlet-rope bullwhip, adapted from a classic canvas demo:
 *   - many mass points linked by distance constraints
 *   - the handle (root) is driven along a wind-up → snap → recover path
 *   - gravity + damping let the soft rope lag and crack like a real lash
 *   - tip speed above a threshold spawns a crack burst
 *
 * Pure math / simulation — no React. The overlay owns the RAF loop and
 * feeds `elapsedMs` in; unit tests step the same sim without a DOM.
 */

export interface Point {
  x: number;
  y: number;
}

interface VerletPoint {
  x: number;
  y: number;
  px: number;
  py: number;
}

export interface CrackParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  hue: number;
  ring?: boolean;
  r?: number;
}

/** Rest attach of the lash on the decorative handle (viewBox 560×300). */
export const WHIP_ATTACH_POINT: Point = { x: 430, y: 152 };

/** Default time-to-crack, matching whipEffectStore.WHIP_HIT_AT_MS. */
export const DEFAULT_CRACK_AT_MS = 1050;
export const DEFAULT_TOTAL_MS = 2300;

const SEGMENTS = 32;
const SEG_LEN = 11;
const GRAVITY = 0.32;
const DAMPING = 0.988;
const CONSTRAINT_ITERS = 24;
const TIP_SPEED_CRACK = 28;
const CRACK_COOLDOWN_FRAMES = 28;
const FRAME_MS = 1000 / 60;

/** Wind-up occupies the first ~42% of the time-to-crack (same as before). */
const WINDUP_FRACTION = 0.42;

/** Shoulder-ish pivot: left of and slightly below the rest attach. */
const PIVOT_DX = -118;
const PIVOT_DY = 28;
/**
 * Wind-up lean (radians, counterclockwise from rest): lifts the grip up
 * and back so the throw has room to come over the top.
 */
const WINDUP_DELTA = 1.25;
/**
 * Forward throw past the wind-up peak (radians, still counterclockwise).
 * Combined with wind-up this is ~250° over the top — a full circular crack.
 */
const SNAP_DELTA = 3.15;
/** Radius stretch at peak snap so the throw reads bigger / harder. */
const SNAP_RADIUS_BOOST = 1.45;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function easeOutQuad(x: number): number {
  return 1 - (1 - x) * (1 - x);
}

function easeInQuart(x: number): number {
  return x * x * x * x;
}

function easeOutCubic(x: number): number {
  const c = 1 - x;
  return 1 - c * c * c;
}

/**
 * Map wall-clock elapsed time onto the demo's 0→1 swing progress so the
 * tip-speed peak lands near `crackAtMs` (snap phase 0.35→0.6).
 */
export function swingProgress(
  elapsedMs: number,
  crackAtMs: number = DEFAULT_CRACK_AT_MS,
  totalMs: number = DEFAULT_TOTAL_MS
): number {
  const windupEnd = crackAtMs * WINDUP_FRACTION;
  if (elapsedMs <= 0) return 0;
  if (elapsedMs <= windupEnd) {
    return 0.35 * easeOutQuad(clamp01(elapsedMs / windupEnd));
  }
  if (elapsedMs <= crackAtMs) {
    // Ease-IN quartic: slow → very fast so angular velocity peaks at crack.
    const k = clamp01((elapsedMs - windupEnd) / Math.max(crackAtMs - windupEnd, 1));
    return 0.35 + 0.25 * easeInQuart(k);
  }
  const k = clamp01((elapsedMs - crackAtMs) / Math.max(totalMs - crackAtMs, 1));
  return 0.6 + 0.4 * easeOutCubic(k);
}

/**
 * Handle trajectory: one big circular throw around a shoulder-ish pivot.
 *
 * Screen y grows downward. From rest (grip to the right of the pivot),
 * counterclockwise lifts the grip up/back, then continues over the top
 * and down toward the avatar on the left — a full circular throw.
 *
 *   0→0.35  wind-up: lean back up
 *   0.35→0.6 snap: accelerate ~250° over the top
 *   0.6→1   recover toward rest
 */
export function handlePos(progress: number, base: Point = WHIP_ATTACH_POINT): Point {
  const p = clamp01(progress);
  const cx = base.x + PIVOT_DX;
  const cy = base.y + PIVOT_DY;
  const restDx = base.x - cx;
  const restDy = base.y - cy;
  const restAngle = Math.atan2(restDy, restDx);
  const restR = Math.hypot(restDx, restDy);

  let angle: number;
  let radius = restR;

  if (p < 0.35) {
    const k = easeOutQuad(p / 0.35);
    // Counterclockwise = up and back from rest.
    angle = restAngle - k * WINDUP_DELTA;
    radius = restR * (1 + k * 0.14);
  } else if (p < 0.6) {
    const k = easeInQuart((p - 0.35) / 0.25);
    // Keep going the long way: wind-up peak → over the top → forward crack.
    const from = restAngle - WINDUP_DELTA;
    const to = restAngle - WINDUP_DELTA - SNAP_DELTA;
    angle = from + k * (to - from);
    radius = restR * (1.14 + k * (SNAP_RADIUS_BOOST - 1.14));
  } else {
    const k = easeOutCubic((p - 0.6) / 0.4);
    const from = restAngle - WINDUP_DELTA - SNAP_DELTA;
    // Shortest recover back toward rest (unwrap toward restAngle - 2π).
    const to = restAngle - Math.PI * 2;
    angle = from + k * (to - from);
    radius = restR * (SNAP_RADIUS_BOOST + k * (1 - SNAP_RADIUS_BOOST));
  }

  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius
  };
}

function createHangChain(base: Point): VerletPoint[] {
  const points: VerletPoint[] = [];
  for (let i = 0; i < SEGMENTS; i += 1) {
    const t = i / Math.max(SEGMENTS - 1, 1);
    // Rest hang: left and slightly down toward the avatar contact zone.
    const x = base.x - t * (SEG_LEN * (SEGMENTS - 1)) * 0.92;
    const y = base.y + t * (SEG_LEN * (SEGMENTS - 1)) * 0.28;
    points.push({ x, y, px: x, py: y });
  }
  return points;
}

function smoothPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0].x} ${points[0].y}`;
  let d = `M${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

export interface WhipFrame {
  ropeD: string;
  baseD: string;
  tipX: number;
  tipY: number;
  tipAngle: number;
  tipSpeed: number;
  handleX: number;
  handleY: number;
  /** Stage opacity (fade in / out). */
  opacity: number;
  /** True on the frame the tip first exceeds the crack threshold. */
  cracked: boolean;
  particles: CrackParticle[];
}

export interface WhipSimulation {
  /** Advance one ~60fps physics frame at the given swing progress. */
  step(progress: number): WhipFrame;
  /**
   * Catch the sim up to `elapsedMs` with fixed 60fps substeps (for tests /
   * reduced-motion pose sampling).
   */
  advanceTo(
    elapsedMs: number,
    crackAtMs?: number,
    totalMs?: number
  ): WhipFrame;
  reset(): void;
}

function fadeOpacity(elapsedMs: number, totalMs: number): number {
  const fadeInMs = 140;
  const fadeOutMs = 260;
  if (elapsedMs < fadeInMs) return clamp01(elapsedMs / fadeInMs);
  return clamp01((totalMs - elapsedMs) / fadeOutMs);
}

export function createWhipSimulation(
  base: Point = WHIP_ATTACH_POINT
): WhipSimulation {
  let points = createHangChain(base);
  let particles: CrackParticle[] = [];
  let crackCooldown = 0;
  let lastElapsed = -FRAME_MS;
  let crackedThisStep = false;

  function spawnCrack(x: number, y: number, vx: number, vy: number) {
    for (let i = 0; i < 22; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const s = 2 + Math.random() * 8;
      particles.push({
        x,
        y,
        vx: Math.cos(a) * s + vx * 0.22,
        vy: Math.sin(a) * s + vy * 0.22,
        life: 1,
        size: 1 + Math.random() * 2.8,
        hue: 28 + Math.random() * 28
      });
    }
    particles.push({
      x,
      y,
      vx: 0,
      vy: 0,
      life: 1,
      size: 0,
      hue: 40,
      ring: true,
      r: 4
    });
  }

  function snapshot(tipSpeed: number): WhipFrame {
    const pts: Point[] = points.map((p) => ({ x: p.x, y: p.y }));
    const tip = pts[pts.length - 1];
    const prev = pts[pts.length - 2] ?? tip;
    const tipAngle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
    const handle = pts[0];
    const baseCount = Math.min(pts.length, Math.ceil(pts.length * 0.45));
    return {
      ropeD: smoothPath(pts),
      baseD: smoothPath(pts.slice(0, baseCount)),
      tipX: tip.x,
      tipY: tip.y,
      tipAngle,
      tipSpeed,
      handleX: handle.x,
      handleY: handle.y,
      opacity: 1,
      cracked: crackedThisStep,
      particles: particles.map((p) => ({ ...p }))
    };
  }

  function physicsStep(progress: number): WhipFrame {
    crackedThisStep = false;
    const h = handlePos(progress, base);

    for (let i = 1; i < SEGMENTS; i += 1) {
      const p = points[i];
      const vx = (p.x - p.px) * DAMPING;
      const vy = (p.y - p.py) * DAMPING;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + GRAVITY;
    }

    points[0].x = h.x;
    points[0].y = h.y;
    points[0].px = h.x;
    points[0].py = h.y;

    for (let iter = 0; iter < CONSTRAINT_ITERS; iter += 1) {
      for (let i = 0; i < SEGMENTS - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        const diff = (dist - SEG_LEN) / dist;
        if (i === 0) {
          b.x -= dx * diff;
          b.y -= dy * diff;
        } else {
          a.x += dx * diff * 0.5;
          a.y += dy * diff * 0.5;
          b.x -= dx * diff * 0.5;
          b.y -= dy * diff * 0.5;
        }
      }
    }

    const tip = points[SEGMENTS - 1];
    const tvx = tip.x - tip.px;
    const tvy = tip.y - tip.py;
    const tipSpeed = Math.hypot(tvx, tvy);

    if (crackCooldown > 0) crackCooldown -= 1;
    if (tipSpeed > TIP_SPEED_CRACK && crackCooldown === 0) {
      spawnCrack(tip.x, tip.y, tvx, tvy);
      crackCooldown = CRACK_COOLDOWN_FRAMES;
      crackedThisStep = true;
    }

    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const p = particles[i];
      if (p.ring) {
        p.r = (p.r ?? 4) + 7;
        p.life -= 0.07;
      } else {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.14;
        p.vx *= 0.96;
        p.vy *= 0.96;
        p.life -= 0.035;
      }
      if (p.life <= 0) particles.splice(i, 1);
    }

    return snapshot(tipSpeed);
  }

  return {
    step(progress: number) {
      return physicsStep(progress);
    },
    advanceTo(elapsedMs, crackAtMs = DEFAULT_CRACK_AT_MS, totalMs = DEFAULT_TOTAL_MS) {
      const target = Math.max(0, elapsedMs);
      // First call (or after reset): step from 0 up to target.
      let t = Math.max(0, lastElapsed);
      if (t < 0) t = 0;
      let frame = snapshot(0);
      if (target <= t && lastElapsed >= 0) {
        frame = physicsStep(swingProgress(target, crackAtMs, totalMs));
        frame.opacity = fadeOpacity(target, totalMs);
        lastElapsed = target;
        return frame;
      }
      while (t < target) {
        t = Math.min(t + FRAME_MS, target);
        frame = physicsStep(swingProgress(t, crackAtMs, totalMs));
      }
      frame.opacity = fadeOpacity(target, totalMs);
      lastElapsed = target;
      return frame;
    },
    reset() {
      points = createHangChain(base);
      particles = [];
      crackCooldown = 0;
      lastElapsed = -FRAME_MS;
      crackedThisStep = false;
    }
  };
}

/**
 * Convenience for reduced-motion / one-shot sampling: run a fresh sim up to
 * `elapsedMs` and return that frame (with fade opacity applied).
 */
export function computeWhipFrame(
  elapsedMs: number,
  crackAtMs: number = DEFAULT_CRACK_AT_MS,
  totalMs: number = DEFAULT_TOTAL_MS
): WhipFrame {
  const sim = createWhipSimulation();
  return sim.advanceTo(elapsedMs, crackAtMs, totalMs);
}

/**
 * Stage no longer rotates independently — the Verlet handle path *is* the
 * swing. Kept as a thin fade helper so the overlay can still set opacity
 * without a second animation timeline.
 */
export function computeStageFade(
  elapsedMs: number,
  totalMs: number = DEFAULT_TOTAL_MS
): { opacity: number; deg: number; scale: number } {
  return {
    opacity: fadeOpacity(elapsedMs, totalMs),
    deg: 0,
    scale: 1
  };
}

/** @deprecated Use computeStageFade — arm rotation is now handle-driven. */
export const computeArmSwing = (
  elapsedMs: number,
  _crackAtMs?: number,
  totalMs: number = DEFAULT_TOTAL_MS
) => computeStageFade(elapsedMs, totalMs);
