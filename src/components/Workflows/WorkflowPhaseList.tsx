import { useTranslation } from "react-i18next";

import type {
  WorkflowPhase,
  WorkflowStepRow as WorkflowStepRowData
} from "@/services/workflows/types";
import { WorkflowStepRow } from "./WorkflowStepRow";

export function WorkflowPhaseList({
  phases,
  steps,
  selectedStepId,
  onSelect
}: {
  phases: WorkflowPhase[];
  steps: WorkflowStepRowData[];
  selectedStepId?: string;
  onSelect?: (step: WorkflowStepRowData) => void;
}) {
  return (
    <ol className="workflow-phase-list">
      {phases.map((phase) => (
        <li key={phase.id} className="workflow-phase">
          <header className="workflow-phase-header">
            <strong>{phase.title}</strong>
          </header>
          <ul className="workflow-step-list">
            {phase.steps.map((planStep) => {
              const step = steps.find((s) => s.stepId === planStep.id);
              if (!step) return null;
              return (
                <WorkflowStepRow
                  key={step.id}
                  step={step}
                  selected={selectedStepId === step.id}
                  onClick={onSelect ? () => onSelect(step) : undefined}
                />
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}
