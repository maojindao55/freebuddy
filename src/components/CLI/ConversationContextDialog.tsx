import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowLeftRight, Link2, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CLIMember } from "@/config/aiMembers";
import type { Conversation } from "@/services/cli/types";
import { ShareConversationPanel } from "./ShareConversationDialog";
import { TransferConversationPanel } from "./TransferDialog";

type ContextDialogMode = "choose" | "share" | "transfer";

interface ConversationContextDialogProps {
  source: Conversation;
  members: CLIMember[];
  onClose(): void;
}

export function ConversationContextDialog({
  source,
  members,
  onClose
}: ConversationContextDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [mode, setMode] = useState<ContextDialogMode>("choose");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      if (mode === "choose") onClose();
      else setMode("choose");
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
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
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal transfer-dialog conversation-context-dialog${mode === "share" ? " share-conversation-dialog" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {mode === "choose" ? (
          <>
            <div className="share-conversation-heading">
              <div className="share-conversation-icon" aria-hidden="true">
                <Share2 size={19} />
              </div>
              <div>
                <h3 id={titleId}>{t("conversationContext.dialogTitle")}</h3>
                <p id={descriptionId}>
                  {t("conversationContext.dialogSubtitle", {
                    title: source.title,
                    agentName: source.agentName
                  })}
                </p>
              </div>
            </div>

            <div className="conversation-context-options" role="group">
              <button
                type="button"
                className="conversation-context-option"
                onClick={() => setMode("share")}
              >
                <span className="conversation-context-option-icon" aria-hidden="true">
                  <Link2 size={18} strokeWidth={1.8} />
                </span>
                <span className="conversation-context-option-copy">
                  <strong>{t("conversationContext.shareOptionTitle")}</strong>
                  <span>{t("conversationContext.shareOptionDescription")}</span>
                </span>
              </button>
              <button
                type="button"
                className="conversation-context-option"
                onClick={() => setMode("transfer")}
              >
                <span className="conversation-context-option-icon" aria-hidden="true">
                  <ArrowLeftRight size={18} strokeWidth={1.8} />
                </span>
                <span className="conversation-context-option-copy">
                  <strong>{t("conversationContext.transferOptionTitle")}</strong>
                  <span>{t("conversationContext.transferOptionDescription")}</span>
                </span>
              </button>
            </div>

            <div className="transfer-dialog-actions">
              <button type="button" onClick={onClose}>
                {t("handoff.cancel")}
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              className="conversation-context-back"
              disabled={busy}
              onClick={() => setMode("choose")}
            >
              <ArrowLeft size={15} strokeWidth={1.8} aria-hidden="true" />
              {t("conversationContext.back")}
            </button>
            {mode === "share" ? (
              <ShareConversationPanel
                source={source}
                titleId={titleId}
                descriptionId={descriptionId}
                onClose={onClose}
                onBusyChange={setBusy}
              />
            ) : (
              <TransferConversationPanel
                source={source}
                members={members}
                titleId={titleId}
                descriptionId={descriptionId}
                onClose={onClose}
                onBusyChange={setBusy}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
