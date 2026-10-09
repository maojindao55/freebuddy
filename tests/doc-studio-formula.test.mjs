import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temp = mkdtempSync(path.join(tmpdir(), 'fb-ds-formula-'));
test.after(() => rmSync(temp, { recursive: true, force: true }));
await build({
  entryPoints: ['src/components/DocStudio/utils/formulaEngine.ts'],
  outfile: path.join(temp, 'engine.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm'
});
const engine = await import(pathToFileURL(path.join(temp, 'engine.mjs')).href);
const { evaluateFormula, recalculateSheet, formatCellValue } = engine;

const cell = (value) => ({ value, displayValue: String(value ?? '') });
const fcell = (formula) => ({ value: null, formula, displayValue: formula });
const cellsOf = (rows) => {
  const cells = {};
  rows.forEach((row, r) => row.forEach((v, c) => {
    if (v === null || v === undefined) return;
    cells[`${r}:${c}`] = typeof v === 'string' && v.startsWith('=') ? fcell(v) : cell(v);
  }));
  return cells;
};
const evalIn = (formula, cells) => evaluateFormula(formula, cells ?? {});

test('user-reported IFERROR/ROUND formula evaluates against numeric-string cells', () => {
  const cells = cellsOf([
    ['日期', '类型', '播放人数', '播放量', '播放时长/分钟'],
    ['2025-11-01', '微博视频', '124530', '356789', '1823455']
  ]);
  // E2*60/C2 = 1823455*60/124530 ≈ 878.56
  const v = evalIn('=IFERROR(ROUND(E2*60/C2,1),"")', cells);
  assert.equal(v, 878.6);
});

test('IFERROR yields "" when the divisor cell is zero or empty', () => {
  const zero = cellsOf([[null, null, null, null, 100], [0, 0, null, null, 10]]);
  assert.equal(evalIn('=IFERROR(ROUND(E2*60/C2,1),"")', zero), '');
  const empty = cellsOf([[null, null, null, null, 100]]);
  assert.equal(evalIn('=IFERROR(ROUND(E2*60/C2,1),"")', empty), '');
});

test('operator precedence and exponent associativity', () => {
  assert.equal(evalIn('=1+2*3^2'), 19);
  assert.equal(evalIn('=2^3^2'), 64); // left-assoc, like Excel
  assert.equal(evalIn('=-2^2'), 4); // unary binds tighter than ^
  assert.equal(evalIn('=2*-3'), -6);
  assert.equal(evalIn('=10%*200'), 20);
});

test('concat operator and text coercion', () => {
  assert.equal(evalIn('="a"&1'), 'a1');
  assert.equal(evalIn('="a"&TRUE'), 'aTRUE');
  assert.equal(evalIn('="x" & " " & "y"'), 'x y');
});

test('comparisons and IF', () => {
  const cells = cellsOf([[150]]);
  assert.equal(evalIn('=IF(A1>100,"高","低")', cells), '高');
  assert.equal(evalIn('=IF(A1<=100,"高","低")', cells), '低');
  assert.equal(evalIn('=A1=150', cells), true);
  assert.equal(evalIn('=A1<>150', cells), false);
});

test('aggregate functions over ranges incl. $ refs', () => {
  const cells = cellsOf([[1], [2], [3], ['x'], ['5']]);
  assert.equal(evalIn('=SUM(A1:A5)', cells), 11); // numeric strings counted
  assert.equal(evalIn('=SUM($A$1:$A$5)', cells), 11);
  assert.equal(evalIn('=AVERAGE(A1:A3)', cells), 2);
  assert.equal(evalIn('=COUNT(A1:A5)', cells), 4);
  assert.equal(evalIn('=COUNTA(A1:A5)', cells), 5);
  assert.equal(evalIn('=MAX(A1:A5)', cells), 5);
  assert.equal(evalIn('=MIN(A1:A5)', cells), 1);
});

test('criteria functions SUMIF/COUNTIF/AVERAGEIF', () => {
  const cells = cellsOf([
    ['移动端', 100],
    ['PC端', 200],
    ['移动端', 50],
    ['PC端', 10]
  ]);
  assert.equal(evalIn('=COUNTIF(A1:A4,"移动端")', cells), 2);
  assert.equal(evalIn('=SUMIF(A1:A4,"移动端",B1:B4)', cells), 150);
  assert.equal(evalIn('=SUMIF(B1:B4,">100")', cells), 200);
  assert.equal(evalIn('=COUNTIF(B1:B4,">=50")', cells), 3);
  assert.equal(evalIn('=AVERAGEIF(A1:A4,"PC端",B1:B4)', cells), 105);
});

test('math and text functions', () => {
  assert.equal(evalIn('=ROUND(3.14159,2)'), 3.14);
  assert.equal(evalIn('=ROUNDUP(3.141,1)'), 3.2);
  assert.equal(evalIn('=ROUNDDOWN(3.99,1)'), 3.9);
  assert.equal(evalIn('=INT(-1.5)'), -2);
  assert.equal(evalIn('=ABS(-3)'), 3);
  assert.equal(evalIn('=MOD(7,3)'), 1);
  assert.equal(evalIn('=MOD(-7,3)'), 2);
  assert.equal(evalIn('=POWER(2,10)'), 1024);
  assert.equal(evalIn('=SQRT(9)'), 3);
  assert.equal(evalIn('=LEN("abc")'), 3);
  assert.equal(evalIn('=LEFT("abcdef",2)'), 'ab');
  assert.equal(evalIn('=RIGHT("abcdef",2)'), 'ef');
  assert.equal(evalIn('=MID("abcdef",2,3)'), 'bcd');
  assert.equal(evalIn('=UPPER("aBc")'), 'ABC');
  assert.equal(evalIn('=LOWER("aBc")'), 'abc');
  assert.equal(evalIn('=TRIM("  a  b  ")'), 'a b');
  assert.equal(evalIn('=CONCAT("a",1,"b")'), 'a1b');
});

test('logical functions', () => {
  assert.equal(evalIn('=AND(TRUE,1)'), true);
  assert.equal(evalIn('=AND(TRUE,0)'), false);
  assert.equal(evalIn('=OR(FALSE,1)'), true);
  assert.equal(evalIn('=NOT(TRUE)'), false);
});

test('error values propagate and IFERROR catches them', () => {
  assert.equal(evalIn('=1/0'), '#DIV/0!');
  assert.equal(evalIn('=1/0+1'), '#DIV/0!');
  assert.equal(evalIn('=NOSUCHFN(1)'), '#NAME?');
  assert.equal(evalIn('="a"*2'), '#VALUE!');
  assert.equal(evalIn('=IFERROR(1/0,"fb")'), 'fb');
  assert.equal(evalIn('=IFERROR(SQRT(-1),"neg")'), 'neg');
  assert.equal(evalIn('=1+'), '#ERROR!');
});

test('chained formula refs and cycle detection', () => {
  const cells = cellsOf([[10, '=A1*2', '=B1+5']]);
  assert.equal(evalIn('=C1', cells), 25);
  assert.equal(evalIn('=B1', cells), 20);
  // cycle: D1 refs E1, E1 refs D1
  const cyc = cellsOf([[null, null, null, '=E1', '=D1']]);
  assert.equal(evalIn('=D1', cyc), '#CYCLE!');
});

test('recalculateSheet updates dependents when an input changes', () => {
  const sheet = {
    name: 'S',
    rowCount: 10,
    colCount: 5,
    cells: {
      '0:0': cell(2),
      '0:1': fcell('=A1*10'),
      '0:2': fcell('=B1+1')
    }
  };
  let out = recalculateSheet(sheet);
  assert.equal(out.cells['0:1'].value, 20);
  assert.equal(out.cells['0:2'].value, 21);
  out = recalculateSheet({
    ...out,
    cells: { ...out.cells, '0:0': cell(5) }
  });
  assert.equal(out.cells['0:1'].value, 50);
  assert.equal(out.cells['0:2'].value, 51);
  assert.equal(out.cells['0:2'].displayValue, '51');
});

test('formatCellValue strips float noise and renders errors verbatim', () => {
  assert.equal(formatCellValue(0.1 + 0.2), '0.3');
  assert.equal(formatCellValue(1 / 3), '0.3333333333');
  assert.equal(formatCellValue('#DIV/0!'), '#DIV/0!');
  assert.equal(formatCellValue(true), 'TRUE');
  assert.equal(formatCellValue(''), '');
});
