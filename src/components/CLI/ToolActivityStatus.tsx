import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CliStreamItem } from "@/services/cli/parsers";
import { formatDuration } from "@/utils/duration";

export function ToolActivityStatus({ items, active, onStop }: {
  items: CliStreamItem[];
  active: boolean;
  onStop: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const calls = active ? items.filter((item): item is Extract<CliStreamItem, { kind: "tool-call" }> =>
    item.kind === "tool-call" && item.toolKind !== "think" &&
    (item.status === "pending" || item.status === "running") &&
    Number.isFinite(item.startedAt) && Number.isFinite(item.lastProgressAt)) : [];
  const hasCalls = calls.length > 0;
  useEffect(() => {
    if (!hasCalls) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasCalls]);

  const call = calls.reduce<(typeof calls)[number] | undefined>((oldest, item) =>
    !oldest || item.lastProgressAt! < oldest.lastProgressAt! ? item : oldest, undefined);
  if (!call || now - call.startedAt! < 30_000) return null;
  // Completion-only adapters do not expose stdout. Silence is a hint, never a
  // deadlock verdict or an automatic cancellation deadline.
  const quiet = now - call.lastProgressAt! >= 120_000;
  return (
    <div className={`tool-activity-status${quiet ? " quiet" : ""}`}>
      <div className="tool-activity-heading">
        <span><code>{call.tool}</code> · {t("stream.toolElapsed", { duration: formatDuration(Math.max(0, now - call.startedAt!)) })}</span>
        {quiet && <button type="button" disabled={stopping} title={t("stream.stopWaitingTaskDescription")}
          onClick={async () => {
            setStopping(true);
            setStopFailed(false);
            try { await onStop(); }
            catch { setStopFailed(true); }
            finally { setStopping(false); }
          }}>{t(stopping ? "stream.stoppingWaitingTask" : "stream.stopWaitingTask")}</button>}
      </div>
      {quiet && <p role="status">{t("stream.toolQuietHint")}</p>}
      {stopFailed && <p role="alert">{t("stream.stopWaitingTaskFailed")}</p>}
    </div>
  );
}
