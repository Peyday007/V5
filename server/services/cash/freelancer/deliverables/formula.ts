/**
 * A spreadsheet formula engine for the formulas Brain delivers.
 *
 * Brain writes every formula's computed value into the file, so a client who
 * opens it in a viewer that does not recalculate still sees numbers, and so
 * Brain itself can check the workbook before delivery: a formula that names a
 * function Brain does not implement, refers to itself, or evaluates to an error
 * (`#DIV/0!`, `#REF!`, `#VALUE!`) refuses the deliverable.
 *
 * The grammar is Excel's for the subset below. Anything outside it is an
 * error rather than a guess, so a formula Brain cannot evaluate is never
 * delivered with a value Brain made up.
 */

export type FValue = number | string | boolean | null | { error: string };
type Matrix = FValue[][];

export function isError(value: unknown): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value;
}

const err = (code: string): { error: string } => ({ error: code });

export interface CellAddress {
  sheet: string;
  row: number; // 0-based
  col: number; // 0-based
}

export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'ref'; sheet: string | null; c1: number; r1: number; c2: number; r2: number }
  | { t: 'fn'; v: string }
  | { t: 'op'; v: string }
  | { t: '(' }
  | { t: ')' }
  | { t: ',' };

const REF = /^(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_ .]*?))!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?/;

export class FormulaError extends Error {}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') {
          s += '"';
          j += 2;
        } else if (src[j] === '"') break;
        else s += src[j++];
      }
      if (j >= src.length) throw new FormulaError('An unterminated string.');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num && !/^[A-Za-z]/.test(src.slice(i))) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const rest = src.slice(i);
    const ref = REF.exec(rest);
    if (ref && !/^[A-Za-z0-9_(]/.test(rest.slice(ref[0].length))) {
      const sheet = ref[1] !== undefined ? ref[1].replace(/''/g, "'") : (ref[2] ?? null);
      const c1 = colIndex(ref[3]!);
      const r1 = Number(ref[4]) - 1;
      const c2 = ref[5] ? colIndex(ref[5]) : c1;
      const r2 = ref[6] ? Number(ref[6]) - 1 : r1;
      out.push({ t: 'ref', sheet, c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) });
      i += ref[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
    if (word) {
      const name = word[0].toUpperCase();
      i += word[0].length;
      if (name === 'TRUE' || name === 'FALSE') out.push({ t: 'bool', v: name === 'TRUE' });
      else if (src[i] === '(') out.push({ t: 'fn', v: name });
      else throw new FormulaError(`An unknown name: ${word[0]}.`);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/^&=<>%'.includes(ch)) out.push({ t: 'op', v: ch });
    else if (ch === '(') out.push({ t: '(' });
    else if (ch === ')') out.push({ t: ')' });
    else if (ch === ',' || ch === ';') out.push({ t: ',' });
    else throw new FormulaError(`An unexpected character: ${ch}.`);
    i += 1;
  }
  return out;
}

type Node =
  | { k: 'lit'; v: FValue }
  | { k: 'ref'; sheet: string | null; c1: number; r1: number; c2: number; r2: number }
  | { k: 'un'; op: string; a: Node }
  | { k: 'pct'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'fn'; name: string; args: Node[] };

const PREC: Record<string, number> = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };

function parse(tokens: Token[]): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  function primary(): Node {
    const tok = tokens[pos++];
    if (!tok) throw new FormulaError('The formula ends too early.');
    switch (tok.t) {
      case 'num':
        return { k: 'lit', v: tok.v };
      case 'str':
        return { k: 'lit', v: tok.v };
      case 'bool':
        return { k: 'lit', v: tok.v };
      case 'ref':
        return { k: 'ref', sheet: tok.sheet, c1: tok.c1, r1: tok.r1, c2: tok.c2, r2: tok.r2 };
      case 'op':
        if (tok.v === '-' || tok.v === '+') return { k: 'un', op: tok.v, a: unaryOperand() };
        throw new FormulaError(`An operator ${tok.v} with nothing before it.`);
      case '(': {
        const inner = expr(0);
        if (tokens[pos++]?.t !== ')') throw new FormulaError('A bracket is not closed.');
        return inner;
      }
      case 'fn': {
        pos += 1; // (
        const args: Node[] = [];
        if (peek()?.t !== ')') {
          for (;;) {
            args.push(expr(0));
            if (peek()?.t === ',') {
              pos += 1;
              continue;
            }
            break;
          }
        }
        if (tokens[pos++]?.t !== ')') throw new FormulaError(`${tok.v}( is not closed.`);
        return { k: 'fn', name: tok.v, args };
      }
      default:
        throw new FormulaError('An unexpected separator.');
    }
  }
  function unaryOperand(): Node {
    let node = primary();
    while (peek()?.t === 'op' && (peek() as { v: string }).v === '%') {
      pos += 1;
      node = { k: 'pct', a: node };
    }
    if (peek()?.t === 'op' && (peek() as { v: string }).v === '^') {
      pos += 1;
      node = { k: 'bin', op: '^', a: node, b: unaryOperand() };
    }
    return node;
  }
  function expr(min: number): Node {
    let left = unaryOperand();
    for (;;) {
      const tok = peek();
      if (!tok || tok.t !== 'op' || tok.v === '%') break;
      const prec = PREC[tok.v];
      if (prec === undefined || prec <= min) break;
      pos += 1;
      const right = tok.v === '^' ? expr(prec - 1) : expr(prec);
      left = { k: 'bin', op: tok.v, a: left, b: right };
    }
    return left;
  }
  const node = expr(0);
  if (pos !== tokens.length) throw new FormulaError('The formula has something left over after it ends.');
  return node;
}

export interface Workbook {
  /** The raw value or formula of a cell, or undefined for an empty cell. */
  cell(sheet: string, row: number, col: number): { value?: FValue; formula?: string } | undefined;
  sheets: string[];
}

export const SUPPORTED_FUNCTIONS = [
  'SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'IF', 'IFERROR',
  'AND', 'OR', 'NOT', 'ABS', 'SUMPRODUCT', 'PMT', 'NPV', 'SUMIF', 'COUNTIF', 'AVERAGEIF', 'CONCAT',
  'CONCATENATE', 'MEDIAN', 'POWER', 'SQRT', 'INT', 'MOD', 'FV', 'PV',
] as const;

function num(v: FValue): number | { error: string } {
  if (isError(v)) return v;
  if (v === null || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : err('#VALUE!');
}

function text(v: FValue): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (isError(v)) return v.error;
  return String(v);
}

function truthy(v: FValue): boolean | { error: string } {
  if (isError(v)) return v;
  if (typeof v === 'string') {
    if (v.toUpperCase() === 'TRUE') return true;
    if (v.toUpperCase() === 'FALSE') return false;
    return err('#VALUE!');
  }
  return Boolean(v);
}

function criteria(test: FValue): (v: FValue) => boolean {
  const s = text(test);
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(s)!;
  const op = m[1] ?? '=';
  const rhs = m[2]!;
  const rn = Number(rhs);
  return (v) => {
    const isNum = rhs !== '' && Number.isFinite(rn) && typeof v === 'number';
    const a: number | string = isNum ? (v as number) : text(v).toLowerCase();
    const b: number | string = isNum ? rn : rhs.toLowerCase();
    switch (op) {
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      case '<>': return a !== b;
      default: return a === b;
    }
  };
}

export class Evaluator {
  private readonly cache = new Map<string, FValue>();
  private readonly active = new Set<string>();
  readonly unsupported = new Set<string>();

  constructor(private readonly book: Workbook) {}

  /** The computed value of one cell. */
  value(sheet: string, row: number, col: number): FValue {
    const key = `${sheet}\u0000${row}\u0000${col}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const cell = this.book.cell(sheet, row, col);
    if (!cell) return null;
    if (cell.formula === undefined) return cell.value ?? null;
    if (this.active.has(key)) return err('#CIRCULAR!');
    this.active.add(key);
    let result: FValue;
    try {
      result = this.scalar(this.evalNode(parse(tokenize(cell.formula.replace(/^=/, ''))), sheet));
    } catch (e) {
      result = err(e instanceof FormulaError ? '#NAME?' : '#ERROR!');
    }
    this.active.delete(key);
    if (typeof result === 'number' && !Number.isFinite(result)) result = err('#NUM!');
    this.cache.set(key, result);
    return result;
  }

  private sheetName(name: string | null, current: string): string | null {
    if (name === null) return current;
    return this.book.sheets.find((s) => s.toLowerCase() === name.toLowerCase()) ?? null;
  }

  private scalar(v: FValue | Matrix): FValue {
    if (Array.isArray(v)) return v.length === 1 && v[0]!.length === 1 ? v[0]![0]! : err('#VALUE!');
    return v;
  }

  private flat(args: (FValue | Matrix)[]): FValue[] {
    const out: FValue[] = [];
    for (const a of args) {
      if (Array.isArray(a)) for (const row of a) out.push(...row);
      else out.push(a);
    }
    return out;
  }

  private evalNode(node: Node, sheet: string): FValue | Matrix {
    switch (node.k) {
      case 'lit':
        return node.v;
      case 'ref': {
        const target = this.sheetName(node.sheet, sheet);
        if (target === null) return err('#REF!');
        if ((node.r2 - node.r1 + 1) * (node.c2 - node.c1 + 1) > 200_000) return err('#REF!');
        const rows: Matrix = [];
        for (let r = node.r1; r <= node.r2; r += 1) {
          const row: FValue[] = [];
          for (let c = node.c1; c <= node.c2; c += 1) row.push(this.value(target, r, c));
          rows.push(row);
        }
        return node.r1 === node.r2 && node.c1 === node.c2 ? rows[0]![0]! : rows;
      }
      case 'un': {
        const a = num(this.scalar(this.evalNode(node.a, sheet)));
        if (isError(a)) return a;
        return node.op === '-' ? -a : a;
      }
      case 'pct': {
        const a = num(this.scalar(this.evalNode(node.a, sheet)));
        return isError(a) ? a : a / 100;
      }
      case 'bin': {
        const av = this.scalar(this.evalNode(node.a, sheet));
        const bv = this.scalar(this.evalNode(node.b, sheet));
        if (isError(av)) return av;
        if (isError(bv)) return bv;
        if (node.op === '&') return text(av) + text(bv);
        if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) {
          const bothNum = typeof av !== 'string' && typeof bv !== 'string';
          const a = bothNum ? (num(av) as number) : text(av).toLowerCase();
          const b = bothNum ? (num(bv) as number) : text(bv).toLowerCase();
          switch (node.op) {
            case '=': return a === b;
            case '<>': return a !== b;
            case '<': return a < b;
            case '>': return a > b;
            case '<=': return a <= b;
            default: return a >= b;
          }
        }
        const a = num(av);
        const b = num(bv);
        if (isError(a)) return a;
        if (isError(b)) return b;
        switch (node.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b === 0 ? err('#DIV/0!') : a / b;
          default: return a ** b;
        }
      }
      case 'fn':
        return this.call(node.name, node.args, sheet);
    }
  }

  private call(name: string, argNodes: Node[], sheet: string): FValue | Matrix {
    // IF and IFERROR evaluate lazily, as Excel does.
    if (name === 'IF') {
      if (argNodes.length < 2 || argNodes.length > 3) return err('#VALUE!');
      const c = truthy(this.scalar(this.evalNode(argNodes[0]!, sheet)));
      if (isError(c)) return c;
      if (c) return this.evalNode(argNodes[1]!, sheet);
      return argNodes[2] ? this.evalNode(argNodes[2], sheet) : false;
    }
    if (name === 'IFERROR') {
      if (argNodes.length !== 2) return err('#VALUE!');
      const v = this.scalar(this.evalNode(argNodes[0]!, sheet));
      return isError(v) && v.error !== '#CIRCULAR!' ? this.evalNode(argNodes[1]!, sheet) : v;
    }
    const args = argNodes.map((a) => this.evalNode(a, sheet));
    const numbers = (list: FValue[]): number[] | { error: string } => {
      const out: number[] = [];
      for (const v of list) {
        if (isError(v)) return v;
        if (typeof v === 'number') out.push(v);
      }
      return out;
    };
    const scalarNum = (i: number): number | { error: string } => num(this.scalar(args[i] ?? null));
    switch (name) {
      case 'SUM': case 'AVERAGE': case 'MIN': case 'MAX': case 'COUNT': case 'MEDIAN': {
        const list = numbers(this.flat(args));
        if (isError(list)) return list;
        if (name === 'SUM') return list.reduce((s, x) => s + x, 0);
        if (name === 'COUNT') return list.length;
        if (list.length === 0) return name === 'AVERAGE' || name === 'MEDIAN' ? err('#DIV/0!') : 0;
        if (name === 'AVERAGE') return list.reduce((s, x) => s + x, 0) / list.length;
        if (name === 'MIN') return Math.min(...list);
        if (name === 'MAX') return Math.max(...list);
        const sorted = [...list].sort((x, y) => x - y);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      }
      case 'COUNTA':
        return this.flat(args).filter((v) => v !== null && v !== '').length;
      case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': {
        const x = scalarNum(0);
        const d = args.length > 1 ? scalarNum(1) : 0;
        if (isError(x)) return x;
        if (isError(d)) return d;
        const f = 10 ** Math.trunc(d);
        const scaled = x * f;
        const r = name === 'ROUND' ? Math.sign(scaled) * Math.round(Math.abs(scaled) + 1e-9) : name === 'ROUNDUP' ? Math.sign(scaled) * Math.ceil(Math.abs(scaled) - 1e-9) : Math.trunc(scaled);
        return r / f;
      }
      case 'AND': case 'OR': {
        const list = this.flat(args).filter((v) => v !== null);
        const bools: boolean[] = [];
        for (const v of list) {
          const t = truthy(v);
          if (isError(t)) return t;
          bools.push(t);
        }
        return name === 'AND' ? bools.every(Boolean) : bools.some(Boolean);
      }
      case 'NOT': {
        const t = truthy(this.scalar(args[0] ?? null));
        return isError(t) ? t : !t;
      }
      case 'ABS': case 'SQRT': case 'INT': {
        const x = scalarNum(0);
        if (isError(x)) return x;
        if (name === 'ABS') return Math.abs(x);
        if (name === 'INT') return Math.floor(x);
        return x < 0 ? err('#NUM!') : Math.sqrt(x);
      }
      case 'POWER': case 'MOD': {
        const a = scalarNum(0);
        const b = scalarNum(1);
        if (isError(a)) return a;
        if (isError(b)) return b;
        if (name === 'POWER') return a ** b;
        return b === 0 ? err('#DIV/0!') : a - b * Math.floor(a / b);
      }
      case 'SUMPRODUCT': {
        const mats = args.map((a) => (Array.isArray(a) ? this.flat([a]) : [a]));
        const n = mats[0]?.length ?? 0;
        if (mats.some((m) => m.length !== n)) return err('#VALUE!');
        let total = 0;
        for (let i = 0; i < n; i += 1) {
          let p = 1;
          for (const m of mats) {
            const v = m[i]!;
            if (isError(v)) return v;
            p *= typeof v === 'number' ? v : 0;
          }
          total += p;
        }
        return total;
      }
      case 'SUMIF': case 'COUNTIF': case 'AVERAGEIF': {
        const range = this.flat([args[0] ?? null]);
        const test = criteria(this.scalar(args[1] ?? null));
        const sumRange = args[2] !== undefined ? this.flat([args[2]]) : range;
        let total = 0;
        let count = 0;
        range.forEach((v, i) => {
          if (!test(v)) return;
          count += 1;
          const s = sumRange[i];
          if (typeof s === 'number') total += s;
        });
        if (name === 'COUNTIF') return count;
        if (name === 'SUMIF') return total;
        return count === 0 ? err('#DIV/0!') : total / count;
      }
      case 'CONCAT': case 'CONCATENATE':
        return this.flat(args).map(text).join('');
      case 'PMT': case 'FV': case 'PV': {
        const rate = scalarNum(0);
        const nper = scalarNum(1);
        const third = scalarNum(2);
        const fourth = args.length > 3 ? scalarNum(3) : 0;
        const type = args.length > 4 ? scalarNum(4) : 0;
        for (const v of [rate, nper, third, fourth, type]) if (isError(v)) return v;
        const r = rate as number;
        const n = nper as number;
        const t = type as number;
        if (name === 'PMT') {
          const pv = third as number;
          const fv = fourth as number;
          if (r === 0) return -(pv + fv) / n;
          const f = (1 + r) ** n;
          return (-(pv * f + fv) * r) / ((1 + r * t) * (f - 1));
        }
        if (name === 'FV') {
          const pmt = third as number;
          const pv = fourth as number;
          if (r === 0) return -(pv + pmt * n);
          const f = (1 + r) ** n;
          return -(pv * f + pmt * (1 + r * t) * ((f - 1) / r));
        }
        const pmt = third as number;
        const fv = fourth as number;
        if (r === 0) return -(fv + pmt * n);
        const f = (1 + r) ** n;
        return -(fv + pmt * (1 + r * t) * ((f - 1) / r)) / f;
      }
      case 'NPV': {
        const rate = scalarNum(0);
        if (isError(rate)) return rate;
        const flows = numbers(this.flat(args.slice(1)));
        if (isError(flows)) return flows;
        return flows.reduce((s, x, i) => s + x / (1 + rate) ** (i + 1), 0);
      }
      default:
        this.unsupported.add(name);
        return err('#NAME?');
    }
  }
}

/** Parse only, to say whether a formula is in the supported grammar. */
export function formulaProblem(formula: string): string | null {
  try {
    const node = parse(tokenize(formula.replace(/^=/, '')));
    const names: string[] = [];
    const walk = (n: Node): void => {
      if (n.k === 'fn') {
        names.push(n.name);
        n.args.forEach(walk);
      } else if (n.k === 'un' || n.k === 'pct') walk(n.a);
      else if (n.k === 'bin') {
        walk(n.a);
        walk(n.b);
      }
    };
    walk(node);
    const unknown = names.filter((n) => !(SUPPORTED_FUNCTIONS as readonly string[]).includes(n));
    return unknown.length ? `uses function(s) Brain does not evaluate: ${[...new Set(unknown)].join(', ')}` : null;
  } catch (e) {
    return e instanceof Error ? e.message : 'could not be read';
  }
}
