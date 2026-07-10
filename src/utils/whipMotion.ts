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
export const WHIP_VIEWBOX_WIDTH = 560;
export const WHIP_VIEWBOX_HEIGHT = 300;

const SEGMENTS = 32;
const SEG_LEN = 11;
const GRAVITY = 0.32;
const DAMPING = 0.993;
const CONSTRAINT_ITERS = 24;
const TIP_SPEED_CRACK = 28;
const CRACK_COOLDOWN_FRAMES = 28;
const FRAME_MS = 1000 / 60;

/** Wind-up occupies the first ~42% of the time-to-crack (same as before). */
const WINDUP_FRACTION = 0.42;

/**
 * Keyframe grip path (offsets from the rest attach, in viewBox units).
 *
 * A real bullwhip crack is a linear "pull back → lash forward → abrupt
 * halt": the hand stops dead while the soft rope keeps flying, and the tip
 * overshoots past the sound barrier. That is the opposite of a circular
 * windmill, so the grip follows waypoints in space instead of a pivot angle.
 */
interface GripWaypoint {
  dx: number;
  dy: number;
}
/** Rest at the decorative handle. */
const GRIP_REST: GripWaypoint = { dx: 0, dy: 0 };
/** Raise the grip high overhead to load the downward lash. */
const GRIP_WINDUP: GripWaypoint = { dx: 35, dy: -155 };
/** Drive the lash straight down toward the avatar. */
const GRIP_SNAP: GripWaypoint = { dx: -145, dy: 135 };
/** Abrupt halt at the contact zone with a tiny pull-back up — the stop that lets the tip crack. */
const GRIP_RECOIL: GripWaypoint = { dx: -115, dy: 100 };

function lerpWaypoint(a: GripWaypoint, b: GripWaypoint, k: number): GripWaypoint {
  return { dx: a.dx + (b.dx - a.dx) * k, dy: a.dy + (b.dy - a.dy) * k };
}

/**
 * Scale a waypoint away from an anchor by `power` (1 = unchanged). Heavier
 * whip power lengthens/strengthens the lash; the wind-up anchor stays put so
 * the wind-up pose is identical regardless of power.
 */
function scaleFromAnchor(
  anchor: GripWaypoint,
  target: GripWaypoint,
  power: number
): GripWaypoint {
  return {
    dx: anchor.dx + (target.dx - anchor.dx) * power,
    dy: anchor.dy + (target.dy - anchor.dy) * power
  };
}

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
 * Handle trajectory: a "raise overhead → drive straight down → halt" along
 * waypoints, not a circular throw around a pivot.
 *
 *   0→0.32  wind-up: ease the grip up overhead to load the lash
 *   0.32→0.58 lash: ease-IN quartic so velocity explodes straight down toward the target
 *   0.58→0.63 halt: snap to a near-stop + tiny reverse — this stop cracks the tip
 *   0.63→1   recover: ease straight back to rest (no unwinding lap)
 */
export function handlePos(
  progress: number,
  base: Point = WHIP_ATTACH_POINT,
  power: number = 1
): Point {
  const p = clamp01(progress);
  const snap = scaleFromAnchor(GRIP_WINDUP, GRIP_SNAP, power);
  const recoil = scaleFromAnchor(GRIP_WINDUP, GRIP_RECOIL, power);
  let wp: GripWaypoint;
  if (p < 0.32) {
    const k = easeOutQuad(p / 0.32);
    wp = lerpWaypoint(GRIP_REST, GRIP_WINDUP, k);
  } else if (p < 0.58) {
    const k = easeInQuart((p - 0.32) / (0.58 - 0.32));
    wp = lerpWaypoint(GRIP_WINDUP, snap, k);
  } else if (p < 0.63) {
    const k = easeOutQuad((p - 0.58) / (0.63 - 0.58));
    wp = lerpWaypoint(snap, recoil, k);
  } else {
    const k = easeOutCubic((p - 0.63) / (1 - 0.63));
    wp = lerpWaypoint(recoil, GRIP_REST, k);
  }
  return { x: base.x + wp.dx, y: base.y + wp.dy };
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
  base: Point = WHIP_ATTACH_POINT,
  options?: { power?: number }
): WhipSimulation {
  const power = options?.power ?? 1;
  let points = createHangChain(base);
  let particles: CrackParticle[] = [];
  let crackCooldown = 0;
  let simulatedElapsed = 0;
  let crackedThisStep = false;
  let currentFrame: WhipFrame;

  function spawnCrack(
    x: number,
    y: number,
    vx: number,
    vy: number,
    crackPower: number
  ) {
    const count = Math.max(6, Math.round(22 * crackPower));
    for (let i = 0; i < count; i += 1) {
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
    const h = handlePos(progress, base, power);

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
      spawnCrack(tip.x, tip.y, tvx, tvy, power);
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

  currentFrame = snapshot(0);

  return {
    step(progress: number) {
      return physicsStep(progress);
    },
    advanceTo(elapsedMs, crackAtMs = DEFAULT_CRACK_AT_MS, totalMs = DEFAULT_TOTAL_MS) {
      const target = Math.max(0, elapsedMs);
      if (target < simulatedElapsed) {
        points = createHangChain(base);
        particles = [];
        crackCooldown = 0;
        simulatedElapsed = 0;
        crackedThisStep = false;
        currentFrame = snapshot(0);
      }

      // Advance on a fixed 60 Hz clock. requestAnimationFrame can run at 60,
      // 90, 120, or 144 Hz; tying one physics step to each display frame makes
      // the rope follow a different path on high-refresh-rate Mac displays.
      while (simulatedElapsed + FRAME_MS <= target + 1e-6) {
        simulatedElapsed += FRAME_MS;
        currentFrame = physicsStep(
          swingProgress(simulatedElapsed, crackAtMs, totalMs)
        );
      }

      return {
        ...currentFrame,
        opacity: fadeOpacity(target, totalMs)
      };
    },
    reset() {
      points = createHangChain(base);
      particles = [];
      crackCooldown = 0;
      simulatedElapsed = 0;
      crackedThisStep = false;
      currentFrame = snapshot(0);
    }
  };
}

/** Deterministic rope-tip position at the visual/avatar hit timestamp. */
export function computeWhipImpactPoint(
  power: number = 1,
  hitAtMs: number = DEFAULT_CRACK_AT_MS
): Point {
  const sim = createWhipSimulation(WHIP_ATTACH_POINT, { power });
  const frame = sim.advanceTo(hitAtMs, hitAtMs, DEFAULT_TOTAL_MS);
  return { x: frame.tipX, y: frame.tipY };
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
