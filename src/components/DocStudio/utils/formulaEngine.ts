// Spreadsheet formula engine: tokenizer + recursive-descent parser + evaluator
// with Excel-compatible semantics for the supported function set.

import type { CellValue, SheetData, SheetWorkbookData } from "../types";

export type Scalar = number | string | boolean;
export type EngineValue = Scalar | Range | null;
type Range = Scalar[][];

export const FORMULA_ERRORS = [
  "#DIV/0!",
  "#VALUE!",
  "#NAME?",
  "#REF!",
  "#CYCLE!",
  "#ERROR!",
  "#NUM!",
  "#N/A"
] as const;
export type FormulaError = (typeof FORMULA_ERRORS)[number];

const ERROR_SET = new Set<string>(FORMULA_ERRORS);

export function isFormulaError(v: unknown): v is FormulaError {
  return typeof v === "string" && ERROR_SET.has(v);
}

function colIndexToLetter(col: number): string {
  let letter = "";
  let c = col;
  while (c >= 0) {
    letter = String.fromCharCode((c % 26) + 65) + letter;
    c = Math.floor(c / 26) - 1;
  }
  return letter;
}

function letterToColIndex(letter: string): number {
  let col = 0;
  for (let i = 0; i < letter.length; i++) {
    col = col * 26 + (letter.charCodeAt(i) - 64);
  }
  return col - 1;
}

function a1ToRowCol(a1: string): { row: number; col: number } | null {
  const match = a1.trim().toUpperCase().match(/^\$?([A-Z]+)\$?(\d+)$/);
  if (!match) return null;
  const col = letterToColIndex(match[1]);
  const row = parseInt(match[2], 10) - 1;
  if (row < 0 || col < 0) return null;
  return { row, col };
}

function refKey(row: number, col: number): string {
  return `${row}:${col}`;
}

// ---------- formatting ----------

export function formatCellValue(v: EngineValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "#NUM!";
    return String(Number(v.toPrecision(10)));
  }
  if (Array.isArray(v)) return "#VALUE!";
  return v;
}

// ---------- tokenizer ----------

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; v: string }
  | { t: "ref"; v: string }
  | { t: "err"; v: FormulaError }
  | { t: "op"; v: string };

function tokenize(src: string): Token[] | FormulaError {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === '"') {
      let s = "";
      i++;
      while (i < src.length) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i];
        i++;
      }
      out.push({ t: "str", v: s });
      continue;
    }
    if (/\d/.test(ch) || (ch === "." && /\d/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[\d.]/.test(src[j])) j++;
      if (/[eE]/.test(src[j] ?? "") && /[+\-\d]/.test(src[j + 1] ?? "")) {
        j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (j < src.length && /\d/.test(src[j])) j++;
      }
      const num = Number(src.slice(i, j));
      if (isNaN(num)) return "#ERROR!";
      out.push({ t: "num", v: num });
      i = j;
      continue;
    }
    if (ch === "#") {
      const m = src.slice(i).match(/^#[A-Z0-9/]+[!?]?/i);
      if (m) {
        const name = m[0].toUpperCase();
        out.push({ t: "err", v: (ERROR_SET.has(name) ? name : "#ERROR!") as FormulaError });
        i += m[0].length;
        continue;
      }
      return "#ERROR!";
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$.]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const up = word.toUpperCase();
      if (a1ToRowCol(up)) {
        out.push({ t: "ref", v: up.replace(/\$/g, "") });
      } else {
        out.push({ t: "ident", v: up });
      }
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/^&%=<>():,".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
      continue;
    }
    return "#ERROR!";
  }
  return out;
}

// ---------- AST ----------

type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "err"; v: FormulaError }
  | { k: "ref"; row: number; col: number }
  | { k: "range"; r1: number; c1: number; r2: number; c2: number }
  | { k: "call"; name: string; args: Node[] }
  | { k: "unary"; op: string; arg: Node }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "pct"; arg: Node };

function parse(tokens: Token[]): Node | FormulaError {
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => {
    const tk = tokens[pos];
    return tk?.t === "op" && tk.v === v;
  };
  const eat = (v?: string) => {
    const tk = tokens[pos];
    if (!tk) return null;
    if (v !== undefined && !(tk.t === "op" && tk.v === v)) return null;
    pos++;
    return tk;
  };

  const parseExpr = (): Node | FormulaError => parseComparison();

  const parseComparison = (): Node | FormulaError => {
    let l = parseConcat();
    if (typeof l === "string") return l;
    while (isOp("=") || isOp("<>") || isOp("<=") || isOp(">=") || isOp("<") || isOp(">")) {
      const op = (eat() as { v: string }).v;
      const r = parseConcat();
      if (typeof r === "string") return r;
      l = { k: "bin", op, l, r };
    }
    return l;
  };

  const parseConcat = (): Node | FormulaError => {
    let l = parseAdd();
    if (typeof l === "string") return l;
    while (isOp("&")) {
      eat("&");
      const r = parseAdd();
      if (typeof r === "string") return r;
      l = { k: "bin", op: "&", l, r };
    }
    return l;
  };

  const parseAdd = (): Node | FormulaError => {
    let l = parseMul();
    if (typeof l === "string") return l;
    while (isOp("+") || isOp("-")) {
      const op = (eat() as { v: string }).v;
      const r = parseMul();
      if (typeof r === "string") return r;
      l = { k: "bin", op, l, r };
    }
    return l;
  };

  const parseMul = (): Node | FormulaError => {
    let l = parsePower();
    if (typeof l === "string") return l;
    while (isOp("*") || isOp("/")) {
      const op = (eat() as { v: string }).v;
      const r = parsePower();
      if (typeof r === "string") return r;
      l = { k: "bin", op, l, r };
    }
    return l;
  };

  // Unary binds tighter than ^ (Excel: -2^2 = 4).
  const parsePower = (): Node | FormulaError => {
    let l = parseUnary();
    if (typeof l === "string") return l;
    while (isOp("^")) {
      eat("^");
      const r = parseUnary();
      if (typeof r === "string") return r;
      l = { k: "bin", op: "^", l, r };
    }
    return l;
  };

  const parseUnary = (): Node | FormulaError => {
    if (isOp("-")) {
      eat("-");
      const arg = parseUnary();
      if (typeof arg === "string") return arg;
      return { k: "unary", op: "-", arg };
    }
    if (isOp("+")) {
      eat("+");
      return parseUnary();
    }
    return parsePostfix();
  };

  const parsePostfix = (): Node | FormulaError => {
    let n = parsePrimary();
    if (typeof n === "string") return n;
    while (isOp("%")) {
      eat("%");
      n = { k: "pct", arg: n };
    }
    return n;
  };

  const parsePrimary = (): Node | FormulaError => {
    const tk = peek();
    if (!tk) return "#ERROR!";
    if (tk.t === "num") {
      pos++;
      return { k: "num", v: tk.v };
    }
    if (tk.t === "str") {
      pos++;
      return { k: "str", v: tk.v };
    }
    if (tk.t === "err") {
      pos++;
      return { k: "err", v: tk.v };
    }
    if (tk.t === "ref") {
      pos++;
      const rc = a1ToRowCol(tk.v)!;
      if (isOp(":")) {
        eat(":");
        const tk2 = peek();
        if (tk2?.t !== "ref") return "#REF!";
        pos++;
        const rc2 = a1ToRowCol(tk2.v)!;
        return {
          k: "range",
          r1: Math.min(rc.row, rc2.row),
          c1: Math.min(rc.col, rc2.col),
          r2: Math.max(rc.row, rc2.row),
          c2: Math.max(rc.col, rc2.col)
        };
      }
      return { k: "ref", row: rc.row, col: rc.col };
    }
    if (tk.t === "ident") {
      pos++;
      if (tk.v === "TRUE") return { k: "bool", v: true };
      if (tk.v === "FALSE") return { k: "bool", v: false };
      if (isOp("(")) {
        eat("(");
        const args: Node[] = [];
        if (!isOp(")")) {
          for (;;) {
            const a = parseExpr();
            if (typeof a === "string") return a;
            args.push(a);
            if (isOp(",")) {
              eat(",");
              continue;
            }
            break;
          }
        }
        if (!eat(")")) return "#ERROR!";
        return { k: "call", name: tk.v, args };
      }
      return "#NAME?";
    }
    if (isOp("(")) {
      eat("(");
      const e = parseExpr();
      if (typeof e === "string") return e;
      if (!eat(")")) return "#ERROR!";
      return e;
    }
    return "#ERROR!";
  };

  const result = parseExpr();
  if (typeof result === "string") return result;
  if (pos < tokens.length) return "#ERROR!";
  return result;
}

// ---------- evaluation ----------

type Resolver = (row: number, col: number) => Scalar | null;

function toNumber(v: EngineValue): number | FormulaError {
  if (v === null || v === undefined) return 0;
  if (isFormulaError(v)) return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (Array.isArray(v)) return "#VALUE!";
  const t = v.trim();
  if (t === "") return 0;
  const n = Number(t);
  return isNaN(n) ? "#VALUE!" : n;
}

function toBoolean(v: EngineValue): boolean | FormulaError {
  if (v === null || v === undefined) return false;
  if (isFormulaError(v)) return v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (Array.isArray(v)) return "#VALUE!";
  const t = v.trim().toUpperCase();
  if (t === "TRUE") return true;
  if (t === "FALSE") return false;
  if (t === "") return false;
  return "#VALUE!";
}

function toText(v: EngineValue): string | FormulaError {
  if (v === null || v === undefined) return "";
  if (isFormulaError(v)) return v;
  if (Array.isArray(v)) return "#VALUE!";
  return formatCellValue(v);
}

function flatten(args: EngineValue[]): EngineValue[] {
  const out: EngineValue[] = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const row of a) for (const v of row) out.push(v);
    } else {
      out.push(a);
    }
  }
  return out;
}

function numericList(args: EngineValue[]): number[] | FormulaError {
  const vals: number[] = [];
  for (const v of flatten(args)) {
    if (isFormulaError(v)) return v;
    if (v === null || v === undefined) continue;
    if (typeof v === "number") vals.push(v);
    else if (typeof v === "boolean") continue;
    else {
      const t = String(v).trim();
      if (t === "") continue;
      const n = Number(t);
      if (!isNaN(n)) vals.push(n);
    }
  }
  return vals;
}

function roundTo(v: number, digits: number, mode: "nearest" | "up" | "down"): number {
  const f = Math.pow(10, digits);
  const x = v * f;
  const r = mode === "nearest" ? Math.round(x) : mode === "up" ? Math.ceil(Math.abs(x)) * Math.sign(x) : Math.floor(Math.abs(x)) * Math.sign(x);
  return r / f;
}

function matchCriteria(v: EngineValue, criteria: EngineValue): boolean {
  if (isFormulaError(v) || isFormulaError(criteria)) return false;
  const crit = criteria === null || criteria === undefined ? "" : criteria;
  if (typeof crit === "number") {
    const n = toNumber(v);
    return typeof n === "number" && n === crit;
  }
  const s = String(crit);
  const m = s.match(/^(<=|>=|<>|=|<|>)(.*)$/);
  const cmp = (a: number | string, b: number | string): number | null => {
    if (typeof a === "number" || typeof b === "number") {
      const na = toNumber(a as EngineValue);
      const nb = toNumber(b as EngineValue);
      if (typeof na !== "number" || typeof nb !== "number") return null;
      return na - nb;
    }
    return String(a).toUpperCase().localeCompare(String(b).toUpperCase());
  };
  if (m) {
    const rhs = m[2];
    const num = Number(rhs);
    const operand: number | string = rhs !== "" && !isNaN(num) ? num : rhs;
    const d = cmp(v === null ? "" : (v as number | string), operand);
    if (d === null) return false;
    switch (m[1]) {
      case ">": return d > 0;
      case "<": return d < 0;
      case ">=": return d >= 0;
      case "<=": return d <= 0;
      case "<>": return d !== 0;
      default: return d === 0;
    }
  }
  const num = Number(s);
  if (s.trim() !== "" && !isNaN(num)) {
    const n = toNumber(v);
    return typeof n === "number" && n === num;
  }
  return String(v ?? "").toUpperCase() === s.toUpperCase();
}

function evalCall(name: string, args: EngineValue[]): EngineValue {
  const firstErr = (vals: EngineValue[]) => vals.find((v) => isFormulaError(v)) as FormulaError | undefined;
  const argErr = firstErr(args);
  if (name === "IFERROR") {
    const v = args[0] ?? null;
    return isFormulaError(v) ? args[1] ?? "" : v;
  }
  if (argErr) return argErr;

  switch (name) {
    case "SUM": {
      const vals = numericList(args);
      return typeof vals === "string" ? vals : vals.reduce((a, b) => a + b, 0);
    }
    case "AVERAGE": {
      const vals = numericList(args);
      if (typeof vals === "string") return vals;
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : "#DIV/0!";
    }
    case "COUNT": {
      const vals = numericList(args);
      return typeof vals === "string" ? vals : vals.length;
    }
    case "COUNTA": {
      return flatten(args).filter((v) => v !== null && v !== undefined && v !== "").length;
    }
    case "MAX": {
      const vals = numericList(args);
      return typeof vals === "string" ? vals : vals.length ? Math.max(...vals) : 0;
    }
    case "MIN": {
      const vals = numericList(args);
      return typeof vals === "string" ? vals : vals.length ? Math.min(...vals) : 0;
    }
    case "ROUND":
    case "ROUNDUP":
    case "ROUNDDOWN": {
      const n = toNumber(args[0] ?? null);
      const d = toNumber(args[1] ?? 0);
      if (typeof n === "string") return n;
      if (typeof d === "string") return d;
      return roundTo(n, Math.trunc(d), name === "ROUND" ? "nearest" : name === "ROUNDUP" ? "up" : "down");
    }
    case "INT": {
      const n = toNumber(args[0] ?? null);
      return typeof n === "string" ? n : Math.floor(n);
    }
    case "ABS": {
      const n = toNumber(args[0] ?? null);
      return typeof n === "string" ? n : Math.abs(n);
    }
    case "MOD": {
      const a = toNumber(args[0] ?? null);
      const b = toNumber(args[1] ?? null);
      if (typeof a === "string") return a;
      if (typeof b === "string") return b;
      if (b === 0) return "#DIV/0!";
      return ((a % b) + b) % b;
    }
    case "POWER": {
      const a = toNumber(args[0] ?? null);
      const b = toNumber(args[1] ?? null);
      if (typeof a === "string") return a;
      if (typeof b === "string") return b;
      const r = Math.pow(a, b);
      return Number.isFinite(r) ? r : "#NUM!";
    }
    case "SQRT": {
      const n = toNumber(args[0] ?? null);
      if (typeof n === "string") return n;
      return n < 0 ? "#NUM!" : Math.sqrt(n);
    }
    case "IF": {
      const cond = toBoolean(args[0] ?? null);
      if (typeof cond === "string") return cond;
      if (cond) return args[1] ?? true;
      return args.length > 2 ? args[2] ?? false : false;
    }
    case "AND":
    case "OR": {
      const vals = flatten(args);
      let saw = false;
      for (const v of vals) {
        if (isFormulaError(v)) return v;
        if (typeof v === "boolean") {
          saw = true;
          if (name === "AND" && !v) return false;
          if (name === "OR" && v) return true;
        } else if (typeof v === "number") {
          saw = true;
          if (name === "AND" && v === 0) return false;
          if (name === "OR" && v !== 0) return true;
        } else if (typeof v === "string") {
          const b = toBoolean(v);
          if (b === "#VALUE!") continue;
          if (typeof b === "string") return b;
          saw = true;
          if (name === "AND" && !b) return false;
          if (name === "OR" && b) return true;
        }
      }
      return saw ? name === "AND" : "#VALUE!";
    }
    case "NOT": {
      const b = toBoolean(args[0] ?? null);
      return typeof b === "string" ? b : !b;
    }
    case "CONCAT":
    case "CONCATENATE": {
      let s = "";
      for (const v of flatten(args)) {
        if (isFormulaError(v)) return v;
        s += toText(v);
      }
      return s;
    }
    case "LEN": {
      const s = toText(args[0] ?? null);
      return typeof s === "string" && isFormulaError(s) ? s : s.length;
    }
    case "LEFT":
    case "RIGHT": {
      const s = toText(args[0] ?? null);
      if (isFormulaError(s)) return s;
      const n = args[1] === undefined ? 1 : toNumber(args[1]);
      if (typeof n === "string") return n;
      return name === "LEFT" ? s.slice(0, n) : s.slice(Math.max(0, s.length - n));
    }
    case "MID": {
      const s = toText(args[0] ?? null);
      if (isFormulaError(s)) return s;
      const start = toNumber(args[1] ?? 1);
      const len = toNumber(args[2] ?? 0);
      if (typeof start === "string") return start;
      if (typeof len === "string") return len;
      return s.slice(Math.max(0, Math.trunc(start) - 1), Math.max(0, Math.trunc(start) - 1) + Math.trunc(len));
    }
    case "UPPER": {
      const s = toText(args[0] ?? null);
      return isFormulaError(s) ? s : s.toUpperCase();
    }
    case "LOWER": {
      const s = toText(args[0] ?? null);
      return isFormulaError(s) ? s : s.toLowerCase();
    }
    case "TRIM": {
      const s = toText(args[0] ?? null);
      return isFormulaError(s) ? s : s.trim().replace(/ +/g, " ");
    }
    case "SUMIF":
    case "COUNTIF":
    case "AVERAGEIF": {
      const range = args[0];
      if (!Array.isArray(range)) return "#VALUE!";
      const criteria = args[1] ?? null;
      const values = flatten([range]);
      if (name === "COUNTIF") {
        return values.filter((v) => matchCriteria(v, criteria)).length;
      }
      let sumVals = values;
      if (name === "SUMIF" && args[2] !== undefined) {
        const sr = args[2];
        if (!Array.isArray(sr)) return "#VALUE!";
        sumVals = flatten([sr]);
      }
      if (name === "AVERAGEIF" && args[2] !== undefined) {
        const sr = args[2];
        if (!Array.isArray(sr)) return "#VALUE!";
        sumVals = flatten([sr]);
      }
      let total = 0;
      let count = 0;
      values.forEach((v, idx) => {
        if (!matchCriteria(v, criteria)) return;
        const target = sumVals[idx] ?? sumVals[0];
        if (isFormulaError(target)) return;
        const n = toNumber(target);
        if (typeof n === "number") {
          total += n;
          count++;
        }
      });
      if (name === "AVERAGEIF") return count ? total / count : "#DIV/0!";
      return total;
    }
    default:
      return "#NAME?";
  }
}

function evalNode(node: Node, resolve: Resolver): EngineValue {
  switch (node.k) {
    case "num":
      return node.v;
    case "str":
      return node.v;
    case "bool":
      return node.v;
    case "err":
      return node.v;
    case "ref":
      return resolve(node.row, node.col);
    case "range": {
      const rows: Scalar[][] = [];
      for (let r = node.r1; r <= node.r2; r++) {
        const row: Scalar[] = [];
        for (let c = node.c1; c <= node.c2; c++) {
          const v = resolve(r, c);
          row.push(v === null ? "" : v);
        }
        rows.push(row);
      }
      return rows;
    }
    case "unary": {
      const v = toNumber(evalNode(node.arg, resolve));
      return typeof v === "string" ? v : -v;
    }
    case "pct": {
      const v = toNumber(evalNode(node.arg, resolve));
      return typeof v === "string" ? v : v / 100;
    }
    case "bin": {
      const l = evalNode(node.l, resolve);
      if (isFormulaError(l)) return l;
      const r = evalNode(node.r, resolve);
      if (isFormulaError(r)) return r;
      if (node.op === "&") {
        const ls = toText(l);
        const rs = toText(r);
        if (isFormulaError(ls)) return ls;
        if (isFormulaError(rs)) return rs;
        return ls + rs;
      }
      if (["=", "<>", "<", "<=", ">", ">="].includes(node.op)) {
        // numeric compare when both coerce, else text compare
        const ln = toNumber(l);
        const rn = toNumber(r);
        let d: number;
        if (typeof ln === "number" && typeof rn === "number" && !(l !== null && r === null)) {
          d = ln - rn;
        } else {
          const ls = (l === null ? "" : String(l)).toUpperCase();
          const rs = (r === null ? "" : String(r)).toUpperCase();
          d = ls < rs ? -1 : ls > rs ? 1 : 0;
        }
        switch (node.op) {
          case "=": return d === 0;
          case "<>": return d !== 0;
          case "<": return d < 0;
          case "<=": return d <= 0;
          case ">": return d > 0;
          default: return d >= 0;
        }
      }
      const ln = toNumber(l);
      if (typeof ln === "string") return ln;
      const rn = toNumber(r);
      if (typeof rn === "string") return rn;
      switch (node.op) {
        case "+": return ln + rn;
        case "-": return ln - rn;
        case "*": return ln * rn;
        case "/": return rn === 0 ? "#DIV/0!" : ln / rn;
        case "^": {
          const p = Math.pow(ln, rn);
          return Number.isFinite(p) ? p : "#NUM!";
        }
        default: return "#ERROR!";
      }
    }
    case "call":
      return evalCall(node.name, node.args.map((a) => evalNode(a, resolve)));
    default:
      return "#ERROR!";
  }
}

// ---------- public API ----------

interface EngineState {
  cells: Record<string, CellValue>;
  memo: Map<string, Scalar | FormulaError | null>;
  visiting: Set<string>;
}

function makeResolver(state: EngineState): Resolver {
  return (row, col) => {
    const key = refKey(row, col);
    if (state.memo.has(key)) return state.memo.get(key) ?? null;
    const cell = state.cells[key];
    if (!cell) {
      state.memo.set(key, null);
      return null;
    }
    if (cell.formula) {
      if (state.visiting.has(key)) {
        state.memo.set(key, "#CYCLE!");
        return "#CYCLE!";
      }
      state.visiting.add(key);
      const v = evaluateWithState(cell.formula, state);
      state.visiting.delete(key);
      const out = isFormulaError(v) ? v : (v as Scalar | null);
      state.memo.set(key, out);
      return out;
    }
    const v = cell.value as Scalar | null;
    state.memo.set(key, v ?? null);
    return v ?? null;
  };
}

function evaluateWithState(formula: string, state: EngineState): EngineValue {
  const src = formula.startsWith("=") ? formula.slice(1) : formula;
  const tokens = tokenize(src);
  if (typeof tokens === "string") return tokens;
  const ast = parse(tokens);
  if (typeof ast === "string") return ast;
  const resolve = makeResolver(state);
  return evalNode(ast, resolve);
}

/**
 * Evaluate a formula against a cells map. Returns the computed value; errors
 * are returned as FormulaError strings — the source text is never returned.
 */
export function evaluateFormula(
  formula: string,
  cells: Record<string, CellValue>
): Scalar {
  const state: EngineState = { cells, memo: new Map(), visiting: new Set() };
  const v = evaluateWithState(formula, state);
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return "#VALUE!";
  return v;
}

/** Recompute value/displayValue of every formula cell in a sheet. */
export function recalculateSheet(sheet: SheetData): SheetData {
  const formulaKeys = Object.keys(sheet.cells).filter((k) => sheet.cells[k]?.formula);
  if (formulaKeys.length === 0) return sheet;
  const state: EngineState = { cells: sheet.cells, memo: new Map(), visiting: new Set() };
  const cells = { ...sheet.cells };
  for (const key of formulaKeys) {
    const v = evaluateWithState(sheet.cells[key]!.formula!, state);
    const scalar = v === null || v === undefined ? "" : Array.isArray(v) ? "#VALUE!" : v;
    cells[key] = {
      ...sheet.cells[key],
      value: scalar,
      displayValue: formatCellValue(scalar)
    };
    state.memo.set(key, scalar);
  }
  return { ...sheet, cells };
}

/** Recalculate every sheet in a workbook (no-op when there are no formulas). */
export function recalculateWorkbook(wb: SheetWorkbookData): SheetWorkbookData {
  let changed = false;
  const sheets = wb.sheets.map((sheet) => {
    const next = recalculateSheet(sheet);
    if (next !== sheet) changed = true;
    return next;
  });
  return changed ? { ...wb, sheets } : wb;
}
