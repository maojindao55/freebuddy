import { useTranslation } from "react-i18next";

import type { WorkflowPlan } from "@/services/workflows/types";
import { useWorkflowStore } from "@/store/workflowStore";

export function WorkflowPlanCard({
  plan,
  conversationId,
  onRun
}: {
  plan: WorkflowPlan;
  conversationId?: string;
  onRun?: (plan: WorkflowPlan) => void | Promise<void>;
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
  const gates = plan.phases
    .filter((phase) => phase.gate && phase.gate.type !== "all_done")
    .map((phase) => ({ phase, gate: phase.gate! }));
  const riskLabel =
    writeCount > 0 ? t("workflow.riskWrite") : t("workflow.riskReadOnly");
  const run = onRun
    ? () => void onRun(plan)
    : () => void createAndStart({ plan, conversationId });

  return (
    <section className="workflow-plan-card">
      <header>
        <strong>{plan.name}</strong>
        <span>
          {plan.template === "review-loop"
            ? t("workflow.reviewLoop")
            : plan.template === "implement-review-loop"
              ? t("workflow.implementReviewLoop")
              : ""}
        </span>
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
      <div className="workflow-plan-risk">
        <strong>{t("workflow.risk")}</strong>
        <span>{riskLabel}</span>
      </div>
      <div className="workflow-plan-gates">
        <strong>{t("workflow.gates")}</strong>
        {gates.length === 0 ? (
          <span>{t("workflow.noGates")}</span>
        ) : (
          <ul>
            {gates.map(({ phase, gate }) => (
              <li key={phase.id}>
                <span>{phase.title}</span>
                <small>
                  {gate.type}
                  {"reason" in gate && gate.reason ? ` - ${gate.reason}` : ""}
                </small>
              </li>
            ))}
          </ul>
        )}
      </div>
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
          onClick={run}
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
