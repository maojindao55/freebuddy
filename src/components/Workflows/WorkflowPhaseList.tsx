import { Steps } from "antd";
import type { StepsProps } from "antd";
import { useTranslation } from "react-i18next";

import { AgentAvatar } from "@/components/CLI/AgentAvatar";
import { displayAgentName } from "@/config/agentDisplay";
import type {
  WorkflowPhase,
  WorkflowStepRow as WorkflowStepRowData
} from "@/services/workflows/types";
import { workflowPhaseTitle, workflowStepTitle } from "@/services/workflows/types";
import { WorkflowStepDetails } from "./WorkflowStepDetails";

const STATUS_MAP: Record<string, StepsProps["status"]> = {
  pending: "wait",
  running: "process",
  done: "finish",
  failed: "error",
  blocked: "wait",
  skipped: "wait"
};

export function WorkflowPhaseList({
  phases,
  steps,
  selectedStepId,
  onSelect,
  onRetry
}: {
  phases: WorkflowPhase[];
  steps: WorkflowStepRowData[];
  selectedStepId?: string;
  onSelect?: (step: WorkflowStepRowData) => void;
  onRetry?: (step: WorkflowStepRowData) => void;
}) {
  const { t } = useTranslation();

  const allSteps = phases.flatMap((phase) =>
    phase.steps
      .map((ps) => steps.find((s) => s.stepId === ps.id))
      .filter((s): s is WorkflowStepRowData => Boolean(s))
  );

  const selectedStep = allSteps.find((s) => s.id === selectedStepId);
  const currentIdx = allSteps.findIndex((s) => s.status === "running");
  const current = currentIdx >= 0 ? currentIdx : 0;
  const doneCount = allSteps.filter(
    (s) => s.status === "done" || s.status === "skipped"
  ).length;
  const percent =
    allSteps.length > 0
      ? Math.round((doneCount / allSteps.length) * 100)
      : 0;

  const items: StepsProps["items"] = allSteps.map((step) => {
    const phase = phases.find((entry) => entry.steps.some((ps) => ps.id === step.stepId));
    const agentLabel = displayAgentName(step.agentName, step.adapter);
    const isSelected = selectedStepId === step.id;
    return {
      title: (
        <span
          className={`workflow-step-title ${isSelected ? "selected" : ""}`}
          onClick={onSelect ? () => onSelect(step) : undefined}
          role={onSelect ? "button" : undefined}
        >
          {workflowStepTitle(step, t)}
        </span>
      ),
      description: (
        <span className="workflow-step-meta">
          {phase && (
            <span className="workflow-step-phase">
              {workflowPhaseTitle(phase, t)}
            </span>
          )}
          <AgentAvatar
            adapter={step.adapter}
            className="workflow-step-agent-avatar"
            fallback={<span>{agentLabel.slice(0, 2).toUpperCase()}</span>}
          />
          <span className="workflow-step-agent-name">{agentLabel}</span>
          {step.mode === "write" && (
            <span className="workflow-step-badge">
              {t("workflow.writeStep")}
            </span>
          )}
          <span className={`workflow-step-status-text ${step.status}`}>
            {t(`workflow.stepStatus.${step.status}`)}
          </span>
        </span>
      ),
      status: STATUS_MAP[step.status] ?? "wait"
    };
  });

  return (
    <div className="workflow-steps-antd">
      <Steps
        type="dot"
        current={current}
        percent={percent}
        direction="vertical"
        size="small"
        items={items}
      />
      {selectedStep && onSelect && (
        <WorkflowStepDetails step={selectedStep} onRetry={onRetry} />
      )}
    </div>
  );
}
