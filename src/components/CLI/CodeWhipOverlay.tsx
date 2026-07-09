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
          viewBox="0 0 520 320"
          width="520"
          height="320"
        >
          <defs>
            <linearGradient id="whip-handle-grad" x1="1" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#c48a4a" />
              <stop offset="55%" stopColor="#8b5a2b" />
              <stop offset="100%" stopColor="#5c3317" />
            </linearGradient>
            <linearGradient id="whip-cord-grad" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0%" stopColor="#4a2c14" />
              <stop offset="70%" stopColor="#2b1a0d" />
              <stop offset="100%" stopColor="#1a1008" />
            </linearGradient>
          </defs>
          {/* Straight wooden handle on the right */}
          <path
            d="M472 236 L402 198"
            fill="none"
            stroke="url(#whip-handle-grad)"
            strokeWidth="22"
            strokeLinecap="round"
          />
          <path
            d="M464 230 L418 206"
            fill="none"
            stroke="#6b3f1d"
            strokeWidth="3.5"
            strokeLinecap="round"
            opacity="0.5"
          />
          <circle cx="476" cy="238" r="8" fill="#3f2410" />
          {/* Cord arcs left toward the tip */}
          <path
            className="code-whip-cord"
            d="M402 198 C348 160, 292 118, 236 102 C176 84, 118 96, 72 132 C48 148, 30 166, 18 186"
            fill="none"
            stroke="url(#whip-cord-grad)"
            strokeWidth="11"
            strokeLinecap="round"
          />
          <path
            className="code-whip-cord-thin"
            d="M236 102 C176 84, 118 96, 72 132 C48 148, 30 166, 18 186"
            fill="none"
            stroke="#1a1008"
            strokeWidth="5"
            strokeLinecap="round"
          />
          {/* Tip / popper on the left */}
          <path
            className="code-whip-tip"
            d="M18 186 L-8 204"
            fill="none"
            stroke="#111"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <circle className="code-whip-tip-dot" cx="-10" cy="206" r="4" fill="#111" />
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
