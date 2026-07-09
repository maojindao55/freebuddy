import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { useWhipEffectStore } from "@/store/whipEffectStore";

export function CodeWhipOverlay() {
  const { t } = useTranslation();
  const active = useWhipEffectStore((s) => s.active);
  const nonce = useWhipEffectStore((s) => s.nonce);
  const target = useWhipEffectStore((s) => s.target);
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
          viewBox="0 0 720 360"
          width="720"
          height="360"
        >
          <defs>
            <linearGradient id="whip-grip-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#8a2f2f" />
              <stop offset="45%" stopColor="#6b1f24" />
              <stop offset="100%" stopColor="#4a1418" />
            </linearGradient>
          </defs>

          {/* Short straight handle on the right: pommel → gold → grip → gold → ferrule */}
          <g className="code-whip-handle">
            <circle cx="678" cy="248" r="11" fill="#2a2a2a" />
            <circle cx="678" cy="248" r="7" fill="#3d3d3d" />
            <circle cx="664" cy="240" r="7.5" fill="#d4a017" />
            <circle cx="664" cy="240" r="4.5" fill="#f0c94a" />
            <path
              d="M658 236 L612 210"
              fill="none"
              stroke="url(#whip-grip-grad)"
              strokeWidth="16"
              strokeLinecap="butt"
            />
            <path
              d="M650 232 L644 228 M642 227 L636 223 M634 222 L628 218 M626 217 L620 213"
              fill="none"
              stroke="#3a1014"
              strokeWidth="1.6"
              strokeLinecap="round"
              opacity="0.55"
            />
            <circle cx="606" cy="206" r="7.5" fill="#d4a017" />
            <circle cx="606" cy="206" r="4.5" fill="#f0c94a" />
            <circle cx="592" cy="198" r="10" fill="#2a2a2a" />
            <circle cx="592" cy="198" r="6" fill="#3d3d3d" />
          </g>

          {/* Long thin tip only — no thick lash body */}
          <g className="code-whip-tip">
            <path
              className="code-whip-cord"
              d="M586 194
                 C480 140, 360 96, 250 88
                 C160 82, 80 110, 20 160
                 C-20 194, -60 240, -100 290
                 C-118 312, -136 332, -156 350"
              fill="none"
              stroke="#2a1a0c"
              strokeWidth="2.8"
              strokeLinecap="round"
            />
            <path
              d="M-130 328 L-168 342"
              fill="none"
              stroke="#3f2410"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
            <path
              d="M-130 332 L-164 358"
              fill="none"
              stroke="#2a1a0c"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
            <circle className="code-whip-tip-dot" cx="-158" cy="352" r="3" fill="#1a1008" />
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
