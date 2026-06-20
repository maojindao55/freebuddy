import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { WorkflowStepRow } from "@/services/workflows/types";
import { pendingManualGatePhaseId } from "@/services/workflows/planning";
import { useWorkflowStore } from "@/store/workflowStore";
import { WorkflowPhaseList } from "./WorkflowPhaseList";
import { WorkflowStepDetails } from "./WorkflowStepDetails";
import { ReviewLoopSummary } from "./ReviewLoopSummary";

export function WorkflowRunPanel() {
  const { t } = useTranslation();
  const activeRun = useWorkflowStore((s) => s.activeRun);
  const steps = useWorkflowStore((s) => s.steps);
  const refresh = useWorkflowStore((s) => s.refresh);
  const pause = useWorkflowStore((s) => s.pause);
  const resume = useWorkflowStore((s) => s.resume);
  const stop = useWorkflowStore((s) => s.stop);
  const retryStep = useWorkflowStore((s) => s.retryStep);
  const approveGate = useWorkflowStore((s) => s.approveGate);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  let plan: ReturnType<typeof JSON.parse> = null;
  if (activeRun) {
    try {
      plan = JSON.parse(activeRun.planJson);
    } catch {
      plan = null;
    }
  }
  const isLive =
    activeRun?.status === "running" ||
    activeRun?.status === "paused" ||
    activeRun?.status === "blocked";

  useEffect(() => {
    if (!activeRun || !isLive) return;
    const id = window.setInterval(() => void refresh(activeRun.id), 1500);
    return () => window.clearInterval(id);
  }, [activeRun?.id, isLive, refresh]);

  if (!activeRun || !plan) {
    return (
      <section className="side-card workflow-run-panel">
        <div className="side-card-header">
          <span>{t("workflow.progress")}</span>
          <strong>{t("workflow.noActiveRun")}</strong>
        </div>
      </section>
    );
  }

  const selected = steps.find((s) => s.id === selectedId);
  const gatingPhaseId = plan
    ? pendingManualGatePhaseId(
        plan.phases,
        steps.map((s) => ({ stepId: s.stepId, status: s.status }))
      )
    : undefined;

  return (
    <>
      <section className="side-card workflow-run-panel">
        <div className="side-card-header">
          <span>{activeRun.name}</span>
          <strong>{t(`workflow.status.${activeRun.status}`)}</strong>
        </div>

        <div className="workflow-run-actions">
          {activeRun.status === "running" && (
            <button type="button" onClick={() => void pause(activeRun.id)}>
              {t("workflow.pause")}
            </button>
          )}
          {(activeRun.status === "paused" || activeRun.status === "blocked") && (
            <button type="button" onClick={() => void resume(activeRun.id)}>
              {t("workflow.resume")}
            </button>
          )}
          {isLive && (
            <button
              type="button"
              className="danger"
              onClick={() => void stop(activeRun.id)}
            >
              {t("workflow.stop")}
            </button>
          )}
        </div>

        <WorkflowPhaseList
          phases={plan.phases}
          steps={steps}
          selectedStepId={selectedId}
          onSelect={(step: WorkflowStepRow) => setSelectedId(step.id)}
        />
      </section>

      <section className="side-card workflow-step-details-card">
        <WorkflowStepDetails
          step={selected}
          onRetry={(step) => void retryStep(activeRun.id, step.id)}
        />
        {gatingPhaseId && (
          <button
            type="button"
            className="primary"
            onClick={() => void approveGate(activeRun.id, gatingPhaseId)}
          >
            {t("workflow.approveGate")}
          </button>
        )}
      </section>

      {!isLive && <ReviewLoopSummary run={activeRun} />}
    </>
  );
}
