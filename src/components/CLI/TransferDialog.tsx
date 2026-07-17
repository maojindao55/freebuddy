import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CLIMember } from "@/config/aiMembers";
import { useConversationStore } from "@/store/conversationStore";
import { cliClient } from "@/services/cli/client";
import type {
  Conversation,
  HandoffBrief,
  PreviewHandoffBriefResult
} from "@/services/cli/types";

interface TransferDialogProps {
  source: Conversation;
  members: CLIMember[];
  onClose(): void;
}

export function TransferDialog({ source, members, onClose }: TransferDialogProps) {
  const { t } = useTranslation();
  const transferConversation = useConversationStore((s) => s.transferConversation);
  const [targetMemberId, setTargetMemberId] = useState<string>("");
  const [cwd, setCwd] = useState<string>(source.cwd ?? "");
  const [preview, setPreview] = useState<PreviewHandoffBriefResult | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    cliClient
      .previewHandoffBrief({ sourceConversationId: source.id })
      .then((res) => {
        if (cancelled) return;
        setPreview(res);
      })
      .catch(() => {
        if (cancelled) return;
        setPreviewError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source.id]);

  const targetMember = useMemo(
    () => members.find((m) => m.id === targetMemberId),
    [members, targetMemberId]
  );

  const cwdMismatch = Boolean(source.cwd) && Boolean(cwd) && source.cwd !== cwd;

  const onConfirm = async () => {
    if (!targetMember) return;
    if (cwdMismatch) {
      const ok = window.confirm(t("handoff.cwdMismatchConfirm"));
      if (!ok) return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await transferConversation({
        sourceConversationId: source.id,
        targetMember,
        cwd: cwd.trim() || undefined
      });
      if (result.warning === "brief_extraction_failed") {
        // Don't block; just log. The new conversation is created without context.
        console.warn("[FreeBuddy] Transfer completed but brief extraction failed");
      }
      onClose();
    } catch (e) {
      setError((e as Error).message || String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="transfer-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="transfer-dialog">
        <h3>{t("handoff.dialogTitle")}</h3>
        <p className="transfer-dialog-subtitle">
          {t("handoff.dialogSubtitle", {
            title: source.title,
            agentName: source.agentName
          })}
        </p>

        <label className="transfer-dialog-field">
          <span>{t("handoff.targetAgent")}</span>
          <select
            value={targetMemberId}
            onChange={(e) => setTargetMemberId(e.target.value)}
            disabled={submitting}
          >
            <option value="">{t("handoff.selectAgent")}</option>
            {members.map((m) => (
              <option
                key={m.id}
                value={m.id}
                disabled={m.id === source.agentId}
              >
                {m.name}
                {m.id === source.agentId ? ` (${t("handoff.current")})` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="transfer-dialog-field">
          <span>{t("handoff.workspace")}</span>
          <input
            type="text"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            disabled={submitting}
          />
        </label>

        <div className="transfer-dialog-preview-toggle">
          <button
            type="button"
            className="link-button"
            onClick={() => setShowPreview((v) => !v)}
          >
            {showPreview ? t("handoff.hidePreview") : t("handoff.showPreview")}
          </button>
        </div>
        {showPreview && (
          <BriefPreview preview={preview} error={previewError} />
        )}

        {error && <div className="transfer-dialog-error">{error}</div>}

        <div className="transfer-dialog-actions">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            {t("handoff.cancel")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={onConfirm}
            disabled={!targetMember || submitting}
          >
            {submitting ? t("handoff.transferring") : t("handoff.transfer")}
          </button>
        </div>
      </div>
    </div>
  );
}

function BriefPreview({
  preview,
  error
}: {
  preview: PreviewHandoffBriefResult | null;
  error: boolean;
}) {
  const { t } = useTranslation();
  if (error) {
    return (
      <div className="transfer-dialog-preview-warning">
        {t("handoff.previewUnavailable")}
      </div>
    );
  }
  if (!preview) return null;
  const brief: HandoffBrief | null = preview.brief;
  if (!brief) {
    return (
      <div className="transfer-dialog-preview-warning">
        {t("handoff.previewEmpty")}
      </div>
    );
  }
  return (
    <pre className="transfer-dialog-preview">
      {JSON.stringify(brief, null, 2)}
    </pre>
  );
}
