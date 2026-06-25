import { useTranslation } from "react-i18next";

import type { WorkflowStepRow } from "@/services/workflows/types";
import { workflowStepTitle } from "@/services/workflows/types";

export function WorkflowStepDetails({
  step,
  onRetry
}: {
  step: WorkflowStepRow | undefined;
  onRetry?: (step: WorkflowStepRow) => void;
}) {
  const { t } = useTranslation();
  if (!step) {
    return <p className="workflow-step-details-empty">{t("workflow.noActiveRun")}</p>;
  }
  return (
    <div className="workflow-step-details">
      <header>
        <strong>{workflowStepTitle(step, t)}</strong>
        <span className={`workflow-status-pill ${step.status}`}>
          {t(`workflow.stepStatus.${step.status}`)}
        </span>
      </header>
      <pre className="workflow-step-prompt">{step.prompt}</pre>
      {step.summary && (
        <details className="workflow-step-summary">
          <summary>{t("workflow.summary")}</summary>
          <p>{step.summary}</p>
        </details>
      )}
      {step.status === "failed" && onRetry && (
        <button
          type="button"
          className="primary workflow-retry-button"
          onClick={() => onRetry(step)}
        >
          {t("workflow.retry")}
        </button>
      )}
    </div>
  );
}
