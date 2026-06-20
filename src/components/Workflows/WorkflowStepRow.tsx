import { useTranslation } from "react-i18next";

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
  return (
    <li
      className={`workflow-step-row ${step.status} ${step.mode}${
        selected ? " selected" : ""
      }`}
    >
      <button type="button" className="workflow-step-button" onClick={onClick}>
        <span className="workflow-step-dot" aria-hidden="true" />
        <span className="workflow-step-title">{step.title}</span>
        {step.mode === "write" && (
          <span className="workflow-step-badge">{t("workflow.writeStep")}</span>
        )}
        <span className="workflow-step-status">
          {t(`workflow.stepStatus.${step.status}`)}
        </span>
      </button>
    </li>
  );
}
