import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { createPortal } from "react-dom";
import { AlarmClock, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cliClient } from "@/services/cli/client";
import type { ScheduledSend } from "@/store/scheduledSendStore";
import {
  SCHEDULED_SEND_PRESET_MINUTES,
  SCHEDULED_SEND_RESET_BUFFER_MS,
  formatCountdown,
  formatScheduledFireTime,
  isValidScheduledFireAt,
  parseDateTimeLocalInputValue,
  pickCodexUsageResetAt,
  presetFireAt,
  supportsCodexUsageReset,
  toDateTimeLocalInputValue
} from "@/utils/scheduledSend";

type PanelPosition = {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
};

function computePanelPosition(trigger: HTMLElement): PanelPosition {
  const width = 280;
  const gap = 8;
  const rect = trigger.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, rect.right - width),
    window.innerWidth - width - 8
  );
  const spaceAbove = rect.top - gap - 8;
  const spaceBelow = window.innerHeight - rect.bottom - gap - 8;
  if (spaceAbove >= 260 || spaceAbove >= spaceBelow) {
    return { bottom: window.innerHeight - rect.top + gap, left, width };
  }
  return { top: rect.bottom + gap, left, width };
}

type CodexResetState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; fireAt: number }
  | { kind: "unavailable" };

type ControlProps = {
  adapter?: string;
  disabled?: boolean;
  /** False when the composer has nothing (text or attachments) to schedule yet. */
  canSchedule: boolean;
  onSchedule: (fireAt: number) => void;
};

export function ScheduledSendControl({
  adapter,
  disabled,
  canSchedule,
  onSchedule
}: ControlProps) {
  const { t, i18n } = useTranslation();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const [customValue, setCustomValue] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const [codexReset, setCodexReset] = useState<CodexResetState>({ kind: "idle" });
  const showCodexReset = supportsCodexUsageReset(adapter);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setPosition(null);
      return;
    }
    const update = () => {
      if (triggerRef.current) setPosition(computePanelPosition(triggerRef.current));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) {
      setCustomError(null);
      return;
    }
    setCustomValue(toDateTimeLocalInputValue(Date.now() + 60 * 60_000));
    if (!showCodexReset || !cliClient.isAvailable()) {
      setCodexReset({ kind: "idle" });
      return;
    }
    let active = true;
    setCodexReset({ kind: "loading" });
    cliClient
      .codexUsage()
      .then((result) => {
        if (!active) return;
        const resetAt = result.ok
          ? pickCodexUsageResetAt(result.windows)
          : undefined;
        setCodexReset(
          resetAt === undefined
            ? { kind: "unavailable" }
            : { kind: "ready", fireAt: resetAt + SCHEDULED_SEND_RESET_BUFFER_MS }
        );
      })
      .catch(() => {
        if (active) setCodexReset({ kind: "unavailable" });
      });
    return () => {
      active = false;
    };
  }, [open, showCodexReset]);

  const commit = (fireAt: number) => {
    if (!canSchedule) return;
    onSchedule(fireAt);
    setOpen(false);
  };

  const commitCustom = () => {
    const fireAt = parseDateTimeLocalInputValue(customValue);
    if (!isValidScheduledFireAt(fireAt)) {
      setCustomError(t("scheduledSend.customInvalid"));
      return;
    }
    commit(fireAt);
  };

  const panelStyle: CSSProperties | undefined = position
    ? {
        top: position.top,
        bottom: position.bottom,
        left: position.left,
        width: position.width
      }
    : undefined;

  return (
    <div className="scheduled-send" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`scheduled-send-trigger${open ? " open" : ""}`}
        title={t("scheduledSend.trigger")}
        aria-label={t("scheduledSend.trigger")}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <AlarmClock aria-hidden="true" size={16} strokeWidth={1.8} />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              className="scheduled-send-panel"
              role="dialog"
              aria-label={t("scheduledSend.trigger")}
              style={panelStyle}
            >
              <div className="scheduled-send-panel-title">
                {t("scheduledSend.panelTitle")}
              </div>
              <div className="scheduled-send-panel-hint">
                {t("scheduledSend.panelHint")}
              </div>
              {!canSchedule ? (
                <div className="scheduled-send-needs-draft">
                  {t("scheduledSend.triggerNeedsDraft")}
                </div>
              ) : null}
              <div className="scheduled-send-section-label">
                {t("scheduledSend.presetsLabel")}
              </div>
              <div className="scheduled-send-presets">
                {SCHEDULED_SEND_PRESET_MINUTES.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className="scheduled-send-preset"
                    disabled={!canSchedule}
                    onClick={() => commit(presetFireAt(minutes))}
                  >
                    {minutes >= 60
                      ? t("scheduledSend.presetHours", { count: minutes / 60 })
                      : t("scheduledSend.presetMinutes", { count: minutes })}
                  </button>
                ))}
              </div>
              {showCodexReset ? (
                <>
                  <div className="scheduled-send-section-label">
                    {t("scheduledSend.quotaResetLabel")}
                  </div>
                  {codexReset.kind === "ready" ? (
                    <button
                      type="button"
                      className="scheduled-send-preset scheduled-send-preset-reset"
                      disabled={!canSchedule}
                      onClick={() => commit(codexReset.fireAt)}
                    >
                      {t("scheduledSend.quotaResetAt", {
                        time: formatScheduledFireTime(
                          codexReset.fireAt,
                          Date.now(),
                          i18n.language
                        )
                      })}
                    </button>
                  ) : (
                    <div className="scheduled-send-muted">
                      {codexReset.kind === "loading"
                        ? t("scheduledSend.quotaResetLoading")
                        : t("scheduledSend.quotaResetUnavailable")}
                    </div>
                  )}
                </>
              ) : null}
              <div className="scheduled-send-section-label">
                {t("scheduledSend.customLabel")}
              </div>
              <div className="scheduled-send-custom">
                <input
                  type="datetime-local"
                  className="scheduled-send-custom-input"
                  aria-label={t("scheduledSend.customLabel")}
                  value={customValue}
                  min={toDateTimeLocalInputValue(Date.now())}
                  onChange={(event) => {
                    setCustomValue(event.target.value);
                    setCustomError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitCustom();
                    }
                  }}
                />
                <button
                  type="button"
                  className="scheduled-send-custom-confirm"
                  disabled={!canSchedule}
                  onClick={commitCustom}
                >
                  {t("scheduledSend.customConfirm")}
                </button>
              </div>
              {customError ? (
                <div className="scheduled-send-error">{customError}</div>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

type MetaProps = {
  entry: ScheduledSend;
  now: number;
  onSendNow: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onCancel: () => void;
};

/** Compact countdown row rendered under the scheduled message bubble. */
export function ScheduledSendMeta({
  entry,
  now,
  onSendNow,
  onRetry,
  onEdit,
  onCancel
}: MetaProps) {
  const { t, i18n } = useTranslation();
  const fireTime = formatScheduledFireTime(entry.fireAt, now, i18n.language);

  let statusText: string;
  switch (entry.status) {
    case "waiting":
      statusText = t("scheduledSend.statusWaiting");
      break;
    case "sending":
      statusText = t("scheduledSend.statusSending");
      break;
    case "failed":
      statusText = t("scheduledSend.statusFailed", { err: entry.error ?? "" });
      break;
    default:
      statusText = t("scheduledSend.statusPending", {
        time: fireTime,
        countdown: formatCountdown(entry.fireAt - now)
      });
  }

  const busy = entry.status === "sending";

  return (
    <div
      className={`scheduled-send-meta scheduled-send-meta-${entry.status}`}
      role="status"
      title={entry.status === "pending" ? t("scheduledSend.keepAppOpen") : undefined}
    >
      <AlarmClock aria-hidden="true" size={13} strokeWidth={1.9} />
      <span className="scheduled-send-meta-status">{statusText}</span>
      {busy ? null : (
        <span className="scheduled-send-meta-actions">
          {entry.status === "failed" ? (
            <button type="button" onClick={onRetry}>
              {t("scheduledSend.retry")}
            </button>
          ) : (
            <button type="button" onClick={onSendNow}>
              {t("scheduledSend.sendNow")}
            </button>
          )}
          <button type="button" onClick={onEdit}>
            {t("scheduledSend.edit")}
          </button>
          <button
            type="button"
            className="scheduled-send-meta-cancel"
            aria-label={t("scheduledSend.cancel")}
            title={t("scheduledSend.cancel")}
            onClick={onCancel}
          >
            <X aria-hidden="true" size={12} strokeWidth={2.2} />
          </button>
        </span>
      )}
    </div>
  );
}
