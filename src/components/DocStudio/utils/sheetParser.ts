import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { SheetWorkbookData, SheetData, CellValue } from "../types";
import { evaluateFormula as engineEvaluate, recalculateSheet } from "./formulaEngine";


export function colIndexToLetter(col: number): string {
  let letter = "";
  let c = col;
  while (c >= 0) {
    letter = String.fromCharCode((c % 26) + 65) + letter;
    c = Math.floor(c / 26) - 1;
  }
  return letter;
}

export function letterToColIndex(letter: string): number {
  let col = 0;
  for (let i = 0; i < letter.length; i++) {
    col = col * 26 + (letter.charCodeAt(i) - 64);
  }
  return col - 1;
}

export function rowColToA1(row: number, col: number): string {
  return `${colIndexToLetter(col)}${row + 1}`;
}

export function a1ToRowCol(a1: string): { row: number; col: number } | null {
  const match = a1.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  const col = letterToColIndex(match[1]);
  const row = parseInt(match[2], 10) - 1;
  return { row, col };
}

export function rangeToLabel(startRow: number, startCol: number, endRow: number, endCol: number): string {
  const minR = Math.min(startRow, endRow);
  const maxR = Math.max(startRow, endRow);
  const minC = Math.min(startCol, endCol);
  const maxC = Math.max(startCol, endCol);

  if (minR === maxR && minC === maxC) {
    return rowColToA1(minR, minC);
  }
  return `${rowColToA1(minR, minC)}:${rowColToA1(maxR, maxC)}`;
}

export function parseCsvToWorkbook(csvText: string, fileName = "Sheet1"): SheetWorkbookData {
  const parsed = Papa.parse(csvText, {
    skipEmptyLines: false,
    dynamicTyping: false
  });

  const rawRows = parsed.data as string[][];
  const rowCount = Math.max(rawRows.length, 50);
  let maxCol = 10;
  rawRows.forEach((r) => {
    if (r.length > maxCol) maxCol = r.length;
  });
  const colCount = Math.max(maxCol + 5, 26);

  const cells: Record<string, CellValue> = {};

  rawRows.forEach((row, rIdx) => {
    row.forEach((val, cIdx) => {
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        const strVal = String(val);
        if (strVal.startsWith("=")) {
          // Agents sometimes persist formulas into CSV; treat them as formulas.
          cells[`${rIdx}:${cIdx}`] = {
            value: null,
            formula: strVal,
            displayValue: strVal
          };
          return;
        }
        const num = Number(strVal);
        const isNum = !isNaN(num) && strVal.trim() !== "";
        cells[`${rIdx}:${cIdx}`] = {
          value: isNum ? num : strVal,
          displayValue: strVal
        };
      }
    });
  });

  return {
    sheets: [
      recalculateSheet({
        name: fileName.replace(/\.[^/.]+$/, ""),
        rowCount,
        colCount,
        cells
      })
    ],
    activeSheetIndex: 0
  };
}

export function parseXlsxToWorkbook(bufferBase64: string): SheetWorkbookData {
  const workbook = XLSX.read(bufferBase64, { type: "base64", cellFormula: true, cellStyles: true });
  const sheets: SheetData[] = [];

  workbook.SheetNames.forEach((sheetName) => {
    const ws = workbook.Sheets[sheetName];
    const range = XLSX.utils.decode_range(ws["!ref"] || "A1:Z50");
    const rowCount = Math.max(range.e.r + 15, 50);
    const colCount = Math.max(range.e.c + 5, 26);
    const cells: Record<string, CellValue> = {};

    for (let r = 0; r <= range.e.r; r++) {
      for (let c = 0; c <= range.e.c; c++) {
        const cellAddress = XLSX.utils.encode_cell({ r, c });
        const cell = ws[cellAddress];
        if (cell) {
          cells[`${r}:${c}`] = {
            value: cell.v ?? null,
            formula: cell.f ? `=${cell.f}` : undefined,
            displayValue: cell.w || (cell.v !== undefined ? String(cell.v) : "")
          };
        }
      }
    }

    sheets.push(
      recalculateSheet({
        name: sheetName,
        rowCount,
        colCount,
        cells
      })
    );
  });

  if (sheets.length === 0) {
    sheets.push({
      name: "Sheet1",
      rowCount: 50,
      colCount: 26,
      cells: {}
    });
  }

  return {
    sheets,
    activeSheetIndex: 0
  };
}

export function exportWorkbookToCsv(sheet: SheetData): string {
  // Find extent of data
  let maxR = 0;
  let maxC = 0;
  Object.keys(sheet.cells).forEach((key) => {
    const [rStr, cStr] = key.split(":");
    const r = parseInt(rStr, 10);
    const c = parseInt(cStr, 10);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  });

  const rows: (string | number)[][] = [];
  for (let r = 0; r <= maxR; r++) {
    const row: (string | number)[] = [];
    for (let c = 0; c <= maxC; c++) {
      const cell = sheet.cells[`${r}:${c}`];
      const val = cell?.value;
      row.push(typeof val === "boolean" ? String(val) : (val ?? ""));
    }
    rows.push(row);
  }

  return Papa.unparse(rows);
}

export function exportWorkbookToXlsx(wbData: SheetWorkbookData): string {
  const wb = XLSX.utils.book_new();

  wbData.sheets.forEach((sheet) => {
    let maxR = 0;
    let maxC = 0;
    Object.keys(sheet.cells).forEach((key) => {
      const [rStr, cStr] = key.split(":");
      const r = parseInt(rStr, 10);
      const c = parseInt(cStr, 10);
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    });

    const aoa: any[][] = [];
    for (let r = 0; r <= maxR; r++) {
      const row: any[] = [];
      for (let c = 0; c <= maxC; c++) {
        const cell = sheet.cells[`${r}:${c}`];
        if (cell?.formula) {
          row.push({
            f: cell.formula.replace(/^=/, ""),
            v: typeof cell.value === "boolean" ? String(cell.value) : (cell.value ?? "")
          });
        } else {
          row.push(cell?.value ?? null);
        }
      }
      aoa.push(row);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  });

  return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}

/** Used extent: max row/col index holding a non-empty value or formula, +1. */
export function usedExtent(sheet: SheetData): { rows: number; cols: number } {
  let maxR = -1;
  let maxC = -1;
  for (const [key, cell] of Object.entries(sheet.cells)) {
    const hasContent =
      cell?.formula ||
      (cell?.value !== null && cell?.value !== undefined && cell?.value !== "");
    if (!hasContent) continue;
    const [r, c] = key.split(":").map(Number);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  return { rows: maxR + 1, cols: maxC + 1 };
}

// Thin wrapper over the real engine in formulaEngine.ts.
export function evaluateFormula(formula: string, cells: Record<string, CellValue>): string | number {
  const v = engineEvaluate(formula, cells);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return v;
}
