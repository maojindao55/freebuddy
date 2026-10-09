import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Table } from "lucide-react";
import { a1ToRowCol, rowColToA1 } from "./utils/sheetParser";

export interface CellUpdate {
  cell: string;
  value: string | number | null;
  formula?: string;
}

/** Bounding box of the referenced cells in A1 notation; "" when none valid. */
export function updatesRangeLabel(updates: CellUpdate[]): string {
  let minR = Infinity;
  let minC = Infinity;
  let maxR = -1;
  let maxC = -1;
  for (const u of updates) {
    const rc = a1ToRowCol(u.cell);
    if (!rc) continue;
    minR = Math.min(minR, rc.row);
    minC = Math.min(minC, rc.col);
    maxR = Math.max(maxR, rc.row);
    maxC = Math.max(maxC, rc.col);
  }
  if (maxR < 0) return "";
  const a = rowColToA1(minR, minC);
  const b = rowColToA1(maxR, maxC);
  return a === b ? a : `${a}:${b}`;
}

function updateValueText(u: CellUpdate): string {
  if (u.formula) return "";
  return u.value === null || u.value === undefined ? "" : String(u.value);
}

export const CellUpdatesSummary: React.FC<{ updates: CellUpdate[] }> = ({ updates }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const range = useMemo(() => updatesRangeLabel(updates), [updates]);
  return (
    <div className="ds-updates-summary">
      <div className="ds-updates-summary-head">
        <Table size={13} className="ds-updates-summary-icon" />
        <span className="ds-updates-summary-title">
          {t("docStudio.updatesSummary", { count: updates.length })}
        </span>
        <span className="ds-updates-summary-range">{t("docStudio.updatesRange", { range })}</span>
        <button
          type="button"
          className="ds-updates-summary-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? t("docStudio.hideDetails") : t("docStudio.showDetails")}
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>
      {open && (
        <div className="ds-updates-summary-body">
          <div className="ds-updates-summary-row ds-updates-summary-head-row">
            <span>{t("docStudio.colCell")}</span>
            <span>{t("docStudio.colValue")}</span>
            <span>{t("docStudio.colFormula")}</span>
          </div>
          {updates.map((u, i) => {
            const valueText = updateValueText(u);
            return (
              <div className="ds-updates-summary-row" key={i}>
                <span className="ds-updates-summary-mono">{u.cell}</span>
                {valueText ? (
                  <span className="ds-updates-summary-value" title={valueText}>
                    {valueText}
                  </span>
                ) : (
                  <span className="ds-updates-summary-empty">—</span>
                )}
                <span className="ds-updates-summary-mono ds-updates-summary-formula">
                  {u.formula ?? ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
