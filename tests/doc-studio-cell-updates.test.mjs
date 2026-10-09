import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temp = mkdtempSync(path.join(tmpdir(), "fb-ds-updates-"));
test.after(() => rmSync(temp, { recursive: true, force: true }));
await build({
  entryPoints: ["src/components/DocStudio/CellUpdatesSummary.tsx"],
  outfile: path.join(temp, "summary.mjs"),
  bundle: true,
  platform: "node",
  format: "esm"
});
await build({
  entryPoints: ["src/components/DocStudio/utils/sheetParser.ts"],
  outfile: path.join(temp, "parser.mjs"),
  bundle: true,
  platform: "node",
  format: "esm"
});
const { updatesRangeLabel } = await import(
  pathToFileURL(path.join(temp, "summary.mjs")).href
);
const { usedExtent, parseXlsxToWorkbook, exportWorkbookToCsv } = await import(
  pathToFileURL(path.join(temp, "parser.mjs")).href
);
const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));

test("updatesRangeLabel collapses single cell", () => {
  assert.equal(updatesRangeLabel([{ cell: "H2", value: 1 }]), "H2");
});

test("updatesRangeLabel returns column and block ranges", () => {
  const col = Array.from({ length: 5 }, (_, i) => ({ cell: `H${i + 2}`, value: i }));
  assert.equal(updatesRangeLabel(col), "H2:H6");
  const block = [
    { cell: "H2", value: 1 },
    { cell: "I5", value: 1 },
    { cell: "A1", value: 1 }
  ];
  assert.equal(updatesRangeLabel(block), "A1:I5");
});

test("updatesRangeLabel ignores invalid refs", () => {
  assert.equal(
    updatesRangeLabel([
      { cell: "nope", value: 1 },
      { cell: "B3", value: 2 },
      { cell: "", value: 3 }
    ]),
    "B3"
  );
  assert.equal(updatesRangeLabel([{ cell: "??", value: 1 }]), "");
});

test("usedExtent ignores padded rowCount/colCount", () => {
  const sheet = {
    name: "S",
    rowCount: 5000,
    colCount: 26,
    cells: {
      "0:0": { value: "h", displayValue: "h" },
      "0:3": { value: "x", displayValue: "x" },
      "14:3": { value: null, formula: "=A1", displayValue: "h" },
      "20:10": { value: "", displayValue: "" }
    }
  };
  assert.deepEqual(usedExtent(sheet), { rows: 15, cols: 4 });
  assert.deepEqual(usedExtent({ ...sheet, cells: {} }), { rows: 0, cols: 0 });
});

test("xlsx round-trip preserves values and formulas", () => {
  const aoa = [
    [10, 20, null],
    [3, { f: "A1*B1", v: 200 }, "x"]
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "S1");
  const base64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" });

  const parsed = parseXlsxToWorkbook(base64);
  const sheet = parsed.sheets[0];
  assert.equal(sheet.cells["0:0"].value, 10);
  assert.equal(sheet.cells["1:1"].formula, "=A1*B1");
  // recalculated by the engine, not the stale cached v
  assert.equal(sheet.cells["1:1"].value, 200);
  assert.equal(sheet.cells["1:2"].value, "x");
});
