import { useMemo } from "react";

import { useTranslation } from "react-i18next";

import { cliClient } from "@/services/cli/client";
import type { FeedItem } from "@/services/feed/types";
import { useConversationStore } from "@/store/conversationStore";
import { useDraftPreviewStore } from "@/store/draftPreviewStore";

type DraftViewport = "responsive" | "desktop" | "tablet" | "mobile";

const VIEWPORTS: Array<{ key: DraftViewport; labelKey?: string; label?: string }> = [
  { key: "responsive", labelKey: "draft.viewportResponsive" },
  { key: "desktop", label: "1440" },
  { key: "tablet", label: "768" },
  { key: "mobile", label: "390" }
];
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true
};

function isRemoteHttpUrl(value: string | undefined): value is string {
  return /^https?:\/\//i.test(value ?? "");
}

export function DraftToolbar({
  url,
  viewport,
  zoom,
  feedItem,
  feedActionBusy,
  onViewportChange,
  onZoomChange,
  onInterpretFeedItem,
  onMarkFeedItemRead,
  onClose
}: {
  url?: string;
  viewport: DraftViewport;
  zoom: number;
  feedItem?: FeedItem;
  feedActionBusy?: boolean;
  onViewportChange: (viewport: DraftViewport) => void;
  onZoomChange: (zoom: number) => void;
  onInterpretFeedItem?: (item: FeedItem) => void;
  onMarkFeedItemRead?: (item: FeedItem) => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const activeId = useConversationStore((s) => s.activeId);
  const canOpenExternal = Boolean(
    url && (cliClient.isAvailable() || isRemoteHttpUrl(url))
  );

  const openExternal = () => {
    if (!url || !canOpenExternal) return;
    if (cliClient.isAvailable()) {
      void cliClient
        .openDraftExternal(url)
        .then((opened) => {
          if (!opened && isRemoteHttpUrl(url)) {
            window.open(url, "_blank", "noopener,noreferrer");
          }
        })
        .catch(() => {
          if (isRemoteHttpUrl(url)) {
            window.open(url, "_blank", "noopener,noreferrer");
          }
        });
      return;
    }
    if (isRemoteHttpUrl(url)) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const viewportOptions = useMemo(() => VIEWPORTS, []);
  const setZoom = (next: number) => onZoomChange(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));

  return (
    <div className="draft-toolbar">
      <select
        className="draft-viewport-select"
        value={viewport}
        aria-label={t("draft.viewport")}
        onChange={(e) => onViewportChange(e.target.value as DraftViewport)}
      >
        {viewportOptions.map((option) => (
          <option key={option.key} value={option.key}>
            {option.labelKey ? t(option.labelKey) : option.label}
          </option>
        ))}
      </select>
      <div className="draft-zoom-control" aria-label={t("draft.zoom")}>
        <button
          type="button"
          className="draft-action"
          title={t("draft.zoomOut")}
          aria-label={t("draft.zoomOut")}
          onClick={() => setZoom(zoom - 0.1)}
        >
          <svg {...ICON_PROPS} className="draft-action-icon">
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
          type="button"
          className="draft-zoom-value"
          title={t("draft.resetZoom")}
          aria-label={t("draft.resetZoom")}
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="draft-action"
          title={t("draft.zoomIn")}
          aria-label={t("draft.zoomIn")}
          onClick={() => setZoom(zoom + 0.1)}
        >
          <svg {...ICON_PROPS} className="draft-action-icon">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        className="draft-action"
        title={t("draft.refresh")}
        aria-label={t("draft.refresh")}
        onClick={() => activeId && useDraftPreviewStore.getState().reload(activeId)}
      >
        <svg {...ICON_PROPS} className="draft-action-icon">
          <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      </button>
      <button
        type="button"
        className="draft-action"
        title={t("draft.openExternal")}
        aria-label={t("draft.openExternal")}
        disabled={!canOpenExternal}
        onClick={openExternal}
      >
        <svg {...ICON_PROPS} className="draft-action-icon">
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        </svg>
      </button>
      {feedItem && (
        <div className="draft-feed-actions">
          <button
            type="button"
            className="draft-feed-action"
            title={t("draft.feedInterpret")}
            aria-label={t("draft.feedInterpret")}
            disabled={feedActionBusy || !onInterpretFeedItem}
            onClick={() => onInterpretFeedItem?.(feedItem)}
          >
            {t("draft.feedInterpret")}
          </button>
          <button
            type="button"
            className="draft-feed-action"
            title={t("draft.feedMarkRead")}
            aria-label={t("draft.feedMarkRead")}
            disabled={feedActionBusy || Boolean(feedItem.interpretedAt) || !onMarkFeedItemRead}
            onClick={() => onMarkFeedItemRead?.(feedItem)}
          >
            {feedItem.interpretedAt ? t("feed.interpreted") : t("draft.feedMarkRead")}
          </button>
        </div>
      )}
      {onClose && (
        <button
          type="button"
          className="draft-action draft-close"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <svg {...ICON_PROPS} className="draft-action-icon">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

export type { DraftViewport };
