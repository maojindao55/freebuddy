import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import {
  REPLAY_BASE_INTERVAL_MS,
  REPLAY_SPEEDS,
  REPLAY_TYPING_INTERVAL_MS,
  useReplayStore
} from "@/store/replayStore";

function PrevIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="18 5 9 12 18 19 18 5" fill="currentColor" />
      <line x1="6" y1="5" x2="6" y2="19" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="6 5 15 12 6 19 6 5" fill="currentColor" />
      <line x1="18" y1="5" x2="18" y2="19" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="7 4 19 12 7 20 7 4" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="7" y="5" width="3" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="3" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}

function ExitIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

export function ReplayBar() {
  const { t } = useTranslation();
  const index = useReplayStore((s) => s.index);
  const total = useReplayStore((s) => s.frames.length);
  const frames = useReplayStore((s) => s.frames);
  const playing = useReplayStore((s) => s.playing);
  const speed = useReplayStore((s) => s.speed);
  const toggle = useReplayStore((s) => s.toggle);
  const next = useReplayStore((s) => s.next);
  const prev = useReplayStore((s) => s.prev);
  const setIndex = useReplayStore((s) => s.setIndex);
  const setSpeed = useReplayStore((s) => s.setSpeed);
  const stop = useReplayStore((s) => s.stop);

  useEffect(() => {
    if (!playing) return;
    const current = frames[index];
    const isTyping = current?.typingChars != null;
    const base = isTyping ? REPLAY_TYPING_INTERVAL_MS : REPLAY_BASE_INTERVAL_MS;
    const interval = Math.max(16, base / speed);
    const id = window.setInterval(() => next(), interval);
    return () => window.clearInterval(id);
  }, [playing, speed, next, frames, index]);

  const safeMax = Math.max(total, 1);
  const atEnd = index >= total - 1;

  return (
    <div className="replay-bar" role="toolbar" aria-label={t("chat.replay.title")}>
      <button
        type="button"
        className="replay-step-btn"
        onClick={prev}
        disabled={index <= -1}
        aria-label={t("chat.replay.prev")}
        title={t("chat.replay.prev")}
      >
        <PrevIcon />
      </button>

      <button
        type="button"
        className="replay-play-btn"
        onClick={toggle}
        disabled={total <= 0}
        aria-label={playing ? t("chat.replay.pause") : t("chat.replay.play")}
        title={playing ? t("chat.replay.pause") : t("chat.replay.play")}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <button
        type="button"
        className="replay-step-btn"
        onClick={next}
        disabled={atEnd}
        aria-label={t("chat.replay.next")}
        title={t("chat.replay.next")}
      >
        <NextIcon />
      </button>

      <input
        type="range"
        className="replay-progress"
        min={0}
        max={safeMax}
        value={Math.min(index + 1, safeMax)}
        onChange={(e) => setIndex(Number(e.target.value) - 1)}
        aria-label={t("chat.replay.progress", { n: index + 1, total })}
      />

      <span className="replay-count">
        {t("chat.replay.progress", { n: Math.max(index + 1, 0), total })}
      </span>

      <label className="replay-speed">
        <span className="sr-only">{t("chat.replay.speed")}</span>
        <select
          value={String(speed)}
          onChange={(e) => setSpeed(Number(e.target.value))}
          aria-label={t("chat.replay.speed")}
        >
          {REPLAY_SPEEDS.map((s) => (
            <option key={s} value={String(s)}>
              {t("chat.replay.speedOption", { speed: s })}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className="replay-exit-btn"
        onClick={stop}
        aria-label={t("chat.replay.exit")}
        title={t("chat.replay.exit")}
      >
        <ExitIcon />
      </button>
    </div>
  );
}
