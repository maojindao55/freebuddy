import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { ChevronDown, FolderLock } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CLIMember } from "@/config/aiMembers";
import { useConversationStore } from "@/store/conversationStore";
import { useAgentBridgeStore } from "@/store/agentBridgeStore";
import { cliClient } from "@/services/cli/client";
import type {
  Conversation,
  HandoffBrief,
  PreviewHandoffBriefResult
} from "@/services/cli/types";

interface TransferConversationPanelProps {
  source: Conversation;
  members: CLIMember[];
  titleId: string;
  descriptionId: string;
  onClose(): void;
  onBusyChange?(busy: boolean): void;
}

export function TransferConversationPanel({
  source,
  members,
  titleId,
  descriptionId,
  onClose,
  onBusyChange
}: TransferConversationPanelProps) {
  const { t } = useTranslation();
  const transferConversation = useConversationStore((s) => s.transferConversation);
  const notify = useAgentBridgeStore((s) => s.notify);
  const targetSelectRef = useRef<HTMLSelectElement>(null);
  const mountedRef = useRef(true);
  const previewLoadingRef = useRef(false);
  const [targetMemberId, setTargetMemberId] = useState<string>("");
  const [preview, setPreview] = useState<PreviewHandoffBriefResult | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    targetSelectRef.current?.focus();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    onBusyChange?.(submitting);
  }, [submitting, onBusyChange]);

  const loadPreview = async () => {
    if (preview || previewLoadingRef.current || previewError) return;
    previewLoadingRef.current = true;
    setPreviewLoading(true);
    try {
      const result = await cliClient.previewHandoffBrief({
        sourceConversationId: source.id
      });
      if (mountedRef.current) setPreview(result);
    } catch {
      if (mountedRef.current) setPreviewError(true);
    } finally {
      previewLoadingRef.current = false;
      if (mountedRef.current) setPreviewLoading(false);
    }
  };

  const togglePreview = () => {
    const next = !showPreview;
    setShowPreview(next);
    if (next) void loadPreview();
  };

  const targetMember = useMemo(
    () => members.find((m) => m.id === targetMemberId),
    [members, targetMemberId]
  );

  const onConfirm = async () => {
    if (!targetMember) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await transferConversation({
        sourceConversationId: source.id,
        targetMember
      });
      if (result.warning === "brief_extraction_failed") {
        notify(t("handoff.briefExtractionFailed"));
      }
      if (result.startError) {
        notify(t("handoff.autoStartFailed", { error: result.startError }));
      }
      onClose();
    } catch (e) {
      setError((e as Error).message || String(e));
      setSubmitting(false);
    }
  };

  return (
    <>
      <h3 id={titleId}>{t("handoff.dialogTitle")}</h3>
      <p id={descriptionId} className="transfer-dialog-subtitle">
        {t("handoff.dialogSubtitle", {
          title: source.title,
          agentName: source.agentName
        })}
      </p>

      <label className="transfer-dialog-field">
        <span>{t("handoff.targetAgent")}</span>
        <div className="transfer-dialog-select-wrap">
          <select
            ref={targetSelectRef}
            value={targetMemberId}
            onChange={(e) => setTargetMemberId(e.target.value)}
            disabled={submitting}
          >
            <option value="" disabled>
              {t("handoff.selectAgent")}
            </option>
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
          <ChevronDown
            className="transfer-dialog-select-chevron"
            size={16}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </div>
      </label>

      <label className="transfer-dialog-field">
        <span>{t("handoff.workspace")}</span>
        <div className="transfer-dialog-readonly-wrap">
          <FolderLock size={16} strokeWidth={1.7} aria-hidden="true" />
          <input
            type="text"
            value={source.cwd ?? t("chat.noWorkspace")}
            readOnly
            aria-readonly="true"
            title={source.cwd}
          />
        </div>
      </label>

      <div className="transfer-dialog-preview-toggle">
        <button
          type="button"
          className="link-button"
          onClick={togglePreview}
          aria-expanded={showPreview}
        >
          <ChevronDown
            className={`transfer-dialog-preview-chevron${showPreview ? " expanded" : ""}`}
            size={15}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          {showPreview ? t("handoff.hidePreview") : t("handoff.showPreview")}
        </button>
      </div>
      {showPreview && (
        <BriefPreview
          preview={preview}
          error={previewError}
          loading={previewLoading}
        />
      )}

      {error && <div className="transfer-dialog-error">{error}</div>}

      <div className="transfer-dialog-actions">
        <button type="button" onClick={onClose} disabled={submitting}>
          {t("handoff.cancel")}
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void onConfirm()}
          disabled={!targetMember || submitting}
        >
          {submitting ? t("handoff.transferring") : t("handoff.transfer")}
        </button>
      </div>
    </>
  );
}

interface TransferDialogProps {
  source: Conversation;
  members: CLIMember[];
  onClose(): void;
}

/** @deprecated Prefer ConversationContextDialog; kept for isolated transfer flows. */
export function TransferDialog({ source, members, onClose }: TransferDialogProps) {
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

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onClose();
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
        className="modal transfer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleDialogKeyDown}
      >
        <TransferConversationPanel
          source={source}
          members={members}
          titleId={titleId}
          descriptionId={descriptionId}
          onClose={onClose}
          onBusyChange={setBusy}
        />
      </div>
    </div>
  );
}

function BriefPreview({
  preview,
  error,
  loading
}: {
  preview: PreviewHandoffBriefResult | null;
  error: boolean;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="transfer-dialog-preview-loading" role="status">
        {t("handoff.previewLoading")}
      </div>
    );
  }
  if (error) {
    return (
      <div className="transfer-dialog-preview-warning">
        {t("handoff.previewUnavailable")}
      </div>
    );
  }
  if (!preview) return null;
  const brief: HandoffBrief | null = preview.brief;
  const hasContent = Boolean(
    brief &&
      (brief.originalGoal ||
        brief.recentUserMessages.length ||
        brief.lastAssistantSummary ||
        brief.fileChanges.length)
  );
  if (!brief || !hasContent) {
    return (
      <div className="transfer-dialog-preview-warning">
        {t("handoff.previewEmpty")}
      </div>
    );
  }
  return (
    <div className="transfer-dialog-preview">
      {brief.originalGoal && (
        <PreviewSection title={t("handoff.originalGoal")}>
          <p>{brief.originalGoal}</p>
        </PreviewSection>
      )}
      {brief.recentUserMessages.length > 0 && (
        <PreviewSection title={t("handoff.recentMessages")}>
          <ul>
            {brief.recentUserMessages.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </PreviewSection>
      )}
      {brief.lastAssistantSummary && (
        <PreviewSection title={t("handoff.assistantSummary")}>
          <p>{brief.lastAssistantSummary}</p>
        </PreviewSection>
      )}
      {brief.fileChanges.length > 0 && (
        <PreviewSection
          title={t("handoff.filesChanged", { count: brief.fileChanges.length })}
        >
          <ul className="transfer-dialog-file-list">
            {brief.fileChanges.map((change) => (
              <li key={`${change.action}:${change.path}`}>
                <code>{change.path}</code>
                <span>{change.action}</span>
              </li>
            ))}
          </ul>
        </PreviewSection>
      )}
    </div>
  );
}

function PreviewSection({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="transfer-dialog-preview-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}
