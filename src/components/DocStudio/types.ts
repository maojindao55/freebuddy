export type DocKind = "sheet" | "markdown" | "text" | "json" | "office";

export interface CellValue {
  value: string | number | boolean | null;
  formula?: string;
  displayValue?: string;
  style?: {
    bold?: boolean;
    italic?: boolean;
    align?: "left" | "center" | "right";
    color?: string;
    bg?: string;
  };
}

export interface SheetData {
  name: string;
  rowCount: number;
  colCount: number;
  cells: Record<string, CellValue>; // Key is "row:col", e.g. "0:0" for A1
  colWidths?: Record<number, number>;
  rowHeights?: Record<number, number>;
}

export interface SheetWorkbookData {
  sheets: SheetData[];
  activeSheetIndex: number;
}

export interface CellSelection {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface SelectionContext {
  rangeLabel: string; // e.g. "A1:E10"
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  headers?: string[];
  dataPreview: (string | number)[][];
  initialPrompt?: string;
}

export interface DocTab {
  id: string;
  filePath: string;
  fileName: string;
  ext: string;
  kind: DocKind;
  isDirty: boolean;
  content?: string; // For text/markdown/json
  sheetData?: SheetWorkbookData; // For spreadsheet
  previewUrl?: string; // For engine-rendered office files (kind: "office")
}

export interface CellUpdateProposal {
  sheetName?: string;
  updates: Array<{
    cell: string; // e.g. "A1" or "F2"
    value: string | number | null;
    formula?: string;
  }>;
  explanation: string;
}
