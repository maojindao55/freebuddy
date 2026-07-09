import { useEffect, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import {
  useWhipEffectStore,
  WHIP_EFFECT_MS,
  WHIP_HIT_AT_MS
} from "@/store/whipEffectStore";
import { computeWhipFrame } from "@/utils/whipMotion";

export function CodeWhipOverlay() {
  const { t } = useTranslation();
  const active = useWhipEffectStore((s) => s.active);
  const nonce = useWhipEffectStore((s) => s.nonce);
  const target = useWhipEffectStore((s) => s.target);

  const ropeRef = useRef<SVGPathElement | null>(null);
  const baseRef = useRef<SVGPathElement | null>(null);
  const crackerRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const applyFrame = (elapsed: number) => {
      const frame = computeWhipFrame(elapsed, WHIP_HIT_AT_MS);
      ropeRef.current?.setAttribute("d", frame.ropeD);
      baseRef.current?.setAttribute("d", frame.baseD);
      crackerRef.current?.setAttribute(
        "transform",
        `translate(${frame.tipX} ${frame.tipY}) rotate(${(frame.tipAngle * 180) / Math.PI})`
      );
    };
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      // Hold a single "mid-crack" pose instead of animating through the
      // full wind-up/snap/ring-down sequence.
      applyFrame(WHIP_HIT_AT_MS + 60);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = () => {
      const elapsed = Math.min(performance.now() - start, WHIP_EFFECT_MS);
      applyFrame(elapsed);
      if (elapsed < WHIP_EFFECT_MS) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, nonce]);

  if (!active || !target) return null;

  const hitStyle: CSSProperties = {
    left: `${target.x}px`,
    top: `${target.y}px`
  };
  const aimStyle = {
    "--whip-hit-x": `${target.x}px`,
    "--whip-hit-y": `${target.y}px`
  } as CSSProperties;

  return (
    <div className="code-whip-overlay" key={nonce} aria-hidden="true">
      <div className="code-whip-flash" style={aimStyle} />
      <div className="code-whip-stage" style={aimStyle}>
        <svg
          className="code-whip-svg"
          viewBox="0 0 560 300"
          width="560"
          height="300"
        >
          <defs>
            <linearGradient id="whip-grip-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#8a2f2f" />
              <stop offset="45%" stopColor="#6b1f24" />
              <stop offset="100%" stopColor="#4a1418" />
            </linearGradient>
          </defs>

          {/* Short straight handle on the right */}
          <g className="code-whip-handle">
            <circle cx="508" cy="198" r="10" fill="#2a2a2a" />
            <circle cx="508" cy="198" r="6.5" fill="#3d3d3d" />
            <circle cx="496" cy="191" r="7" fill="#d4a017" />
            <circle cx="496" cy="191" r="4" fill="#f0c94a" />
            <path
              d="M490 187 L454 166"
              fill="none"
              stroke="url(#whip-grip-grad)"
              strokeWidth="15"
              strokeLinecap="butt"
            />
            <path
              d="M484 184 L478 180 M476 179 L470 175 M468 174 L462 170"
              fill="none"
              stroke="#3a1014"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity="0.55"
            />
            <circle cx="448" cy="162" r="7" fill="#d4a017" />
            <circle cx="448" cy="162" r="4" fill="#f0c94a" />
            <circle cx="436" cy="155" r="9" fill="#2a2a2a" />
            <circle cx="436" cy="155" r="5.5" fill="#3d3d3d" />
          </g>

          {/*
            Rope driven by requestAnimationFrame (see computeWhipFrame): a
            continuous traveling wave, not discrete CSS keyframes, so the
            lash flows like a real cracking whip rather than a jointed arm.
            The thicker base path fakes a taper toward the thin tip.
          */}
          <g className="code-whip-tip">
            <path
              ref={baseRef}
              className="code-whip-base"
              fill="none"
              stroke="#5c3819"
              strokeWidth="4.2"
              strokeLinecap="round"
            />
            <path
              ref={ropeRef}
              className="code-whip-rope"
              fill="none"
              stroke="#2a1a0c"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <g ref={crackerRef} className="code-whip-cracker">
              {/* Local +x continues along the rope's current direction
                  (rotate() maps it there), so these extend past the tip. */}
              <path
                d="M0 0 L22 -8"
                fill="none"
                stroke="#2a1a0c"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <path
                d="M0 2 L26 14"
                fill="none"
                stroke="#1a1008"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <circle cx="18" cy="4" r="3" fill="#1a1008" />
            </g>
          </g>
        </svg>
      </div>
      <div className="code-whip-hit-fx" style={hitStyle}>
        <div className="code-whip-impact" />
        <div className="code-whip-crack">{t("message.whipCrack")}</div>
        <div className="code-whip-spark code-whip-spark-1" />
        <div className="code-whip-spark code-whip-spark-2" />
        <div className="code-whip-spark code-whip-spark-3" />
        <div className="code-whip-spark code-whip-spark-4" />
      </div>
    </div>
  );
}
