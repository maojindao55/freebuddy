import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { useTranslation } from "react-i18next";

import { useConversationStore } from "@/store/conversationStore";
import { useAgentBridgeStore } from "@/store/agentBridgeStore";

interface ImportCodexSessionDialogProps {
  initialSessionId?: string;
  onClose(): void;
}

export function ImportCodexSessionDialog({
  initialSessionId = "",
  onClose
}: ImportCodexSessionDialogProps) {
  const { t } = useTranslation();
  const importCodexSession = useConversationStore((s) => s.importCodexSession);
  const notify = useAgentBridgeStore((s) => s.notify);
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    inputRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  const trimmed = sessionId.trim();
  const looksLikeValidId = /^[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}$/.test(
    trimmed
  );

  const onConfirm = async () => {
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await importCodexSession(trimmed);
      if (result.warning === "resume_session_not_linked") {
        notify(t("importCodex.resumeNotLinked"));
      } else if (result.created) {
        notify(
          t("importCodex.imported", {
            turns: result.turns,
            messages: result.messages
          })
        );
      } else {
        notify(t("importCodex.alreadyImported"));
      }
      onClose();
    } catch (e) {
      setError((e as Error).message || String(e));
      setSubmitting(false);
    }
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !submitting) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="modal-backdrop transfer-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal transfer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleDialogKeyDown}
      >
        <h3 id={titleId}>{t("importCodex.dialogTitle")}</h3>
        <p id={descriptionId} className="transfer-dialog-subtitle">
          {t("importCodex.dialogSubtitle")}
        </p>

        <label className="transfer-dialog-field">
          <span>{t("importCodex.sessionId")}</span>
          <input
            ref={inputRef}
            type="text"
            className="transfer-dialog-input"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder={t("importCodex.sessionIdPlaceholder")}
            disabled={submitting}
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === "Enter" && looksLikeValidId && !submitting) {
                e.preventDefault();
                void onConfirm();
              }
            }}
          />
        </label>

        {error && <div className="transfer-dialog-error">{error}</div>}

        <div className="transfer-dialog-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            {t("importCodex.cancel")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void onConfirm()}
            disabled={!looksLikeValidId || submitting}
          >
            {submitting ? t("importCodex.importing") : t("importCodex.import")}
          </button>
        </div>
      </div>
    </div>
  );
}
