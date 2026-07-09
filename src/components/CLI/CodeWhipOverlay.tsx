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
          viewBox="0 0 640 360"
          width="640"
          height="360"
        >
          <defs>
            <linearGradient id="whip-handle-grad" x1="1" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#c48a4a" />
              <stop offset="55%" stopColor="#8b5a2b" />
              <stop offset="100%" stopColor="#5c3317" />
            </linearGradient>
            <linearGradient id="whip-cord-grad" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0%" stopColor="#4a2c14" />
              <stop offset="55%" stopColor="#2b1a0d" />
              <stop offset="100%" stopColor="#1a1008" />
            </linearGradient>
          </defs>
          {/* Short straight wooden handle on the right */}
          <path
            d="M586 268 L548 246"
            fill="none"
            stroke="url(#whip-handle-grad)"
            strokeWidth="22"
            strokeLinecap="round"
          />
          <path
            d="M580 262 L558 250"
            fill="none"
            stroke="#6b3f1d"
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.5"
          />
          <circle cx="590" cy="270" r="8" fill="#3f2410" />
          {/* Longer cord arcs left toward the tip */}
          <path
            className="code-whip-cord"
            d="M548 246 C460 188, 370 120, 280 96 C190 70, 110 88, 52 132 C18 158, -8 190, -28 224 C-42 248, -58 274, -78 300"
            fill="none"
            stroke="url(#whip-cord-grad)"
            strokeWidth="11"
            strokeLinecap="round"
          />
          <path
            className="code-whip-cord-thin"
            d="M280 96 C190 70, 110 88, 52 132 C18 158, -8 190, -28 224 C-42 248, -58 274, -78 300"
            fill="none"
            stroke="#1a1008"
            strokeWidth="5"
            strokeLinecap="round"
          />
          {/* Extra-long tip / popper on the left */}
          <path
            className="code-whip-tip"
            d="M-78 300 L-148 348"
            fill="none"
            stroke="#111"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
          <circle className="code-whip-tip-dot" cx="-150" cy="350" r="4.5" fill="#111" />
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
