/**
 * Continuous rope-chain model of a bullwhip crack.
 *
 * Instead of a handful of discrete CSS keyframes (which reads as a
 * mechanical, multi-segment robot arm), the rope is sampled at many points
 * and each point's rotation relative to the previous one is a smooth
 * function of time: a traveling wave that reaches point `u` after
 * `u * crackAtMs`, snaps forward once it arrives, and rings down. Rotations
 * compound down the chain (like a real rope), and the sampled points are
 * rendered through a Catmull-Rom spline so the curve stays fluid — no
 * visible joints.
 *
 * This module has no runtime dependencies on the rest of the app (the
 * caller passes `crackAtMs`, which should match
 * `whipEffectStore.WHIP_HIT_AT_MS`) so the wave math can be unit tested in
 * isolation.
 */

interface Point {
  x: number;
  y: number;
}

export const WHIP_ATTACH_POINT: Point = { x: 430, y: 152 };

/** Rest-shape control points for a relaxed S-curve from handle to tip. */
const REST_CONTROL: [Point, Point, Point] = [
  { x: 358, y: 96 },
  { x: 186, y: 108 },
  { x: 96, y: 230 }
];

const JOINT_COUNT = 9; // sample points including the fixed attach point

function restBezierPoint(t: number): Point {
  const [p1, p2, p3] = REST_CONTROL;
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * WHIP_ATTACH_POINT.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * WHIP_ATTACH_POINT.y + b * p1.y + c * p2.y + d * p3.y
  };
}

interface RestJoint {
  /** Normalized position along the rope, 0 = handle, 1 = tip. */
  u: number;
  /** Rest turn relative to the previous segment's direction (radians). */
  relativeAngle: number;
  length: number;
}

function buildRestJoints(): RestJoint[] {
  const points: Point[] = [];
  for (let i = 0; i < JOINT_COUNT; i += 1) {
    const t = i / (JOINT_COUNT - 1);
    points.push(i === 0 ? WHIP_ATTACH_POINT : restBezierPoint(t));
  }
  const joints: RestJoint[] = [];
  let prevAngle = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const angle = Math.atan2(dy, dx);
    joints.push({
      u: i / (JOINT_COUNT - 1),
      relativeAngle: i === 1 ? angle : angle - prevAngle,
      length: Math.hypot(dx, dy)
    });
    prevAngle = angle;
  }
  return joints;
}

const REST_JOINTS = buildRestJoints();

/** Default time-to-crack, matching whipEffectStore.WHIP_HIT_AT_MS. */
export const DEFAULT_CRACK_AT_MS = 1050;
/** Peak swing amplitude at the tip (u=1), in radians. */
const AMP_MAX = 0.46;
/** Oscillation period once the wave reaches a point. */
const PERIOD_MS = 260;
/** Ring-down time constant after the wave passes a point. */
const DECAY_TAU_MS = 230;

/**
 * Local bend at normalized position `u`, `localT` ms after the traveling
 * wave reached it. Starts pulled back (anticipation), snaps forward through
 * zero at the half period (the crack), then rings down and settles.
 */
function bendDelta(u: number, localT: number): number {
  if (localT < 0) return 0;
  const amp = AMP_MAX * Math.pow(u, 1.6);
  const decay = Math.exp(-localT / DECAY_TAU_MS);
  return amp * decay * -Math.cos((2 * Math.PI * localT) / PERIOD_MS);
}

/** Catmull-Rom → cubic Bezier smoothing through a point sequence. */
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
  /** Smooth path `d` for the full rope, from the handle attach point. */
  ropeD: string;
  /** Smooth path `d` for just the base half — layered thicker for taper. */
  baseD: string;
  tipX: number;
  tipY: number;
  /** Direction (radians) the last segment points, for the cracker flourish. */
  tipAngle: number;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function easeOutCubic(x: number): number {
  const c = 1 - x;
  return 1 - c * c * c;
}

function easeInCubic(x: number): number {
  return x * x * x;
}

const WINDUP_ANGLE_DEG = 24;
const SNAP_ANGLE_DEG = -9;
const SETTLE_ANGLE_DEG = -2;
const SNAP_SCALE = 1.05;
/** Wind-up occupies the first ~42% of the time-to-crack. */
const WINDUP_FRACTION = 0.42;

export interface ArmSwing {
  /** Rotation in degrees (apply directly as `rotate(${deg}deg)`). */
  deg: number;
  scale: number;
  opacity: number;
}

/**
 * The arm's own swing (wind-up → forward snap → settle), computed with the
 * same "continuous function of time" philosophy as the rope wave so both
 * move as one connected gesture instead of two independently-timed
 * animations (a CSS keyframe swing layered over a JS-driven rope tends to
 * read as two things happening at once, not one whip crack).
 *
 * The forward-snap phase uses an ease-IN curve (slow → fast), so angular
 * velocity peaks right as `crackAtMs` is reached — that peak velocity,
 * not the peak angle, is what should read as "the crack".
 */
export function computeArmSwing(
  elapsedMs: number,
  crackAtMs: number = DEFAULT_CRACK_AT_MS,
  totalMs = 2300
): ArmSwing {
  const windupEnd = crackAtMs * WINDUP_FRACTION;
  let deg: number;
  let scale: number;

  if (elapsedMs <= windupEnd) {
    const p = easeOutCubic(clamp01(elapsedMs / windupEnd));
    deg = p * WINDUP_ANGLE_DEG;
    scale = 1 + p * 0.02;
  } else if (elapsedMs <= crackAtMs) {
    const p = easeInCubic(
      clamp01((elapsedMs - windupEnd) / (crackAtMs - windupEnd))
    );
    deg = WINDUP_ANGLE_DEG + p * (SNAP_ANGLE_DEG - WINDUP_ANGLE_DEG);
    scale = 1.02 + p * (SNAP_SCALE - 1.02);
  } else {
    const t = elapsedMs - crackAtMs;
    const settleSpan = Math.max(totalMs - crackAtMs, 1);
    const p = easeOutCubic(clamp01(t / settleSpan));
    const wiggle = 3 * Math.exp(-t / 350) * Math.cos((2 * Math.PI * t) / 450);
    deg = SNAP_ANGLE_DEG + p * (SETTLE_ANGLE_DEG - SNAP_ANGLE_DEG) + wiggle;
    scale = SNAP_SCALE + p * (1 - SNAP_SCALE);
  }

  const fadeInMs = 140;
  const fadeOutMs = 260;
  const opacity =
    elapsedMs < fadeInMs
      ? clamp01(elapsedMs / fadeInMs)
      : clamp01((totalMs - elapsedMs) / fadeOutMs);

  return { deg, scale, opacity: Math.min(1, opacity) };
}

export function computeWhipFrame(
  elapsedMs: number,
  crackAtMs: number = DEFAULT_CRACK_AT_MS
): WhipFrame {
  const points: Point[] = [WHIP_ATTACH_POINT];
  let cumAngle = 0;
  for (const joint of REST_JOINTS) {
    const delay = joint.u * crackAtMs;
    const localT = elapsedMs - delay;
    cumAngle += joint.relativeAngle + bendDelta(joint.u, localT);
    const prev = points[points.length - 1];
    points.push({
      x: prev.x + joint.length * Math.cos(cumAngle),
      y: prev.y + joint.length * Math.sin(cumAngle)
    });
  }
  const tip = points[points.length - 1];
  const baseCount = Math.min(points.length, 6);
  return {
    ropeD: smoothPath(points),
    baseD: smoothPath(points.slice(0, baseCount)),
    tipX: tip.x,
    tipY: tip.y,
    tipAngle: cumAngle
  };
}
