import { useEffect, useState, type KeyboardEvent } from "react";

import { useTranslation } from "react-i18next";

import { useConversationStore } from "@/store/conversationStore";
import { useDraftPreviewStore } from "@/store/draftPreviewStore";

export function DraftToolbar({
  entryRel,
  onClose
}: {
  entryRel: string;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const activeId = useConversationStore((s) => s.activeId);
  const [value, setValue] = useState(entryRel);

  useEffect(() => {
    setValue(entryRel);
  }, [entryRel]);

  const commit = () => {
    const trimmed = value.trim();
    if (activeId && trimmed) {
      useDraftPreviewStore.getState().setManualEntry(activeId, trimmed);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div className="draft-toolbar">
      <input
        className="draft-address"
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder={t("draft.entryPlaceholder")}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="draft-action"
        title={t("draft.refresh")}
        aria-label={t("draft.refresh")}
        onClick={() => activeId && useDraftPreviewStore.getState().reload(activeId)}
      >
        ⟳
      </button>
      {onClose && (
        <button
          type="button"
          className="draft-action draft-close"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={onClose}
        >
          ✕
        </button>
      )}
    </div>
  );
}
