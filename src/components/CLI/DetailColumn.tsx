import { useEffect, type MouseEvent } from "react";

import { useTranslation } from "react-i18next";

import { useConversationStore } from "@/store/conversationStore";
import { useDetailLayoutStore, selectDetailWidth } from "@/store/detailLayoutStore";
import { useDraftPreviewStore } from "@/store/draftPreviewStore";
import { DraftCanvas } from "../Draft/DraftCanvas";
import { WorkspacePanel } from "./WorkspacePanel";

export function DetailColumn({ runningCount }: { runningCount: number }) {
  const { t } = useTranslation();
  const activeId = useConversationStore((s) => s.activeId);
  const entry = useDraftPreviewStore((s) =>
    activeId ? s.byConv[activeId] : undefined
  );
  const activeTab = useDetailLayoutStore((s) => s.activeTab);
  const setActiveTab = useDetailLayoutStore((s) => s.setActiveTab);

  useEffect(() => {
    if (!activeId) return;
    useDetailLayoutStore.getState().setActiveTab("overview");
    const conv = useConversationStore
      .getState()
      .conversations.find((c) => c.id === activeId);
    void useDraftPreviewStore.getState().ensureFor(activeId, conv?.cwd);
  }, [activeId]);

  const previewAvailable = Boolean(entry?.entryRel);

  const onResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = selectDetailWidth(useDetailLayoutStore.getState());
    const onMove = (ev: globalThis.MouseEvent) => {
      useDetailLayoutStore.getState().setWidth(startWidth - (ev.clientX - startX));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <aside
      className="details-panel workspace-panel detail-column"
      aria-label={t("workspace.panelAria")}
    >
      <div
        className="detail-resizer"
        role="separator"
        aria-orientation="vertical"
        onMouseDown={onResizeStart}
      />
      <div className="detail-tab-body">
        {activeTab === "overview" ? (
          <>
            <button
              type="button"
              className={`detail-entry${previewAvailable ? " available" : ""}`}
              onClick={() => setActiveTab("preview")}
              title={t("draft.tabPreview")}
            >
              <svg
                className="detail-entry-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="4" width="18" height="13" rx="2" />
                <path d="M9 21h6M12 17v4" />
              </svg>
              <span>{t("draft.tabPreview")}</span>
              {previewAvailable && (
                <span
                  className="detail-entry-badge"
                  aria-label={t("draft.previewBadge")}
                />
              )}
            </button>
            <WorkspacePanel runningCount={runningCount} />
          </>
        ) : (
          <DraftCanvas onClose={() => setActiveTab("overview")} />
        )}
      </div>
    </aside>
  );
}
