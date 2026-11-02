import { FileText, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cliClient } from "@/services/cli/client";
import type { CliStreamItem } from "@/services/cli/parsers";
import { appendItems } from "@/store/conversationUtils";
import { useConversationStore } from "@/store/conversationStore";

export function HistoryDetails({ messageId, onRestore }: {
  messageId: string; onRestore: (items: CliStreamItem[]) => void;
}) {
  const { t } = useTranslation();
  const activeId = useConversationStore((s) => s.activeId);
  const request = useRef(0);
  const recovered = useRef<CliStreamItem[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [available, setAvailable] = useState(true);
  const [nextOffset, setNextOffset] = useState<number>();
  useEffect(() => {
    request.current++;
    recovered.current = [];
    setOpen(false); setBusy(false); setFailed(false); setAvailable(true); setNextOffset(undefined);
    onRestore([]);
    return () => { request.current++; };
  }, [activeId, messageId, onRestore]);
  const close = () => {
    request.current++; recovered.current = []; onRestore([]);
    setOpen(false); setBusy(false); setNextOffset(undefined);
  };
  const load = async (offset = 0) => {
    const token = ++request.current;
    setOpen(true); setBusy(true); setFailed(false);
    // Yield between bounded reads and limit each click to 2 MB of log data.
    let cursor = offset;
    try {
      for (let count = 0; count < 16; count++) {
        const page = await cliClient.readMessageDetails(messageId, cursor);
        if (token !== request.current) return;
        setAvailable(page.available);
        recovered.current = appendItems(recovered.current, page.items ?? []);
        onRestore(recovered.current);
        cursor = page.nextOffset;
        setNextOffset(page.hasMore ? cursor : undefined);
        if (!page.hasMore) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } catch {
      if (token === request.current) { setFailed(true); setNextOffset(cursor); }
    } finally {
      if (token === request.current) setBusy(false);
    }
  };
  return <div>
    <button className="history-details-link" type="button" aria-expanded={open}
      title={t(open ? "stream.historyCollapse" : "stream.historyView")}
      onClick={() => open ? close() : void load()}>
      <FileText className="stream-process-icon" aria-hidden="true" />
      <span className="stream-process-title">{t("stream.historyCompacted")}</span>
    </button>
    {open && <div className="history-details-hint" aria-live="polite">
      {busy ? <><LoaderCircle size={14} className="spinning" /> {t("stream.historyLoading")}</>
        : failed ? <>{t("stream.historyError")} <button type="button" onClick={() => void load(nextOffset)}>{t("stream.historyRetry")}</button></>
        : !available || (!recovered.current.length && nextOffset === undefined) ? t("stream.historyUnavailable")
        : <>{t("stream.historyRestoreHint")} {nextOffset !== undefined && <button type="button" onClick={() => void load(nextOffset)}>{t("stream.historyLoadMore")}</button>}</>}
    </div>}
  </div>;
}
