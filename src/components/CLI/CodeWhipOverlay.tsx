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
            <linearGradient id="whip-tip-grad" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0%" stopColor="#6b4220" />
              <stop offset="100%" stopColor="#2a1a0c" />
            </linearGradient>
          </defs>

          {/* Short straight handle on the right */}
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

          {/* Long thin tip with snake-wave path morph — always visible */}
          <g className="code-whip-tip">
            <path
              className="code-whip-cord"
              d="M586 194 C500 150, 420 112, 340 98 C260 84, 180 96, 110 130 C50 160, 0 204, -40 250 C-70 284, -104 318, -140 348"
              fill="none"
              stroke="url(#whip-tip-grad)"
              strokeWidth="3.6"
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
M586 194 C530 170, 470 156, 410 158 C350 160, 290 178, 230 206 C170 234, 110 270, 50 308 C20 328, -10 344, -40 356;
M586 194 C505 145, 435 108, 365 96 C295 84, 225 100, 155 138 C95 170, 35 216, -15 262 C-45 290, -80 320, -118 346;
M586 194 C495 158, 420 128, 345 114 C270 100, 195 116, 125 154 C65 186, 10 230, -35 274 C-65 300, -98 328, -132 350;
M586 194 C508 142, 432 102, 352 88 C272 74, 192 90, 120 130 C58 164, 2 214, -42 262 C-72 292, -108 326, -146 354;
M586 194 C500 150, 420 112, 340 98 C260 84, 180 96, 110 130 C50 160, 0 204, -40 250 C-70 284, -104 318, -140 348;
M586 194 C512 156, 432 122, 352 110 C272 98, 192 114, 122 152 C62 184, 12 228, -28 270 C-56 298, -88 328, -124 350;
M586 194 C518 162, 442 132, 366 122 C290 112, 214 130, 144 168 C90 198, 40 238, 0 276 C-24 300, -52 326, -80 346
"
              />
            </path>
            <g className="code-whip-cracker">
              <path
                d="M-118 330 L-162 352"
                fill="none"
                stroke="#3f2410"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <path
                d="M-118 334 L-158 362"
                fill="none"
                stroke="#2a1a0c"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <circle cx="-150" cy="354" r="3.2" fill="#1a1008" />
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
