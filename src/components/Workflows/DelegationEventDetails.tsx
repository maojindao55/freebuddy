import { useTranslation } from "react-i18next";

import type { DelegationEventRow } from "@/services/delegation/client";
import { eventFailureReason, formatEventClock } from "@/utils/delegationEventFormat";

/**
 * Expanded detail body for one delegated task: timing, verdict and result.
 * Shared by the roster view and the tree view so both stay in sync.
 */
export function DelegationEventDetails({ event }: { event: DelegationEventRow }) {
  const { t } = useTranslation();
  const failureReason = eventFailureReason(event);

  return (
    <div
      id={`delegation-event-${event.id}`}
      className="delegation-activity-details"
    >
      <div className="delegation-event-timing">
        {t("workflow.delegation.acceptedAt")} {formatEventClock(event.acceptedAt)}
        {event.startedAt
          ? ` · ${t("workflow.delegation.startedAt")} ${formatEventClock(event.startedAt)}`
          : ""}
        {event.endedAt
          ? ` · ${t("workflow.delegation.endedAt")} ${formatEventClock(event.endedAt)}`
          : ""}
      </div>
      {event.verdict ? (
        <div className={`delegation-activity-verdict ${event.verdict}`}>
          {event.verdict}
          {event.verdictSummary ? ` · ${event.verdictSummary}` : ""}
        </div>
      ) : null}
      {event.resultSummary && !failureReason ? (
        <div className="delegation-event-result">
          <strong>{t("workflow.delegation.result")}</strong>
          <p>{event.resultSummary}</p>
        </div>
      ) : null}
    </div>
  );
}
