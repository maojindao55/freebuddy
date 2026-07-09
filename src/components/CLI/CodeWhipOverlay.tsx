import { useTranslation } from "react-i18next";

import { useWhipEffectStore } from "@/store/whipEffectStore";

export function CodeWhipOverlay() {
  const { t } = useTranslation();
  const active = useWhipEffectStore((s) => s.active);
  const nonce = useWhipEffectStore((s) => s.nonce);
  if (!active) return null;

  return (
    <div className="code-whip-overlay" key={nonce} aria-hidden="true">
      <div className="code-whip-flash" />
      <div className="code-whip-stage">
        <svg
          className="code-whip-svg"
          viewBox="0 0 640 360"
          width="640"
          height="360"
        >
          <path
            className="code-whip-handle"
            d="M72 268 L168 214"
            fill="none"
            stroke="#8B5A2B"
            strokeWidth="18"
            strokeLinecap="round"
          />
          <path
            className="code-whip-cord"
            d="M168 214 C268 132, 390 78, 560 96"
            fill="none"
            stroke="#5C3317"
            strokeWidth="10"
            strokeLinecap="round"
          />
          <circle className="code-whip-tip" cx="560" cy="96" r="12" fill="#3f2a14" />
        </svg>
      </div>
      <div className="code-whip-crack">{t("message.whipCrack")}</div>
      <div className="code-whip-spark code-whip-spark-1" />
      <div className="code-whip-spark code-whip-spark-2" />
      <div className="code-whip-spark code-whip-spark-3" />
      <div className="code-whip-spark code-whip-spark-4" />
    </div>
  );
}
