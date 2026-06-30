import { useTranslation } from "react-i18next";

import type { WorkflowStepRow } from "@/services/workflows/types";
import { workflowStepTitle } from "@/services/workflows/types";

export function WorkflowStepDetails({
  step,
  onRetry,
  canRetry
}: {
  step: WorkflowStepRow | undefined;
  onRetry?: (step: WorkflowStepRow) => void;
  canRetry?: (step: WorkflowStepRow) => boolean;
}) {
  const { t } = useTranslation();
  if (!step) {
    return <p className="workflow-step-details-empty">{t("workflow.noActiveRun")}</p>;
  }
  const retryable =
    Boolean(onRetry) &&
    (canRetry ? canRetry(step) : step.status === "failed");
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
      {retryable && onRetry && (
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
