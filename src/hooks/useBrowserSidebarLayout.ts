import { useLayoutEffect, useState } from "react";

const SIDEBAR_WIDTH = 272;
const CHAT_MIN_WIDTH = 420;
const DETAIL_MIN_WIDTH = 320;
const BROWSER_COMFORT_WIDTH = 560;
const COLUMN_CLEARANCE = 8;

export function resolveDetailWidth(viewportWidth: number, detailWidth: number, sidebarCollapsed: boolean, detailVisible: boolean): number {
  if (!detailVisible) return 0;
  return Math.min(detailWidth, Math.max(DETAIL_MIN_WIDTH,
    viewportWidth - (sidebarCollapsed ? 0 : SIDEBAR_WIDTH) - CHAT_MIN_WIDTH - COLUMN_CLEARANCE));
}

/** The browser is closed only by the user; other detail tabs retain their resize behavior. */
export function getResponsiveDetailCollapse(viewportWidth: number, previousNarrow: boolean | null, previewSelected: boolean, changedTab: boolean): boolean | undefined {
  if (previewSelected) return undefined;
  const isNarrow = viewportWidth < 1080;
  if (isNarrow && (previousNarrow !== true || changedTab)) return true;
  if (!isNarrow && previousNarrow === true) return false;
  return undefined;
}

/** Automatic space-saving never changes the user's sidebar preference. */
export function useBrowserSidebarLayout({ viewportWidth, previewWidth, previewOpen, previewVisible, conversationId }: {
  viewportWidth: number;
  previewWidth: number;
  previewOpen: boolean;
  previewVisible: boolean;
  conversationId?: string;
}) {
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [previewOverride, setPreviewOverride] = useState<boolean>();
  useLayoutEffect(() => {
    setPreviewOverride(undefined);
  }, [previewOpen, conversationId]);

  // Use the requested browser width, not the space left after collapsing.
  const browserBudget = Math.max(DETAIL_MIN_WIDTH, Math.min(previewWidth, BROWSER_COMFORT_WIDTH));
  const spaceNeeded = SIDEBAR_WIDTH + CHAT_MIN_WIDTH + browserBudget + COLUMN_CLEARANCE;
  const sidebarCollapsed = previewVisible && previewOpen
    ? previewOverride ?? (userCollapsed || viewportWidth < spaceNeeded)
    : userCollapsed;

  return {
    sidebarCollapsed,
    toggleSidebar() {
      const next = !sidebarCollapsed;
      setUserCollapsed(next);
      if (previewOpen) setPreviewOverride(next);
    }
  };
}
