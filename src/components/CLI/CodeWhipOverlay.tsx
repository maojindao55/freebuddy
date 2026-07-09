import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import {
  useWhipEffectStore,
  WHIP_EFFECT_MS,
  WHIP_HIT_AT_MS
} from "@/store/whipEffectStore";
import {
  computeStageFade,
  createWhipSimulation,
  swingProgress,
  WHIP_ATTACH_POINT,
  type CrackParticle
} from "@/utils/whipMotion";

export function CodeWhipOverlay() {
  const { t } = useTranslation();
  const active = useWhipEffectStore((s) => s.active);
  const nonce = useWhipEffectStore((s) => s.nonce);
  const target = useWhipEffectStore((s) => s.target);
  const power = useWhipEffectStore((s) => s.power);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<SVGGElement | null>(null);
  const ropeRef = useRef<SVGPathElement | null>(null);
  const baseRef = useRef<SVGPathElement | null>(null);
  const crackerRef = useRef<SVGGElement | null>(null);
  const particlesRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    if (!active) return;

    const sim = createWhipSimulation(WHIP_ATTACH_POINT, { power });
    const paint = (
      elapsed: number,
      frame: ReturnType<typeof sim.advanceTo>,
      opacityOverride?: number
    ) => {
      const fade = computeStageFade(elapsed, WHIP_EFFECT_MS);
      if (stageRef.current) {
        stageRef.current.style.opacity = String(
          opacityOverride ?? fade.opacity
        );
      }
      const dx = frame.handleX - WHIP_ATTACH_POINT.x;
      const dy = frame.handleY - WHIP_ATTACH_POINT.y;
      handleRef.current?.setAttribute("transform", `translate(${dx} ${dy})`);
      ropeRef.current?.setAttribute("d", frame.ropeD);
      baseRef.current?.setAttribute("d", frame.baseD);
      crackerRef.current?.setAttribute(
        "transform",
        `translate(${frame.tipX} ${frame.tipY}) rotate(${(frame.tipAngle * 180) / Math.PI})`
      );
      paintParticles(particlesRef.current, frame.particles);
    };

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      // Hold a single mid-crack pose instead of animating the full swing.
      const frame = sim.advanceTo(WHIP_HIT_AT_MS + 60, WHIP_HIT_AT_MS, WHIP_EFFECT_MS);
      paint(WHIP_HIT_AT_MS + 60, frame, 1);
      return;
    }

    let raf = 0;
    const start = performance.now();
    const tick = () => {
      const elapsed = Math.min(performance.now() - start, WHIP_EFFECT_MS);
      // One physics step per display frame, driven by swing progress so the
      // tip-speed peak lands near WHIP_HIT_AT_MS (same as the canvas demo).
      const progress = swingProgress(elapsed, WHIP_HIT_AT_MS, WHIP_EFFECT_MS);
      const frame = sim.step(progress);
      frame.opacity = computeStageFade(elapsed, WHIP_EFFECT_MS).opacity;
      paint(elapsed, frame);
      if (elapsed < WHIP_EFFECT_MS) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, nonce, power]);

  const stars = useMemo(() => {
    const count = Math.round(14 + power * 8);
    const colors = ["#fde047", "#fef08a", "#fbbf24", "#fff7cd", "#facc15", "#ffffff"];
    return Array.from({ length: count }, () => {
      const angle = Math.random() * Math.PI * 2;
      const dist = 38 + Math.random() * 64;
      return {
        bx: Math.cos(angle) * dist,
        by: Math.sin(angle) * dist - 12,
        delay: 1.0 + Math.random() * 0.14,
        size: 12 + Math.random() * 14,
        color: colors[Math.floor(Math.random() * colors.length)]
      };
    });
  }, [nonce, power]);

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
    <div className="code-whip-overlay" key={nonce} aria-hidden="true" style={{ "--whip-power": power } as CSSProperties}>
      <div className="code-whip-flash" style={aimStyle} />
      <div className="code-whip-shake">
      <div
        className="code-whip-stage"
        ref={stageRef}
        style={{ ...aimStyle, opacity: 0 }}
      >
        <svg
          className="code-whip-svg"
          viewBox="0 0 560 300"
          width="560"
          height="300"
        >
          <defs>
            <linearGradient id="whip-grip-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#8b5a2b" />
              <stop offset="100%" stopColor="#5c3a1a" />
            </linearGradient>
          </defs>

          {/*
            Decorative handle translates with the Verlet root each frame
            (see createWhipSimulation / handlePos). The soft lash is a
            distance-constrained rope driven by that same root motion.
          */}
          <g className="code-whip-handle" ref={handleRef}>
            <path
              d="M436 156 L506 198"
              fill="none"
              stroke="url(#whip-grip-grad)"
              strokeWidth="13"
              strokeLinecap="round"
            />
          </g>

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
            <g ref={particlesRef} className="code-whip-particles" />
          </g>
        </svg>
      </div>
      <div className="code-whip-hit-fx" style={hitStyle}>
        <div className="code-whip-crack">{t("message.whipCrack")}</div>
        {stars.map((s, i) => (
          <span
            key={i}
            className="code-whip-star"
            style={{
              "--bx": `${s.bx}px`,
              "--by": `${s.by}px`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              background: s.color,
              animationDelay: `${s.delay}s`
            } as CSSProperties}
          />
        ))}
      </div>
      </div>
    </div>
  );
}

function paintParticles(
  group: SVGGElement | null,
  particles: CrackParticle[]
) {
  if (!group) return;
  while (group.firstChild) group.removeChild(group.firstChild);
  const ns = "http://www.w3.org/2000/svg";
  for (const p of particles) {
    if (p.ring) {
      const ring = document.createElementNS(ns, "circle");
      ring.setAttribute("cx", String(p.x));
      ring.setAttribute("cy", String(p.y));
      ring.setAttribute("r", String(p.r ?? 4));
      ring.setAttribute("fill", "none");
      ring.setAttribute(
        "stroke",
        `rgba(255, 220, 150, ${Math.max(0, p.life * 0.7)})`
      );
      ring.setAttribute("stroke-width", String(Math.max(0.5, 3 * p.life)));
      group.appendChild(ring);
    } else {
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", String(p.x));
      dot.setAttribute("cy", String(p.y));
      dot.setAttribute("r", String(Math.max(0.2, p.size * p.life)));
      dot.setAttribute(
        "fill",
        `hsla(${p.hue}, 100%, 65%, ${Math.max(0, p.life)})`
      );
      group.appendChild(dot);
    }
  }
}
