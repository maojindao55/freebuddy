import { useEffect, useMemo } from "react";

import { useTranslation } from "react-i18next";

import type { CliStreamItem } from "@/services/cli/parsers";
import type { ConversationMessage } from "@/services/cli/types";
import { useConversationStore } from "@/store/conversationStore";
import { useDraftPreviewStore } from "@/store/draftPreviewStore";
import { DraftToolbar } from "./DraftToolbar";

const EMPTY_MESSAGES: ConversationMessage[] = [];

function extractLastFileEditPath(
  items: CliStreamItem[] | undefined,
  messages: ConversationMessage[]
): string | undefined {
  if (items && items.length) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it.kind === "file-edit" && it.path) return it.path;
    }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    try {
      const parsed = JSON.parse(message.content) as unknown;
      if (!Array.isArray(parsed)) continue;
      const parsedItems = parsed as CliStreamItem[];
      for (let j = parsedItems.length - 1; j >= 0; j -= 1) {
        const it = parsedItems[j];
        if (it.kind === "file-edit" && it.path) return it.path;
      }
    } catch {
      // ignore legacy plain content
    }
  }
  return undefined;
}

export function DraftCanvas({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const activeId = useConversationStore((s) => s.activeId);
  const cwd = useConversationStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeId);
    return conv?.cwd;
  });
  const liveItems = useConversationStore((s) =>
    s.activeId ? s.live[s.activeId]?.items : undefined
  );
  const messages = useConversationStore((s) =>
    s.activeId ? s.messages[s.activeId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );
  const entry = useDraftPreviewStore((s) =>
    activeId ? s.byConv[activeId] : undefined
  );

  useEffect(() => {
    if (!activeId) return;
    void useDraftPreviewStore.getState().ensureFor(activeId, cwd);
  }, [activeId, cwd]);

  const lastEditPath = useMemo(
    () => extractLastFileEditPath(liveItems, messages),
    [liveItems, messages]
  );

  useEffect(() => {
    if (!activeId || !lastEditPath) return;
    useDraftPreviewStore.getState().scheduleReload(activeId);
  }, [activeId, lastEditPath]);

  const hasEntry = Boolean(entry?.url);

  return (
    <div className="draft-canvas">
      <DraftToolbar
        entryRel={entry?.manualEntry ?? entry?.entryRel ?? ""}
        onClose={onClose}
      />
      <div className="draft-frame-wrap">
        {hasEntry ? (
          <iframe
            src={entry!.url}
            className="draft-frame"
            title={t("draft.title")}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
          />
        ) : (
          <div className="draft-empty">
            <p>{cwd ? t("draft.emptyNoEntry") : t("draft.emptyNoWorkspace")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
