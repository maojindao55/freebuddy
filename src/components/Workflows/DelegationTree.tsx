import { memo, useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  flattenDelegationForest,
  type DelegationForest
} from "@freebuddy/delegation-core";

import { eventFailureReason, formatEventDuration } from "@/utils/delegationEventFormat";
import { DelegationEventDetails } from "./DelegationEventDetails";

/** Indentation stops growing past this level so deep runs never overflow. */
const MAX_INDENT_DEPTH = 4;

export interface DelegationTreeProps {
  forest: DelegationForest;
  collapsedNodeIds: ReadonlySet<string>;
  onToggleNode: (nodeId: string) => void;
  expandedEventIds: ReadonlySet<string>;
  onToggleEvent: (eventId: string) => void;
}

/**
 * Read-only view of who delegated to whom. It never fetches data: the parent
 * card owns the polling and passes the assembled forest down.
 */
export const DelegationTree = memo(function DelegationTree({
  forest,
  collapsedNodeIds,
  onToggleNode,
  expandedEventIds,
  onToggleEvent
}: DelegationTreeProps) {
  const { t } = useTranslation();

  const rows = useMemo(
    () =>
      flattenDelegationForest(forest, {
        isExpanded: (node) => !collapsedNodeIds.has(node.event.id)
      }),
    [forest, collapsedNodeIds]
  );

  const orphanCount = useMemo(
    () => forest.warnings.filter((warning) => warning.kind === "orphan-parent").length,
    [forest]
  );

  return (
    <div className="delegation-tree-wrap">
      {orphanCount > 0 ? (
        <p className="delegation-tree-note">{t("workflow.delegation.orphanNote")}</p>
      ) : null}
      {rows.length === 0 ? (
        <p className="delegation-member-empty">
          {t("workflow.delegation.noActivity")}
        </p>
      ) : (
        <div
          className="delegation-tree"
          role="list"
          aria-label={t("workflow.delegation.treeLabel")}
        >
          {rows.map(({ node, depth, isLastChild, posInSet, setSize }) => {
            const event = node.event;
            const indent = Math.min(depth, MAX_INDENT_DEPTH);
            const hasChildren = node.children.length > 0;
            const collapsed = collapsedNodeIds.has(event.id);
            const eventExpanded = expandedEventIds.has(event.id);
            const duration = formatEventDuration(event);
            const failureReason = eventFailureReason(event);
            const isActive =
              event.status === "running" || event.status === "pending";

            return (
              <div
                key={event.id}
                className={`delegation-tree-item depth-${indent}${
                  isLastChild ? " last-child" : ""
                }`}
                role="listitem"
                aria-level={depth + 1}
                aria-posinset={posInSet}
                aria-setsize={setSize}
                style={{ "--fb-tree-depth": String(indent) } as CSSProperties}
              >
                <div className="delegation-tree-row">
                  {hasChildren ? (
                    <button
                      type="button"
                      className="delegation-tree-toggle"
                      aria-expanded={!collapsed}
                      aria-label={
                        collapsed
                          ? t("workflow.delegation.expandNode")
                          : t("workflow.delegation.collapseNode")
                      }
                      onClick={() => onToggleNode(event.id)}
                    >
                      {collapsed ? (
                        <ChevronRight aria-hidden="true" />
                      ) : (
                        <ChevronDown aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    <span
                      className="delegation-tree-toggle-spacer"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={`delegation-activity-dot ${event.status}`}
                    aria-hidden="true"
                  />
                  <span className={`delegation-event-status ${event.status}`}>
                    {t(`workflow.delegation.status.${event.status}`)}
                  </span>
                  <span
                    className={`delegation-tree-role${isActive ? " active" : ""}`}
                    title={`${event.roleLabel} · ${event.agentName}`}
                  >
                    {event.roleLabel}
                  </span>
                  {duration ? (
                    <span className="delegation-event-duration">{duration}</span>
                  ) : null}
                </div>
                <p className="delegation-tree-task" title={event.taskText}>
                  {event.taskText}
                </p>
                <div className="delegation-tree-foot">
                  <button
                    type="button"
                    className="delegation-activity-detail-toggle"
                    aria-expanded={eventExpanded}
                    aria-controls={`delegation-event-${event.id}`}
                    onClick={() => onToggleEvent(event.id)}
                  >
                    {eventExpanded ? (
                      <ChevronDown aria-hidden="true" />
                    ) : (
                      <ChevronRight aria-hidden="true" />
                    )}
                    {eventExpanded
                      ? t("workflow.delegation.hide")
                      : t("workflow.delegation.details")}
                  </button>
                  {collapsed && node.descendantCount > 0 ? (
                    <span className="delegation-tree-hidden">
                      {t("workflow.delegation.hiddenTasks", {
                        count: node.descendantCount
                      })}
                    </span>
                  ) : null}
                </div>
                {failureReason ? (
                  <div
                    className="delegation-event-failure"
                    role="alert"
                    title={failureReason}
                  >
                    <strong>{t("workflow.failureReason")}</strong>
                    <span>{failureReason}</span>
                  </div>
                ) : null}
                {eventExpanded ? <DelegationEventDetails event={event} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
