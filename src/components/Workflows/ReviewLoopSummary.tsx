import { useTranslation } from "react-i18next";

import type { WorkflowRunRow } from "@/services/workflows/types";

export function ReviewLoopSummary({ run }: { run: WorkflowRunRow }) {
  const { t } = useTranslation();
  return (
    <section className="workflow-summary-card">
      <div className="side-card-header">
        <span>{t("workflow.summary")}</span>
        <strong>
          {t(`workflow.status.${run.status}`)}
          {run.maxLoops > 1 ? ` · ${t("workflow.loop")} ${run.loopIndex + 1}/${run.maxLoops}` : ""}
        </strong>
      </div>
      {run.summary && <pre className="workflow-summary-text">{run.summary}</pre>}
    </section>
  );
}
