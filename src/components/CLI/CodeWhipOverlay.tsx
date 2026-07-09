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
            <linearGradient id="whip-handle-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#c48a4a" />
              <stop offset="55%" stopColor="#8b5a2b" />
              <stop offset="100%" stopColor="#5c3317" />
            </linearGradient>
            <linearGradient id="whip-cord-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#4a2c14" />
              <stop offset="70%" stopColor="#2b1a0d" />
              <stop offset="100%" stopColor="#1a1008" />
            </linearGradient>
          </defs>
          <path
            d="M46 248 C52 236, 70 228, 92 220 L118 208"
            fill="none"
            stroke="url(#whip-handle-grad)"
            strokeWidth="22"
            strokeLinecap="round"
          />
          <path
            d="M54 246 C60 238, 74 232, 90 224"
            fill="none"
            stroke="#6b3f1d"
            strokeWidth="4"
            strokeLinecap="round"
            opacity="0.55"
          />
          <circle cx="48" cy="250" r="8" fill="#3f2410" />
          <path
            className="code-whip-cord"
            d="M118 208 C168 168, 214 112, 268 92 C330 68, 392 78, 458 118 C478 130, 492 148, 502 168"
            fill="none"
            stroke="url(#whip-cord-grad)"
            strokeWidth="11"
            strokeLinecap="round"
          />
          <path
            className="code-whip-cord-thin"
            d="M268 92 C330 68, 392 78, 458 118 C478 130, 492 148, 502 168"
            fill="none"
            stroke="#1a1008"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <path
            className="code-whip-tip"
            d="M502 168 L528 186"
            fill="none"
            stroke="#111"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <circle className="code-whip-tip-dot" cx="530" cy="188" r="4" fill="#111" />
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
