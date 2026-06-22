import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { WorkflowStepRow } from "@/services/workflows/types";
import { pendingManualGatePhaseId } from "@/services/workflows/planning";
import { useWorkflowStore } from "@/store/workflowStore";
import { WorkflowPhaseList } from "./WorkflowPhaseList";

function PauseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="7" y="5" width="3" height="14" rx="1" />
      <rect x="14" y="5" width="3" height="14" rx="1" />
    </svg>
  );
}

function ResumeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="7 4 19 12 7 20 7 4" fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

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

  const progress = useMemo(() => {
    if (!steps.length) return { done: 0, total: 0, percent: 0 };
    const done = steps.filter(
      (s) => s.status === "done" || s.status === "skipped"
    ).length;
    return {
      done,
      total: steps.length,
      percent: Math.round((done / steps.length) * 100)
    };
  }, [steps]);

  if (!activeRun || !plan) {
    return null;
  }

  const gatingPhaseId = pendingManualGatePhaseId(
    plan.phases,
    steps.map((s) => ({ stepId: s.stepId, status: s.status }))
  );

  return (
    <section className="side-card workflow-run-panel">
      <div className="workflow-run-header">
        <div className="workflow-run-title">
          <strong>{activeRun.name}</strong>
          <span className={`workflow-run-status ${activeRun.status}`}>
            {t(`workflow.status.${activeRun.status}`)}
          </span>
        </div>
        <div className="workflow-run-progress">
          <div className="workflow-progress-bar" aria-hidden="true">
            <div
              className="workflow-progress-fill"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <span className="workflow-progress-label">
            {progress.done}/{progress.total}
          </span>
        </div>
      </div>

      {(isLive || gatingPhaseId) && (
        <div className="workflow-run-actions">
          {activeRun.status === "running" && (
            <button type="button" onClick={() => void pause(activeRun.id)}>
              <PauseIcon /> {t("workflow.pause")}
            </button>
          )}
          {(activeRun.status === "paused" ||
            activeRun.status === "blocked") && (
            <button type="button" onClick={() => void resume(activeRun.id)}>
              <ResumeIcon /> {t("workflow.resume")}
            </button>
          )}
          {gatingPhaseId && (
            <button
              type="button"
              className="primary"
              onClick={() =>
                void approveGate(activeRun.id, gatingPhaseId)
              }
            >
              {t("workflow.approveGate")}
            </button>
          )}
          {isLive && (
            <button
              type="button"
              className="danger"
              onClick={() => void stop(activeRun.id)}
            >
              <StopIcon /> {t("workflow.stop")}
            </button>
          )}
        </div>
      )}

      <WorkflowPhaseList
        phases={plan.phases}
        steps={steps}
        selectedStepId={selectedId}
        onSelect={(step: WorkflowStepRow) =>
          setSelectedId((cur) => (cur === step.id ? undefined : step.id))
        }
        onRetry={(step) => void retryStep(activeRun.id, step.id)}
      />
    </section>
  );
}
