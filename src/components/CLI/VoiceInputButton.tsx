import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Check, LoaderCircle, Mic, X } from "lucide-react";
import { speechClient } from "@/services/speech/client";
import { SpeechRecorder } from "@/services/speech/recorder";
import { useSpeechStore } from "@/store/speechStore";
import "./VoiceControls.css";

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function insertTextAtCursor(
  draft: string,
  inserted: string,
  textarea: HTMLTextAreaElement | null
): { nextDraft: string; caretPos: number } {
  const clean = inserted.trim();
  if (!clean) return { nextDraft: draft, caretPos: draft.length };
  if (!textarea) {
    const sep = draft && !/\s$/.test(draft) ? " " : "";
    const nextDraft = `${draft}${sep}${clean}`;
    return { nextDraft, caretPos: nextDraft.length };
  }
  const start = textarea.selectionStart ?? draft.length;
  const end = textarea.selectionEnd ?? draft.length;
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const leadSep = before && !/\s$/.test(before) ? " " : "";
  const trailSep = after && !/^\s/.test(after) ? " " : "";
  const nextDraft = `${before}${leadSep}${clean}${trailSep}${after}`;
  const caretPos = before.length + leadSep.length + clean.length;
  return { nextDraft, caretPos };
}

export interface VoiceInputButtonProps {
  draft: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onDraft: (next: string) => void;
  onAutoSend?: () => void;
  onOpenSpeechSettings?: () => void;
  disabled?: boolean;
  compact?: boolean;
}

export function VoiceInputButton({
  draft,
  textareaRef,
  onDraft,
  onAutoSend,
  onOpenSpeechSettings,
  disabled = false,
  compact = false,
}: VoiceInputButtonProps) {
  const { t } = useTranslation();
  const available = speechClient.isAvailable();
  const loaded = useSpeechStore((s) => s.loaded);
  const load = useSpeechStore((s) => s.load);
  const activeAsrProvider = useSpeechStore((s) => s.config?.preferences.activeAsrProvider ?? null);
  const asrAfterTranscribe = useSpeechStore(
    (s) => s.config?.preferences.asrAfterTranscribe ?? "insert"
  );
  const transcribe = useSpeechStore((s) => s.transcribe);

  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<SpeechRecorder | null>(null);
  const activeReqIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const pendingAutoSendRef = useRef(false);

  useEffect(() => {
    if (available && !loaded) {
      void load();
    }
  }, [available, loaded, load]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recorderRef.current?.cancel();
      recorderRef.current = null;
      if (activeReqIdRef.current && speechClient.isAvailable()) {
        void speechClient.cancel(activeReqIdRef.current).catch(() => {});
        activeReqIdRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!pendingAutoSendRef.current) return;
    pendingAutoSendRef.current = false;
    if (draft.trim()) {
      onAutoSend?.();
    }
  }, [draft, onAutoSend]);

  const finishRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || !recorder.isRecording) return;
    setPhase("transcribing");
    setLevel(0);

    try {
      const { wav, durationMs } = await recorder.stop();
      if (!mountedRef.current) return;
      if (wav.byteLength <= 44 || durationMs < 250) {
        setPhase("idle");
        setError(t("speech.recordingTooShort"));
        return;
      }

      const reqId = `asr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      activeReqIdRef.current = reqId;
      const result = await transcribe(wav, { requestId: reqId, mimeType: "audio/wav" });
      if (!mountedRef.current || activeReqIdRef.current !== reqId) return;
      activeReqIdRef.current = null;

      const text = result.text.trim();
      if (!text) {
        setPhase("idle");
        setError(t("speech.emptyTranscript"));
        return;
      }

      const { nextDraft, caretPos } = insertTextAtCursor(
        draftRef.current,
        text,
        textareaRef.current
      );
      if (asrAfterTranscribe === "send" && onAutoSend) {
        pendingAutoSendRef.current = true;
      }
      onDraft(nextDraft);
      setPhase("idle");
      setError(null);

      window.setTimeout(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        try {
          el.setSelectionRange(caretPos, caretPos);
        } catch {
          // ignore
        }
      }, 0);
    } catch (err) {
      if (!mountedRef.current) return;
      activeReqIdRef.current = null;
      const message = err instanceof Error ? err.message : String(err);
      setPhase("idle");
      if (!/cancelled/i.test(message)) {
        setError(message);
      }
    }
  }, [asrAfterTranscribe, onAutoSend, onDraft, t, textareaRef, transcribe]);

  const cancelActive = useCallback(() => {
    if (phase === "recording") {
      recorderRef.current?.cancel();
      setPhase("idle");
      setLevel(0);
      setElapsedMs(0);
      return;
    }
    if (phase === "transcribing" && activeReqIdRef.current) {
      const reqId = activeReqIdRef.current;
      activeReqIdRef.current = null;
      void speechClient.cancel(reqId).catch(() => {});
      setPhase("idle");
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== "recording") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelActive();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [phase, cancelActive]);

  const startRecording = async () => {
    if (disabled || phase !== "idle") return;
    setError(null);

    if (!activeAsrProvider) {
      onOpenSpeechSettings?.();
      return;
    }

    try {
      const statusRes = await speechClient.microphoneStatus();
      if (statusRes.status === "not-determined") {
        const reqRes = await speechClient.requestMicrophone();
        if (!reqRes.granted) {
          setError(t("speech.micDenied"));
          return;
        }
      } else if (statusRes.status === "denied" || statusRes.status === "restricted") {
        setError(t("speech.micDenied"));
        return;
      }

      if (!recorderRef.current) {
        recorderRef.current = new SpeechRecorder();
      }
      setElapsedMs(0);
      setLevel(0);
      await recorderRef.current.start({
        maxDurationSec: 115,
        onLevel: (lvl) => {
          if (mountedRef.current) setLevel(lvl);
        },
        onElapsed: (ms) => {
          if (mountedRef.current) setElapsedMs(ms);
        },
        onAutoStop: () => {
          void finishRecording();
        },
      });
      if (mountedRef.current) {
        setPhase("recording");
      }
    } catch (err) {
      if (!mountedRef.current) return;
      recorderRef.current?.cancel();
      setPhase("idle");
      const msg = err instanceof Error ? err.message : String(err);
      setError(/denied|permission|notallowed/i.test(msg) ? t("speech.micDenied") : msg);
    }
  };

  if (!available) return null;

  if (phase === "recording") {
    const scaled = Math.min(1, level * 5);
    const heights = [0.45, 0.85, 1, 0.65].map((w) =>
      Math.max(3, Math.round(3 + scaled * 11 * w))
    );
    return (
      <div className="voice-input-wrap">
        <div className="voice-recording-pill" role="status" aria-live="polite">
          <span className="voice-rec-dot" aria-hidden="true" />
          {!compact && (
            <span className="voice-level-bars" aria-hidden="true">
              {heights.map((h, i) => (
                <span key={i} className="voice-level-bar" style={{ height: `${h}px` }} />
              ))}
            </span>
          )}
          <span className="voice-rec-timer">{formatElapsed(elapsedMs)}</span>
          <button
            type="button"
            className="voice-pill-btn confirm"
            title={t("speech.stopRecording")}
            aria-label={t("speech.stopRecording")}
            onClick={() => void finishRecording()}
          >
            <Check size={13} />
          </button>
          <button
            type="button"
            className="voice-pill-btn"
            title={t("speech.cancelRecording")}
            aria-label={t("speech.cancelRecording")}
            onClick={cancelActive}
          >
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  if (phase === "transcribing") {
    return (
      <div className="voice-input-wrap">
        <div className="voice-recording-pill transcribing" role="status" aria-live="polite">
          <LoaderCircle size={13} className="spin" aria-hidden="true" />
          {!compact && <span>{t("speech.transcribing")}</span>}
          <button
            type="button"
            className="voice-pill-btn"
            title={t("speech.cancelTranscribing")}
            aria-label={t("speech.cancelTranscribing")}
            onClick={cancelActive}
          >
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="voice-input-wrap">
      <button
        type="button"
        className={`voice-mic-btn${!activeAsrProvider ? " unconfigured" : ""}`}
        disabled={disabled}
        title={activeAsrProvider ? t("speech.voiceInput") : t("speech.voiceInputSetup")}
        aria-label={activeAsrProvider ? t("speech.voiceInput") : t("speech.voiceInputSetup")}
        onClick={() => void startRecording()}
      >
        <Mic size={15} aria-hidden="true" />
      </button>
      {error && (
        <span className="voice-error-tip" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
