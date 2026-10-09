import test from "node:test";
import assert from "node:assert/strict";
import Papa from "papaparse";
import * as fs from "node:fs";
import * as XLSX from "xlsx";

// Coordinate functions
function colIndexToLetter(col) {
  let letter = "";
  let c = col;
  while (c >= 0) {
    letter = String.fromCharCode((c % 26) + 65) + letter;
    c = Math.floor(c / 26) - 1;
  }
  return letter;
}

function letterToColIndex(letter) {
  let col = 0;
  for (let i = 0; i < letter.length; i++) {
    col = col * 26 + (letter.charCodeAt(i) - 64);
  }
  return col - 1;
}

function rowColToA1(row, col) {
  return `${colIndexToLetter(col)}${row + 1}`;
}

function a1ToRowCol(a1) {
  const match = a1.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  const col = letterToColIndex(match[1]);
  const row = parseInt(match[2], 10) - 1;
  return { row, col };
}

function isOfficeOrDocFile(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return [".csv", ".tsv", ".xlsx", ".xls", ".md", ".txt", ".json"].includes(ext);
}

// Formula Evaluator
function evaluateFormula(formula, cells) {
  if (!formula.startsWith("=")) return formula;
  const expr = formula.slice(1).trim().toUpperCase();

  const getRangeValues = (rangeStr) => {
    const parts = rangeStr.split(":");
    if (parts.length !== 2) return [];
    const p1 = a1ToRowCol(parts[0]);
    const p2 = a1ToRowCol(parts[1]);
    if (!p1 || !p2) return [];
    const minR = Math.min(p1.row, p2.row);
    const maxR = Math.max(p1.row, p2.row);
    const minC = Math.min(p1.col, p2.col);
    const maxC = Math.max(p1.col, p2.col);

    const values = [];
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const v = cells[`${r}:${c}`]?.value;
        if (typeof v === "number") values.push(v);
        else if (v && !isNaN(Number(v))) values.push(Number(v));
      }
    }
    return values;
  };

  const sumMatch = expr.match(/^SUM\(([A-Z0-9:]+)\)$/);
  if (sumMatch) {
    const vals = getRangeValues(sumMatch[1]);
    return vals.reduce((a, b) => a + b, 0);
  }

  const avgMatch = expr.match(/^AVERAGE\(([A-Z0-9:]+)\)$/);
  if (avgMatch) {
    const vals = getRangeValues(avgMatch[1]);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : 0;
  }

  const countMatch = expr.match(/^COUNT\(([A-Z0-9:]+)\)$/);
  if (countMatch) {
    const vals = getRangeValues(countMatch[1]);
    return vals.length;
  }

  const maxMatch = expr.match(/^MAX\(([A-Z0-9:]+)\)$/);
  if (maxMatch) {
    const vals = getRangeValues(maxMatch[1]);
    return vals.length ? Math.max(...vals) : 0;
  }

  const minMatch = expr.match(/^MIN\(([A-Z0-9:]+)\)$/);
  if (minMatch) {
    const vals = getRangeValues(minMatch[1]);
    return vals.length ? Math.min(...vals) : 0;
  }

  const ref = a1ToRowCol(expr);
  if (ref) {
    const v = cells[`${ref.row}:${ref.col}`]?.value;
    if (typeof v === "boolean") return String(v);
    return v !== null && v !== undefined ? v : "";
  }

  return formula;
}

test("coordinate conversion handles columns and addresses accurately", () => {
  assert.equal(colIndexToLetter(0), "A");
  assert.equal(colIndexToLetter(25), "Z");
  assert.equal(colIndexToLetter(26), "AA");
  assert.equal(colIndexToLetter(27), "AB");

  assert.equal(letterToColIndex("A"), 0);
  assert.equal(letterToColIndex("Z"), 25);
  assert.equal(letterToColIndex("AA"), 26);
  assert.equal(letterToColIndex("AB"), 27);

  assert.equal(rowColToA1(0, 0), "A1");
  assert.equal(rowColToA1(10, 4), "E11");

  assert.deepEqual(a1ToRowCol("A1"), { row: 0, col: 0 });
  assert.deepEqual(a1ToRowCol("E11"), { row: 10, col: 4 });
  assert.equal(a1ToRowCol("invalid"), null);
});

test("isOfficeOrDocFile correctly detects supported document formats", () => {
  assert.equal(isOfficeOrDocFile("/path/to/table.csv"), true);
  assert.equal(isOfficeOrDocFile("/path/to/data.xlsx"), true);
  assert.equal(isOfficeOrDocFile("/path/to/old.xls"), true);
  assert.equal(isOfficeOrDocFile("/path/to/report.md"), true);
  assert.equal(isOfficeOrDocFile("/path/to/notes.txt"), true);
  assert.equal(isOfficeOrDocFile("/path/to/config.json"), true);
  assert.equal(isOfficeOrDocFile("/path/to/image.png"), false);
  assert.equal(isOfficeOrDocFile("/path/to/script.py"), false);
});

test("CSV parse and export round-trip preserves tabular structure", () => {
  const csvRaw = `日期,类型,播放人数,播放量\n2026/9/16,听视频,2442,6012\n2026/9/16,听微博,24816,56357`;
  const parsed = Papa.parse(csvRaw, { skipEmptyLines: false });
  const rows = parsed.data;

  assert.equal(rows.length, 3);
  assert.equal(rows[0][0], "日期");
  assert.equal(rows[0][3], "播放量");
  assert.equal(rows[1][1], "听视频");
  assert.equal(rows[2][2], "24816");

  const unparsed = Papa.unparse(rows);
  assert.ok(unparsed.includes("听微博"));
  assert.ok(unparsed.includes("24816"));
});

test("Excel XLSX creation and reading parses cell values correctly", () => {
  const wb = XLSX.utils.book_new();
  const wsData = [
    ["Item", "Price", "Qty"],
    ["Apple", 5, 10],
    ["Banana", 3, 20]
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");

  const base64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
  assert.ok(base64.length > 0);

  const readWb = XLSX.read(base64, { type: "base64" });
  assert.deepEqual(readWb.SheetNames, ["Sheet1"]);
  const readSheet = readWb.Sheets["Sheet1"];
  assert.equal(readSheet["A1"].v, "Item");
  assert.equal(readSheet["B2"].v, 5);
  assert.equal(readSheet["C3"].v, 20);
});

test("evaluateFormula computes mathematical and statistical ranges accurately", () => {
  const cells = {
    "0:0": { value: 10 },
    "1:0": { value: 20 },
    "2:0": { value: 30 },
    "3:0": { value: 40 },
    "4:0": { value: 50 }
  };

  assert.equal(evaluateFormula("=SUM(A1:A5)", cells), 150);
  assert.equal(evaluateFormula("=AVERAGE(A1:A5)", cells), 30);
  assert.equal(evaluateFormula("=COUNT(A1:A5)", cells), 5);
  assert.equal(evaluateFormula("=MAX(A1:A5)", cells), 50);
  assert.equal(evaluateFormula("=MIN(A1:A5)", cells), 10);
  assert.equal(evaluateFormula("=A2", cells), 20);
});

test("DocStudio collapses updates JSON into a summary via renderCodeBlock seam", () => {
  
  const streamItem = fs.readFileSync("src/components/CLI/StreamItem.tsx", "utf8");
  const chatView = fs.readFileSync("src/components/CLI/ChatView.tsx", "utf8");
  const copilot = fs.readFileSync("src/components/DocStudio/DocStudioCopilot.tsx", "utf8");

  // Seam exists and falls back to the default code block when unused.
  assert.match(streamItem, /export const MarkdownCodeBlockContext = createContext/);
  assert.match(streamItem, /renderCodeBlock\?\.\(lang, code\.join/);
  assert.match(streamItem, /CodeBlockCard/);
  // ChatView exposes and provides the override.
  assert.match(chatView, /renderCodeBlock\?: \(lang: string, code: string, closed: boolean\)/);
  assert.match(chatView, /MarkdownCodeBlockContext\.Provider/);
  // DocStudio wires it only for sheets.
  assert.match(copilot, /renderCodeBlock=\{isSheet \? renderCodeBlock : undefined\}/);
  assert.match(copilot, /CellUpdatesSummary/);
});

test("DocStudio IPC handlers are sender- and path-guarded", () => {
  const src = fs.readFileSync("electron/docStudioBridge.ts", "utf8");

  for (const channel of [
    "docStudio:readFile",
    "docStudio:writeFile",
    "docStudio:watchFile",
    "docStudio:showItemInFolder"
  ]) {
    const idx = src.indexOf(`"${channel}"`);
    assert.ok(idx >= 0, `${channel} handler missing`);
    const body = src.slice(idx, idx + 700);
    assert.match(body, /isDocStudioWindowSender\(event\.sender\)/, `${channel} lacks sender check`);
    assert.match(body, /isAllowedDocPath|isOfficeOrDocFile/, `${channel} lacks path check`);
  }

  // unwatchFile: sender check only.
  const unwatchIdx = src.indexOf('"docStudio:unwatchFile"');
  const unwatchBody = src.slice(unwatchIdx, unwatchIdx + 400);
  assert.match(unwatchBody, /isDocStudioWindowSender\(event\.sender\)/);

  // openWindow: path must be empty or absolute doc file.
  const openIdx = src.indexOf('"docStudio:openWindow"');
  const openBody = src.slice(openIdx, openIdx + 500);
  assert.match(openBody, /isAllowedDocPath|isOfficeOrDocFile/);
});

test("electron/menu.ts labels come from tMain with no hardcoded CJK", () => {
  const src = fs.readFileSync("electron/menu.ts", "utf8");
  assert.ok(!/[\u4e00-\u9fff]/.test(src), "menu.ts still contains CJK literals");
  for (const key of [
    "menu.file",
    "menu.file.openDocument",
    "menu.file.newSpreadsheet",
    "menu.file.closeWindow",
    "contextMenu.openInDocStudio"
  ]) {
    assert.ok(src.includes(`tMain("${key}"`), `menu.ts missing tMain("${key}")`);
  }
});
