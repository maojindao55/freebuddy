import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Bold,
  Italic,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Plus,
  Sparkles,
  Undo2,
  Redo2,
  ChevronDown,
  Send,
  X
} from "lucide-react";
import type { SheetWorkbookData, SheetData, CellValue, CellSelection, SelectionContext } from "./types";
import {
  colIndexToLetter,
  rowColToA1,
  rangeToLabel,
  evaluateFormula
} from "./utils/sheetParser";
import { formatCellValue, isFormulaError } from "./utils/formulaEngine";

interface SpreadsheetEditorProps {
  workbook: SheetWorkbookData;
  onChange: (updated: SheetWorkbookData) => void;
  onAskAi: (selectionContext: SelectionContext) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

const DEFAULT_COL_WIDTH = 100;
const DEFAULT_ROW_HEIGHT = 28;
const HEADER_COL_WIDTH = 48;
const HEADER_ROW_HEIGHT = 26;
const OVERSCAN_ROWS = 12;

export const SpreadsheetEditor: React.FC<SpreadsheetEditorProps> = ({
  workbook,
  onChange,
  onAskAi,
  onUndo,
  onRedo,
  canUndo,
  canRedo
}) => {
  const { t } = useTranslation();
  const activeSheetIndex = workbook.activeSheetIndex ?? 0;
  const currentSheet = workbook.sheets[activeSheetIndex] || workbook.sheets[0];

  const [selection, setSelection] = useState<CellSelection>({
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0
  });

  const [isSelecting, setIsSelecting] = useState(false);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editInputValue, setEditInputValue] = useState("");
  const [zoom, setZoom] = useState(100);

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Freeze first row: default ON when every non-empty cell in row 1 is non-numeric text
  const [frozenFirstRow, setFrozenFirstRow] = useState<boolean | null>(null);
  const freezeAuto = useMemo(() => {
    let nonEmpty = 0;
    let allText = true;
    for (let c = 0; c < currentSheet.colCount; c++) {
      const cell = currentSheet.cells[`0:${c}`];
      if (cell?.value !== null && cell?.value !== undefined && String(cell.value).trim() !== "") {
        nonEmpty++;
        if (typeof cell.value === "number") allText = false;
      }
    }
    return nonEmpty > 0 && allText;
  }, [currentSheet]);
  const frozen = frozenFirstRow ?? freezeAuto;

  // Row virtualization state
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    setViewportHeight(el.clientHeight);
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  const activeRow = selection.startRow;
  const activeCol = selection.startCol;
  const activeCellAddress = rowColToA1(activeRow, activeCol);
  const activeCellData: CellValue | undefined = currentSheet?.cells[`${activeRow}:${activeCol}`];

  const formulaBarValue = editingCell
    ? editInputValue
    : activeCellData?.formula || (activeCellData?.value !== null && activeCellData?.value !== undefined ? String(activeCellData.value) : "");

  const [colWidths, setColWidths] = useState<Record<number, number>>({});
  const [resizingCol, setResizingCol] = useState<{ col: number; startX: number; startWidth: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [inlineAiOpen, setInlineAiOpen] = useState(false);
  const [inlineAiPrompt, setInlineAiPrompt] = useState("");
  const inlineAiInputRef = useRef<HTMLInputElement>(null);

  const getColWidth = useCallback(
    (colIdx: number) => {
      return colWidths[colIdx] || currentSheet?.colWidths?.[colIdx] || DEFAULT_COL_WIDTH;
    },
    [colWidths, currentSheet]
  );

  useEffect(() => {
    if (!resizingCol) return;
    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - resizingCol.startX;
      const newWidth = Math.max(40, resizingCol.startWidth + delta);
      setColWidths((prev) => ({ ...prev, [resizingCol.col]: newWidth }));
    };
    const handleMouseUp = () => setResizingCol(null);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [resizingCol]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  useEffect(() => {
    if (inlineAiOpen && inlineAiInputRef.current) inlineAiInputRef.current.focus();
  }, [inlineAiOpen]);

  useEffect(() => {
    if (editingCell && editInputRef.current) editInputRef.current.focus();
  }, [editingCell]);

  const handleCellMouseDown = (row: number, col: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (editingCell) commitCellEdit();
    setSelection({ startRow: row, startCol: col, endRow: row, endCol: col });
    setIsSelecting(true);
  };

  const handleCellMouseEnter = (row: number, col: number) => {
    if (isSelecting) {
      setSelection((prev) => ({ ...prev, endRow: row, endCol: col }));
    }
  };

  useEffect(() => {
    const handleMouseUp = () => {
      if (isSelecting) setIsSelecting(false);
    };
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [isSelecting]);

  const handleCellDoubleClick = (row: number, col: number) => {
    const cell = currentSheet.cells[`${row}:${col}`];
    const initialText = cell?.formula || (cell?.value !== null && cell?.value !== undefined ? String(cell.value) : "");
    setEditingCell({ row, col });
    setEditInputValue(initialText);
  };

  const commitCellEdit = useCallback(() => {
    if (!editingCell) return;
    const { row, col } = editingCell;
    const trimmed = editInputValue.trim();

    const newCells = { ...currentSheet.cells };
    const key = `${row}:${col}`;

    if (!trimmed) {
      delete newCells[key];
    } else if (trimmed.startsWith("=")) {
      const calculated = evaluateFormula(trimmed, newCells);
      newCells[key] = {
        value: calculated,
        formula: trimmed,
        displayValue: formatCellValue(calculated)
      };
    } else {
      const num = Number(trimmed);
      const isNum = !isNaN(num);
      newCells[key] = {
        value: isNum ? num : trimmed,
        displayValue: trimmed
      };
    }

    const updatedSheets = [...workbook.sheets];
    updatedSheets[activeSheetIndex] = {
      ...currentSheet,
      cells: newCells
    };

    onChange({ ...workbook, sheets: updatedSheets });
    setEditingCell(null);
  }, [editingCell, editInputValue, currentSheet, workbook, activeSheetIndex, onChange]);

  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);

  const commitCellsUpdate = useCallback((newCells: Record<string, CellValue>, newRowCount?: number, newColCount?: number) => {
    const updatedSheets = [...workbook.sheets];
    updatedSheets[activeSheetIndex] = {
      ...currentSheet,
      rowCount: newRowCount ?? currentSheet.rowCount,
      colCount: newColCount ?? currentSheet.colCount,
      cells: newCells
    };
    onChange({ ...workbook, sheets: updatedSheets });
  }, [workbook, activeSheetIndex, currentSheet, onChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (editingCell) {
      if (e.key === "Enter") {
        e.preventDefault();
        commitCellEdit();
        setSelection((prev) => ({
          ...prev,
          startRow: Math.min(prev.startRow + 1, currentSheet.rowCount - 1),
          endRow: Math.min(prev.startRow + 1, currentSheet.rowCount - 1)
        }));
      } else if (e.key === "Escape") {
        setEditingCell(null);
      } else if (e.key === "Tab") {
        e.preventDefault();
        commitCellEdit();
        setSelection((prev) => ({
          ...prev,
          startCol: Math.min(prev.startCol + 1, currentSheet.colCount - 1),
          endCol: Math.min(prev.startCol + 1, currentSheet.colCount - 1)
        }));
      }
      return;
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      setEditingCell({ row: activeRow, col: activeCol });
      setEditInputValue(e.key);
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      const lines: string[] = [];
      for (let r = minRow; r <= maxRow; r++) {
        const rowVals: string[] = [];
        for (let c = minCol; c <= maxCol; c++) {
          const val = currentSheet.cells[`${r}:${c}`]?.value ?? "";
          rowVals.push(String(val));
        }
        lines.push(rowVals.join("\t"));
      }
      void navigator.clipboard.writeText(lines.join("\n"));
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      void (async () => {
        try {
          const clipText = await navigator.clipboard.readText();
          if (!clipText) return;
          const rows = clipText.split(/\r?\n/).filter((l, idx, arr) => idx < arr.length - 1 || l.trim() !== "");
          const newCells = { ...currentSheet.cells };
          let maxR = currentSheet.rowCount;
          let maxC = currentSheet.colCount;

          rows.forEach((rowStr, rOffset) => {
            const r = activeRow + rOffset;
            if (r >= maxR) maxR = r + 1;
            const cols = rowStr.includes("\t") ? rowStr.split("\t") : rowStr.split(",");
            cols.forEach((colStr, cOffset) => {
              const c = activeCol + cOffset;
              if (c >= maxC) maxC = c + 1;
              const trimmed = colStr.trim();
              const num = Number(trimmed);
              newCells[`${r}:${c}`] = {
                value: !isNaN(num) && trimmed !== "" ? num : trimmed,
                displayValue: trimmed
              };
            });
          });

          commitCellsUpdate(newCells, maxR, maxC);
        } catch (err) {
          console.warn("Clipboard paste failed:", err);
        }
      })();
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelection((prev) => {
        const nextR = Math.max(0, prev.startRow - 1);
        return { startRow: nextR, startCol: prev.startCol, endRow: nextR, endCol: prev.startCol };
      });
    } else if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      setSelection((prev) => {
        const nextR = Math.min(currentSheet.rowCount - 1, prev.startRow + 1);
        return { startRow: nextR, startCol: prev.startCol, endRow: nextR, endCol: prev.startCol };
      });
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setSelection((prev) => {
        const nextC = Math.max(0, prev.startCol - 1);
        return { startRow: prev.startRow, startCol: nextC, endRow: prev.startRow, endCol: nextC };
      });
    } else if (e.key === "ArrowRight" || e.key === "Tab") {
      e.preventDefault();
      setSelection((prev) => {
        const nextC = Math.min(currentSheet.colCount - 1, prev.startCol + 1);
        return { startRow: prev.startRow, startCol: nextC, endRow: prev.startRow, endCol: nextC };
      });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const newCells = { ...currentSheet.cells };
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          delete newCells[`${r}:${c}`];
        }
      }
      const updatedSheets = [...workbook.sheets];
      updatedSheets[activeSheetIndex] = { ...currentSheet, cells: newCells };
      onChange({ ...workbook, sheets: updatedSheets });
    }
  };

  const handleToggleBold = () => {
    const newCells = { ...currentSheet.cells };
    const isCurrentBold = Boolean(currentSheet.cells[`${activeRow}:${activeCol}`]?.style?.bold);
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const k = `${r}:${c}`;
        const cell = newCells[k] || { value: "" };
        newCells[k] = { ...cell, style: { ...cell.style, bold: !isCurrentBold } };
      }
    }
    commitCellsUpdate(newCells);
  };

  const handleToggleItalic = () => {
    const newCells = { ...currentSheet.cells };
    const isCurrentItalic = Boolean(currentSheet.cells[`${activeRow}:${activeCol}`]?.style?.italic);
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const k = `${r}:${c}`;
        const cell = newCells[k] || { value: "" };
        newCells[k] = { ...cell, style: { ...cell.style, italic: !isCurrentItalic } };
      }
    }
    commitCellsUpdate(newCells);
  };

  const handleSetAlign = (align: "left" | "center" | "right") => {
    const newCells = { ...currentSheet.cells };
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const k = `${r}:${c}`;
        const cell = newCells[k] || { value: "" };
        newCells[k] = { ...cell, style: { ...cell.style, align } };
      }
    }
    commitCellsUpdate(newCells);
  };

  const handleInsertRow = (above: boolean) => {
    const targetRow = above ? minRow : maxRow + 1;
    const newCells: Record<string, CellValue> = {};
    for (const [key, cell] of Object.entries(currentSheet.cells)) {
      const [rStr, cStr] = key.split(":");
      const r = parseInt(rStr, 10);
      const c = parseInt(cStr, 10);
      if (r >= targetRow) {
        newCells[`${r + 1}:${c}`] = cell;
      } else {
        newCells[key] = cell;
      }
    }
    commitCellsUpdate(newCells, currentSheet.rowCount + 1, currentSheet.colCount);
    setMenuOpen(false);
  };

  const handleInsertCol = (left: boolean) => {
    const targetCol = left ? minCol : maxCol + 1;
    const newCells: Record<string, CellValue> = {};
    for (const [key, cell] of Object.entries(currentSheet.cells)) {
      const [rStr, cStr] = key.split(":");
      const c = parseInt(cStr, 10);
      if (c >= targetCol) {
        newCells[`${rStr}:${c + 1}`] = cell;
      } else {
        newCells[key] = cell;
      }
    }
    commitCellsUpdate(newCells, currentSheet.rowCount, currentSheet.colCount + 1);
    setMenuOpen(false);
  };

  const handleClearSelection = () => {
    const newCells = { ...currentSheet.cells };
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        delete newCells[`${r}:${c}`];
      }
    }
    commitCellsUpdate(newCells);
    setMenuOpen(false);
  };

  const isCellSelected = (r: number, c: number) =>
    r >= minRow && r <= maxRow && c >= minCol && c <= maxCol;

  const selectionStats = useMemo(() => {
    let count = 0;
    let sum = 0;
    let numCount = 0;
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        count++;
        const cell = currentSheet.cells[`${r}:${c}`];
        if (cell?.value !== undefined && cell?.value !== null) {
          const val = Number(cell.value);
          if (!isNaN(val) && String(cell.value).trim() !== "") {
            sum += val;
            numCount++;
          }
        }
      }
    }
    const avg = numCount > 0 ? Math.round((sum / numCount) * 100) / 100 : 0;
    return { count, sum: Math.round(sum * 100) / 100, avg, numCount };
  }, [minRow, maxRow, minCol, maxCol, currentSheet]);

  const triggerAiEdit = (prompt?: string) => {
    const headers: string[] = [];
    for (let c = 0; c < currentSheet.colCount; c++) {
      const hCell = currentSheet.cells[`0:${c}`];
      if (hCell && hCell.value !== null && hCell.value !== undefined) {
        headers.push(String(hCell.value));
      }
    }

    const dataPreview: (string | number)[][] = [];
    for (let r = minRow; r <= maxRow; r++) {
      const rowArr: (string | number)[] = [];
      for (let c = minCol; c <= maxCol; c++) {
        const cell = currentSheet.cells[`${r}:${c}`];
        const val = cell?.value;
        rowArr.push(typeof val === "boolean" ? String(val) : (val ?? ""));
      }
      dataPreview.push(rowArr);
    }

    const rangeLabel = rangeToLabel(minRow, minCol, maxRow, maxCol);
    onAskAi({
      rangeLabel,
      startRow: minRow,
      startCol: minCol,
      endRow: maxRow,
      endCol: maxCol,
      headers: headers.length > 0 ? headers : undefined,
      dataPreview,
      initialPrompt: prompt
    });
    setInlineAiOpen(false);
    setInlineAiPrompt("");
  };

  const handleSelectSheet = (idx: number) => {
    onChange({ ...workbook, activeSheetIndex: idx });
    setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    setEditingCell(null);
  };

  const handleAddSheet = () => {
    const newName = `Sheet${workbook.sheets.length + 1}`;
    const newSheet: SheetData = {
      name: newName,
      rowCount: 50,
      colCount: 26,
      cells: {}
    };
    onChange({
      ...workbook,
      sheets: [...workbook.sheets, newSheet],
      activeSheetIndex: workbook.sheets.length
    });
  };

  // ---- virtualization window ----
  const rowCount = currentSheet.rowCount;
  const bodyStartRow = frozen ? 1 : 0;
  const visibleStart = Math.max(
    bodyStartRow,
    Math.floor(scrollTop / DEFAULT_ROW_HEIGHT) - OVERSCAN_ROWS
  );
  const visibleEnd = Math.min(
    rowCount,
    Math.ceil((scrollTop + viewportHeight) / DEFAULT_ROW_HEIGHT) + OVERSCAN_ROWS
  );
  const topSpacer = Math.max(0, (visibleStart - bodyStartRow) * DEFAULT_ROW_HEIGHT);
  const bottomSpacer = Math.max(0, (rowCount - visibleEnd) * DEFAULT_ROW_HEIGHT);
  const visibleRows: number[] = [];
  for (let r = Math.max(visibleStart, bodyStartRow); r < visibleEnd; r++) visibleRows.push(r);

  const renderRow = (rIdx: number) => (
    <div key={`row-${rIdx}`} className="ds-grid-row">
      <div
        className={`ds-row-head ${rIdx >= minRow && rIdx <= maxRow ? "ds-head-selected" : ""}`}
        style={{ width: HEADER_COL_WIDTH, height: DEFAULT_ROW_HEIGHT }}
      >
        {rIdx + 1}
      </div>
      {Array.from({ length: currentSheet.colCount }).map((_, cIdx) => {
        const cellKey = `${rIdx}:${cIdx}`;
        const cell = currentSheet.cells[cellKey];
        const selected = isCellSelected(rIdx, cIdx);
        const isActive = rIdx === activeRow && cIdx === activeCol;
        const isEditing = editingCell?.row === rIdx && editingCell?.col === cIdx;

        const displayVal = cell?.displayValue ?? (cell?.value !== null && cell?.value !== undefined ? String(cell.value) : "");
        const isNumber = typeof cell?.value === "number";
        const isErr = isFormulaError(displayVal);

        return (
          <div
            key={`cell-${cellKey}`}
            onMouseDown={(e) => handleCellMouseDown(rIdx, cIdx, e)}
            onMouseEnter={() => handleCellMouseEnter(rIdx, cIdx)}
            onDoubleClick={() => handleCellDoubleClick(rIdx, cIdx)}
            className={`ds-cell${isEditing ? " ds-cell-editing" : selected ? " ds-cell-selected" : ""}${isActive && !isEditing ? " ds-cell-active" : ""}${isErr ? " ds-cell-error" : ""}`}
            style={{
              width: getColWidth(cIdx),
              height: DEFAULT_ROW_HEIGHT,
              justifyContent:
                cell?.style?.align === "center"
                  ? "center"
                  : cell?.style?.align === "right" || (!cell?.style?.align && isNumber)
                    ? "flex-end"
                    : "flex-start",
              fontWeight: cell?.style?.bold ? 600 : "normal",
              fontStyle: cell?.style?.italic ? "italic" : "normal"
            }}
          >
            {isEditing ? (
              <input
                ref={editInputRef}
                type="text"
                value={editInputValue}
                onChange={(e) => setEditInputValue(e.target.value)}
                onBlur={commitCellEdit}
                className="ds-cell-input"
              />
            ) : (
              <span className="ds-cell-text">{displayVal}</span>
            )}

            {isActive && !isEditing && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setInlineAiOpen(true);
                }}
                className="ds-ai-pill"
              >
                <Sparkles size={12} />
                <span>{t("docStudio.aiEdit")}</span>
              </div>
            )}

            {isActive && inlineAiOpen && (
              <div className="ds-inline-ai" onClick={(e) => e.stopPropagation()}>
                <div className="ds-inline-ai-head">
                  <div className="ds-inline-ai-title">
                    <Sparkles size={12} />
                    <span>{t("docStudio.aiEditRange", { range: rangeToLabel(minRow, minCol, maxRow, maxCol) })}</span>
                  </div>
                  <button type="button" onClick={() => setInlineAiOpen(false)} className="ds-icon-btn">
                    <X size={12} />
                  </button>
                </div>
                <div className="ds-inline-ai-body">
                  <input
                    ref={inlineAiInputRef}
                    type="text"
                    value={inlineAiPrompt}
                    onChange={(e) => setInlineAiPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        triggerAiEdit(inlineAiPrompt);
                      } else if (e.key === "Escape") {
                        setInlineAiOpen(false);
                      }
                    }}
                    placeholder={t("docStudio.inlineAiPlaceholder")}
                    className="ds-input"
                  />
                  <button
                    type="button"
                    onClick={() => triggerAiEdit(inlineAiPrompt)}
                    className="ds-btn ds-btn-primary ds-btn-sm"
                    title={t("docStudio.send")}
                  >
                    <Send size={12} />
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className="ds-sheet"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{ fontSize: `${Math.round(13 * (zoom / 100))}px` }}
    >
      {/* Toolbar */}
      <div className="ds-toolbar">
        <div className="ds-menu-wrap" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="ds-btn ds-btn-ghost"
            title={t("docStudio.menu")}
          >
            <span>{t("docStudio.menu")}</span>
            <ChevronDown size={13} />
          </button>
          {menuOpen && (
            <div className="ds-menu" onClick={() => setMenuOpen(false)}>
              <button type="button" className="ds-menu-item" onClick={() => handleInsertRow(true)}>
                {t("docStudio.insertRowAbove")}
              </button>
              <button type="button" className="ds-menu-item" onClick={() => handleInsertRow(false)}>
                {t("docStudio.insertRowBelow")}
              </button>
              <button type="button" className="ds-menu-item" onClick={() => handleInsertCol(true)}>
                {t("docStudio.insertColLeft")}
              </button>
              <button type="button" className="ds-menu-item" onClick={() => handleInsertCol(false)}>
                {t("docStudio.insertColRight")}
              </button>
              <div className="ds-menu-sep" />
              <button
                type="button"
                className="ds-menu-item"
                onClick={() => setFrozenFirstRow(!frozen)}
              >
                {frozen ? t("docStudio.unfreezeFirstRow") : t("docStudio.freezeFirstRow")}
              </button>
              <div className="ds-menu-sep" />
              <button type="button" className="ds-menu-item ds-menu-item-danger" onClick={handleClearSelection}>
                {t("docStudio.clearSelectedCells")}
              </button>
            </div>
          )}
        </div>

        <div className="ds-toolbar-sep" />

        <button type="button" onClick={onUndo} disabled={!canUndo} className="ds-icon-btn" title={t("docStudio.undo")}>
          <Undo2 size={14} />
        </button>
        <button type="button" onClick={onRedo} disabled={!canRedo} className="ds-icon-btn" title={t("docStudio.redo")}>
          <Redo2 size={14} />
        </button>

        <div className="ds-toolbar-sep" />

        <button type="button" onClick={handleToggleBold} className="ds-icon-btn" title={t("docStudio.bold")}>
          <Bold size={14} />
        </button>
        <button type="button" onClick={handleToggleItalic} className="ds-icon-btn" title={t("docStudio.italic")}>
          <Italic size={14} />
        </button>

        <div className="ds-toolbar-sep" />

        <button type="button" onClick={() => handleSetAlign("left")} className="ds-icon-btn" title={t("docStudio.alignLeft")}>
          <AlignLeft size={14} />
        </button>
        <button type="button" onClick={() => handleSetAlign("center")} className="ds-icon-btn" title={t("docStudio.alignCenter")}>
          <AlignCenter size={14} />
        </button>
        <button type="button" onClick={() => handleSetAlign("right")} className="ds-icon-btn" title={t("docStudio.alignRight")}>
          <AlignRight size={14} />
        </button>

        <div className="ds-toolbar-spacer" />

        <button
          type="button"
          onClick={() => triggerAiEdit()}
          className="ds-btn ds-btn-secondary"
          title={t("docStudio.aiEdit")}
        >
          <Sparkles size={13} />
          <span>{t("docStudio.aiEdit")} {rangeToLabel(minRow, minCol, maxRow, maxCol)}</span>
        </button>
      </div>

      {/* Formula bar */}
      <div className="ds-formula-bar">
        <div className="ds-cell-ref">{activeCellAddress}</div>
        <div className="ds-fx">fx</div>
        <input
          type="text"
          value={formulaBarValue}
          onChange={(e) => {
            if (editingCell) {
              setEditInputValue(e.target.value);
            } else {
              setEditingCell({ row: activeRow, col: activeCol });
              setEditInputValue(e.target.value);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitCellEdit();
          }}
          className="ds-input ds-formula-input"
          placeholder={t("docStudio.formulaPlaceholder")}
        />
      </div>

      {/* Grid (virtualized rows) */}
      <div ref={scrollRef} className="ds-grid-scroll">
        <div className="ds-grid">
          <div className="ds-grid-header">
            <div
              className="ds-corner"
              style={{ width: HEADER_COL_WIDTH, height: HEADER_ROW_HEIGHT }}
            />
            {Array.from({ length: currentSheet.colCount }).map((_, cIdx) => (
              <div
                key={`col-${cIdx}`}
                className={`ds-col-head ${cIdx >= minCol && cIdx <= maxCol ? "ds-head-selected" : ""}`}
                style={{ width: getColWidth(cIdx), height: HEADER_ROW_HEIGHT }}
              >
                {colIndexToLetter(cIdx)}
                <div
                  className="ds-col-resize"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setResizingCol({ col: cIdx, startX: e.clientX, startWidth: getColWidth(cIdx) });
                  }}
                />
              </div>
            ))}
          </div>

          {frozen && rowCount > 0 ? (
            <div className="ds-grid-frozen">{renderRow(0)}</div>
          ) : null}

          <div style={{ height: topSpacer }} />
          {visibleRows.map(renderRow)}
          <div style={{ height: bottomSpacer }} />
        </div>
      </div>

      {/* Status bar */}
      <div className="ds-statusbar">
        <div className="ds-sheet-tabs">
          <button type="button" onClick={handleAddSheet} className="ds-icon-btn" title={t("docStudio.addSheet")}>
            <Plus size={14} />
          </button>
          {workbook.sheets.map((sheet, sIdx) => (
            <button
              key={sheet.name}
              type="button"
              onClick={() => handleSelectSheet(sIdx)}
              className={`ds-sheet-tab ${sIdx === activeSheetIndex ? "ds-sheet-tab-active" : ""}`}
            >
              {sheet.name}
            </button>
          ))}
        </div>

        <div className="ds-statusbar-right">
          {selectionStats.count > 1 && (
            <div className="ds-stats">
              <span>
                {t("docStudio.count")}: <b>{selectionStats.count}</b>
              </span>
              {selectionStats.numCount > 0 && (
                <>
                  <span>
                    {t("docStudio.sum")}: <b>{selectionStats.sum}</b>
                  </span>
                  <span>
                    {t("docStudio.avg")}: <b>{selectionStats.avg}</b>
                  </span>
                </>
              )}
            </div>
          )}

          <div className="ds-zoom">
            <button type="button" onClick={() => setZoom((z) => Math.max(50, z - 10))} title={t("docStudio.zoomOut")}>
              -
            </button>
            <span>{zoom}%</span>
            <button type="button" onClick={() => setZoom((z) => Math.min(200, z + 10))} title={t("docStudio.zoomIn")}>
              +
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
