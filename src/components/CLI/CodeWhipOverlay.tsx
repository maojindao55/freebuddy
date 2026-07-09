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
            <linearGradient id="whip-tip-grad" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0%" stopColor="#6b4220" />
              <stop offset="100%" stopColor="#2a1a0c" />
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

          {/* Shorter tip — stays inside viewBox during wind-up */}
          <g className="code-whip-tip">
            <path
              className="code-whip-cord"
              d="M430 152 C370 120, 310 98, 250 96 C190 94, 140 112, 100 140 C70 162, 48 188, 32 214"
              fill="none"
              stroke="url(#whip-tip-grad)"
              strokeWidth="3.4"
              strokeLinecap="round"
            >
              <animate
                attributeName="d"
                dur="2.3s"
                fill="freeze"
                calcMode="spline"
                keyTimes="0;0.2;0.35;0.48;0.58;0.75;1"
                keySplines="0.4 0 0.2 1;0.4 0 0.2 1;0.4 0 0.2 1;0.2 0 0.1 1;0.4 0 0.2 1;0.4 0 0.2 1"
                values="
M430 152 C380 138, 330 132, 280 136 C230 140, 185 156, 145 178 C115 196, 90 218, 70 240;
M430 152 C372 118, 314 96, 256 94 C198 92, 148 112, 108 142 C80 164, 56 192, 38 218;
M430 152 C368 128, 308 108, 248 104 C188 100, 138 120, 98 150 C70 172, 48 198, 30 222;
M430 152 C374 116, 316 94, 254 90 C192 86, 140 108, 98 140 C68 164, 44 194, 26 220;
M430 152 C370 120, 310 98, 250 96 C190 94, 140 112, 100 140 C70 162, 48 188, 32 214;
M430 152 C374 124, 316 104, 256 100 C196 96, 146 116, 106 146 C78 168, 56 194, 38 218;
M430 152 C378 130, 324 112, 268 110 C212 108, 164 126, 124 152 C98 170, 78 192, 62 214
"
              />
            </path>
            <g className="code-whip-cracker">
              <path
                d="M40 208 L18 228"
                fill="none"
                stroke="#3f2410"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
              <path
                d="M40 212 L14 234"
                fill="none"
                stroke="#2a1a0c"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <circle cx="20" cy="226" r="3" fill="#1a1008" />
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
