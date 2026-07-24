import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, Copy, Link2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cliClient } from "@/services/cli/client";
import type {
  Conversation,
  CreateConversationShareResult
} from "@/services/cli/types";

interface ShareConversationPanelProps {
  source: Conversation;
  titleId: string;
  descriptionId: string;
  onClose(): void;
  onBusyChange?(busy: boolean): void;
}

export function ShareConversationPanel({
  source,
  titleId,
  descriptionId,
  onClose,
  onBusyChange
}: ShareConversationPanelProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState<CreateConversationShareResult>();
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    onBusyChange?.(creating);
  }, [creating, onBusyChange]);

  const createLink = async () => {
    setCreating(true);
    setError(undefined);
    try {
      setResult(
        await cliClient.createConversationShare({
          sourceConversationId: source.id
        })
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const copyLink = async () => {
    if (!result?.link) return;
    try {
      await navigator.clipboard.writeText(result.link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <>
      <div className="share-conversation-heading">
        <div className="share-conversation-icon" aria-hidden="true">
          <Link2 size={19} />
        </div>
        <div>
          <h3 id={titleId}>{t("contextShare.dialogTitle")}</h3>
          <p id={descriptionId}>
            {t("contextShare.dialogSubtitle", { title: source.title })}
          </p>
        </div>
      </div>

      <div className="share-conversation-security">
        <ShieldCheck size={17} aria-hidden="true" />
        <span>{t("contextShare.localOnlyDescription")}</span>
      </div>

      {result ? (
        <>
          <label className="share-conversation-link-field">
            <span>{t("contextShare.linkLabel")}</span>
            <div>
              <input value={result.link} readOnly aria-readonly="true" />
              <button type="button" onClick={() => void copyLink()}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? t("contextShare.copied") : t("contextShare.copy")}
              </button>
            </div>
          </label>
          <p className="share-conversation-meta">
            {t("contextShare.snapshotMeta", {
              count: result.source.messageCount,
              state: result.transcriptTruncated
                ? t("contextShare.truncated")
                : t("contextShare.complete")
            })}
          </p>
        </>
      ) : (
        <p className="share-conversation-explainer">
          {t("contextShare.createDescription")}
        </p>
      )}

      {error && <div className="transfer-dialog-error">{error}</div>}

      <div className="transfer-dialog-actions">
        <button type="button" onClick={onClose} disabled={creating}>
          {result ? t("common.close") : t("handoff.cancel")}
        </button>
        {!result && (
          <button
            type="button"
            className="primary"
            onClick={() => void createLink()}
            disabled={creating}
          >
            {creating
              ? t("contextShare.creating")
              : t("contextShare.createLink")}
          </button>
        )}
      </div>
    </>
  );
}

interface ShareConversationDialogProps {
  source: Conversation;
  onClose(): void;
}

/** @deprecated Prefer ConversationContextDialog; kept for isolated share flows. */
export function ShareConversationDialog({
  source,
  onClose
}: ShareConversationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
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
      className="modal-backdrop share-conversation-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal share-conversation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <ShareConversationPanel
          source={source}
          titleId={titleId}
          descriptionId={descriptionId}
          onClose={onClose}
          onBusyChange={setBusy}
        />
      </div>
    </div>
  );
}
