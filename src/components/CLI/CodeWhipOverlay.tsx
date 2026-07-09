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
            Jointed lash: a kinematic chain of nested groups, each pivoting
            at the previous segment's end. A traveling wave (increasing
            amplitude + delayed phase per joint) simulates a real bullwhip
            crack instead of a single warped path.
          */}
          <g className="code-whip-tip">
            <path
              className="code-whip-seg code-whip-seg-1"
              d="M430 152 L372 150"
              fill="none"
              stroke="#6b4220"
              strokeWidth="3.6"
              strokeLinecap="round"
            />
            <g className="code-whip-joint code-whip-joint-1">
              <path
                className="code-whip-seg code-whip-seg-2"
                d="M372 150 L312 158"
                fill="none"
                stroke="#5c3819"
                strokeWidth="3.2"
                strokeLinecap="round"
              />
              <g className="code-whip-joint code-whip-joint-2">
                <path
                  className="code-whip-seg code-whip-seg-3"
                  d="M312 158 L246 178"
                  fill="none"
                  stroke="#4d3015"
                  strokeWidth="2.8"
                  strokeLinecap="round"
                />
                <g className="code-whip-joint code-whip-joint-3">
                  <path
                    className="code-whip-seg code-whip-seg-4"
                    d="M246 178 L176 204"
                    fill="none"
                    stroke="#3f2712"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                  />
                  <g className="code-whip-joint code-whip-joint-4">
                    <path
                      className="code-whip-seg code-whip-seg-5"
                      d="M176 204 L108 226"
                      fill="none"
                      stroke="#2a1a0c"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <g className="code-whip-cracker">
                      <path
                        d="M108 226 L86 234"
                        fill="none"
                        stroke="#2a1a0c"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                      <path
                        d="M108 230 L82 240"
                        fill="none"
                        stroke="#1a1008"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                      />
                      <circle cx="88" cy="236" r="3" fill="#1a1008" />
                    </g>
                  </g>
                </g>
              </g>
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
