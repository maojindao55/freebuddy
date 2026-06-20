import { useTranslation } from "react-i18next";

import type { WorkflowPlan } from "@/services/workflows/types";
import { useWorkflowStore } from "@/store/workflowStore";

export function WorkflowPlanCard({
  plan,
  conversationId
}: {
  plan: WorkflowPlan;
  conversationId?: string;
}) {
  const { t } = useTranslation();
  const createAndStart = useWorkflowStore((s) => s.createAndStart);
  const clearPending = useWorkflowStore((s) => s.clearPending);

  const agents = Array.from(
    new Set(plan.phases.flatMap((p) => p.steps.map((s) => s.agentId)))
  );
  const writeCount = plan.phases.reduce(
    (n, p) => n + p.steps.filter((s) => s.mode === "write").length,
    0
  );

  return (
    <section className="workflow-plan-card">
      <header>
        <strong>{plan.name}</strong>
        <span>{plan.template === "review-loop" ? t("workflow.reviewLoop") : ""}</span>
      </header>
      <p className="workflow-plan-goal">{plan.goal}</p>
      <dl className="workflow-plan-stats">
        <div>
          <dt>{t("workflow.phases")}</dt>
          <dd>{plan.phases.length}</dd>
        </div>
        <div>
          <dt>{t("workflow.steps")}</dt>
          <dd>{plan.phases.reduce((n, p) => n + p.steps.length, 0)}</dd>
        </div>
        <div>
          <dt>{t("workflow.agents")}</dt>
          <dd>{agents.length}</dd>
        </div>
        <div>
          <dt>{t("workflow.writeStep")}</dt>
          <dd>{writeCount}</dd>
        </div>
      </dl>
      <ol className="workflow-plan-phases">
        {plan.phases.map((phase) => (
          <li key={phase.id}>
            <strong>{phase.title}</strong>
            <ul>
              {phase.steps.map((s) => (
                <li key={s.id} className={s.mode}>
                  {s.title} <small>{s.mode}</small>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <div className="workflow-plan-actions">
        <button
          type="button"
          className="primary"
          onClick={() => void createAndStart({ plan, conversationId })}
        >
          {t("workflow.run")}
        </button>
        <button type="button" onClick={clearPending}>
          {t("workflow.cancel")}
        </button>
      </div>
    </section>
  );
}
