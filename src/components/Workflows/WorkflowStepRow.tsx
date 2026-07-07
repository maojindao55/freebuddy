import { useTranslation } from "react-i18next";

import { AgentAvatar } from "@/components/CLI/AgentAvatar";
import { displayAgentName } from "@/config/agentDisplay";
import type { WorkflowStepRow } from "@/services/workflows/types";

export function WorkflowStepRow({
  step,
  onClick,
  selected
}: {
  step: WorkflowStepRow;
  onClick?: () => void;
  selected?: boolean;
}) {
  const { t } = useTranslation();
  const agentLabel = displayAgentName(step.agentName, step.adapter);
  return (
    <div
      className={`workflow-step-row ${step.status} ${step.mode}${
        selected ? " selected" : ""
      }`}
    >
      <button type="button" className="workflow-step-button" onClick={onClick}>
        <span className="workflow-step-dot" aria-hidden="true" />
        <div className="workflow-step-main">
          <span className="workflow-step-title">{step.title}</span>
          <span className="workflow-step-meta">
            <AgentAvatar
              adapter={step.adapter}
              agentId={step.agentId}
              className="workflow-step-agent-avatar"
              fallback={
                <span>{agentLabel.slice(0, 2).toUpperCase()}</span>
              }
            />
            <span className="workflow-step-agent-name">{agentLabel}</span>
            {step.mode === "write" && (
              <span className="workflow-step-badge">
                {t("workflow.writeStep")}
              </span>
            )}
          </span>
        </div>
        <span className="workflow-step-status">
          {t(`workflow.stepStatus.${step.status}`)}
        </span>
      </button>
    </div>
  );
}
