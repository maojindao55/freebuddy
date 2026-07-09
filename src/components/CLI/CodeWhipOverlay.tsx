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

          {/* Segmented tip: wave travels handle → tip */}
          <g className="code-whip-tip code-whip-seg code-whip-seg-1">
            <g className="code-whip-seg code-whip-seg-2">
              <g className="code-whip-seg code-whip-seg-3">
                <g className="code-whip-seg code-whip-seg-4">
                  <path
                    className="code-whip-cord"
                    d="M586 194
                       C500 150, 420 112, 340 98
                       C260 84, 180 96, 110 130
                       C50 160, 0 204, -40 250
                       C-70 284, -104 318, -140 348"
                    fill="none"
                    stroke="#2a1a0c"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                  >
                    <animate
                      attributeName="d"
                      dur="2.3s"
                      fill="freeze"
                      keyTimes="0;0.18;0.32;0.45;0.55;0.72;1"
                      values="
M586 194 C520 168, 460 150, 400 148 C340 146, 280 160, 220 186 C160 212, 100 250, 40 292 C10 314, -20 334, -50 350;
M586 194 C500 140, 430 100, 360 92 C290 84, 220 100, 150 136 C90 168, 30 214, -20 260 C-50 288, -84 318, -120 344;
M586 194 C490 160, 410 130, 330 118 C250 106, 170 120, 100 156 C40 188, -10 232, -50 276 C-78 302, -110 328, -142 350;
M586 194 C505 145, 425 105, 345 90 C265 76, 185 90, 115 128 C55 160, 0 208, -45 256 C-75 288, -110 322, -148 352;
M586 194 C500 150, 420 112, 340 98 C260 84, 180 96, 110 130 C50 160, 0 204, -40 250 C-70 284, -104 318, -140 348;
M586 194 C510 155, 430 120, 350 108 C270 96, 190 110, 120 148 C60 180, 10 224, -30 268 C-58 296, -90 326, -128 350;
M586 194 C515 160, 440 130, 365 120 C290 110, 215 128, 145 164 C90 194, 40 234, 0 272 C-24 296, -52 322, -80 344
"
                    />
                  </path>
                  <g className="code-whip-cracker">
                    <path
                      d="M-118 330 L-158 348"
                      fill="none"
                      stroke="#3f2410"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                    <path
                      d="M-118 334 L-154 360"
                      fill="none"
                      stroke="#2a1a0c"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                    <circle
                      className="code-whip-tip-dot"
                      cx="-148"
                      cy="352"
                      r="3"
                      fill="#1a1008"
                    />
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
