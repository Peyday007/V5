/**
 * Data operations on a client's own files, too large to pass through a spec.
 *
 * A worker cannot paste fifty thousand rows into a 64 KB submission, and must
 * not send Brain code to run. So for data work it declares *steps* from a
 * closed vocabulary — rename, trim, normalise numbers and dates, de-duplicate,
 * filter, fill, derive, group and aggregate, sort, append — and Brain executes
 * them itself, deterministically, over the client file it downloaded and
 * stored. Every step records what it changed, so the client gets a change log
 * and a re-run of the same steps over the same file gives the same bytes.
 */
import { parseCsv } from './assets.ts';
import { readXlsx } from './xlsx.ts';
import { isError } from './formula.ts';

export type Value = string | number | boolean | null;
export interface Table {
  columns: string[];
  rows: Value[][];
}

export type Step =
  | { op: 'select'; columns: string[] }
  | { op: 'rename'; from: string; to: string }
  | { op: 'trim'; columns: string[] | '*' }
  | { op: 'case'; column: string; to: 'lower' | 'upper' | 'title' }
  | { op: 'replace'; column: string; find: string; with: string }
  | { op: 'toNumber'; columns: string[] }
  | { op: 'toDate'; column: string; order: 'YMD' | 'DMY' | 'MDY' }
  | { op: 'dropEmpty'; columns: string[] }
  | { op: 'dedupe'; columns: string[] | '*' }
  | { op: 'filter'; column: string; test: 'eq' | 'ne' | 'gt' | 'lt' | 'ge' | 'le' | 'contains' | 'empty' | 'notEmpty'; value?: string | number }
  | { op: 'fill'; column: string; value: string | number }
  | { op: 'derive'; column: string; a: string | number; operator: 'add' | 'subtract' | 'multiply' | 'divide' | 'concat'; b: string | number }
  | { op: 'group'; by: string[]; aggregates: { column: string; fn: 'sum' | 'avg' | 'count' | 'min' | 'max'; as: string }[] }
  | { op: 'sort'; column: string; order: 'asc' | 'desc' }
  | { op: 'append'; file: string; sheet?: string }
  | { op: 'datePart'; column: string; from: string; part: 'year' | 'month' | 'yearMonth' | 'quarter' };

export const STEP_OPS = ['select', 'rename', 'trim', 'case', 'replace', 'toNumber', 'toDate', 'dropEmpty', 'dedupe', 'filter', 'fill', 'derive', 'group', 'sort', 'append', 'datePart'] as const;

export interface DataSource {
  file: string;
  sheet?: string;
  /** Rows above the header to skip, for exports with a title block. */
  headerRow?: number;
}

export const MAX_SOURCE_ROWS = 200_000;
export const MAX_STEPS = 60;

export class PipelineError extends Error {}

/** Read a client file into a table: CSV/TSV/TXT or one sheet of a workbook. */
export function loadTable(name: string, bytes: Buffer, sheet?: string, headerRow = 0): Table {
  const lower = name.toLowerCase();
  let grid: Value[][];
  if (/\.(xlsx|xlsm)$/.test(lower)) {
    const sheets = readXlsx(bytes);
    const chosen = sheet ? sheets.find((s) => s.name.toLowerCase() === sheet.toLowerCase()) : sheets[0];
    if (!chosen) throw new PipelineError(`${name} has no sheet ${sheet}; it has ${sheets.map((s) => s.name).join(', ')}.`);
    grid = [];
    for (let r = 0; r <= chosen.maxRow; r += 1) {
      const row: Value[] = [];
      for (let c = 0; c <= chosen.maxCol; c += 1) {
        const v = chosen.cells.get(`${r},${c}`)?.value ?? null;
        row.push(isError(v) ? null : v);
      }
      grid.push(row);
    }
  } else if (/\.(csv|tsv|txt)$/.test(lower)) {
    const text = bytes.toString('utf8').replace(/^﻿/, '');
    const tab = lower.endsWith('.tsv') || (!text.split('\n', 1)[0]!.includes(',') && text.includes('\t'));
    grid = tab ? text.split(/\r?\n/).filter((l) => l.length).map((l) => l.split('\t')) : parseCsv(text).filter((r) => r.some((c) => c !== ''));
  } else {
    throw new PipelineError(`${name} is not a CSV or Excel file, so its rows cannot be processed.`);
  }
  if (grid.length <= headerRow) throw new PipelineError(`${name} has no header row at row ${headerRow + 1}.`);
  const header = grid[headerRow]!.map((v, i) => (v === null || String(v).trim() === '' ? `column_${i + 1}` : String(v).trim()));
  const seen = new Map<string, number>();
  const columns = header.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n > 1 ? `${h}_${n}` : h;
  });
  const rows = grid.slice(headerRow + 1).map((r) => columns.map((_, i) => (r[i] === undefined || r[i] === '' ? null : r[i]!)));
  if (rows.length > MAX_SOURCE_ROWS) throw new PipelineError(`${name} has ${rows.length} rows, more than ${MAX_SOURCE_ROWS}.`);
  return { columns, rows };
}

function col(table: Table, name: string): number {
  const i = table.columns.indexOf(name);
  if (i < 0) throw new PipelineError(`No column "${name}"; the columns are ${table.columns.join(', ')}.`);
  return i;
}

/** "$1,234.50", "(120)", "12%" → numbers; anything else unchanged. */
export function toNumber(v: Value): Value {
  if (typeof v === 'number' || v === null || typeof v === 'boolean') return v;
  const s = v.trim();
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  const pct = s.endsWith('%');
  const digits = s.replace(/[()$€£¥₹%\s,]/g, '').replace(/^[-+]/, '');
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(digits)) return v;
  const n = Number(digits) * (negative ? -1 : 1);
  return pct ? n / 100 : n;
}

export function toIsoDate(v: Value, order: 'YMD' | 'DMY' | 'MDY'): Value {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    // A spreadsheet serial date.
    if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10);
    return v;
  }
  const s = v.trim();
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  let y: number, m: number, d: number;
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else {
    const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
    if (!parts) {
      const named = Date.parse(s);
      return Number.isNaN(named) ? v : new Date(named - new Date(named).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    }
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    y = Number(parts[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;
    [d, m] = order === 'MDY' ? [b, a] : [a, b];
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return v;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return v;
  return date.toISOString().slice(0, 10);
}

function compare(a: Value, b: Value): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

export interface PipelineResult {
  table: Table;
  log: string[];
}

export function runPipeline(source: Table, steps: readonly Step[], files: (name: string, sheet?: string) => Table): PipelineResult {
  let t: Table = { columns: [...source.columns], rows: source.rows.map((r) => [...r]) };
  const log: string[] = [`Read ${t.rows.length} row(s) with ${t.columns.length} column(s).`];
  for (const [index, step] of steps.entries()) {
    const n = index + 1;
    const before = t.rows.length;
    switch (step.op) {
      case 'select': {
        const idx = step.columns.map((c) => col(t, c));
        t = { columns: step.columns, rows: t.rows.map((r) => idx.map((i) => r[i]!)) };
        log.push(`${n}. Kept ${step.columns.length} column(s): ${step.columns.join(', ')}.`);
        break;
      }
      case 'rename': {
        const i = col(t, step.from);
        if (t.columns.includes(step.to)) throw new PipelineError(`Step ${n}: a column "${step.to}" already exists.`);
        t.columns[i] = step.to;
        log.push(`${n}. Renamed "${step.from}" to "${step.to}".`);
        break;
      }
      case 'trim': {
        const idx = step.columns === '*' ? t.columns.map((_, i) => i) : step.columns.map((c) => col(t, c));
        let changed = 0;
        for (const r of t.rows) for (const i of idx) if (typeof r[i] === 'string') {
          const v = (r[i] as string).replace(/\s+/g, ' ').trim();
          if (v !== r[i]) changed += 1;
          r[i] = v === '' ? null : v;
        }
        log.push(`${n}. Trimmed whitespace in ${changed} cell(s).`);
        break;
      }
      case 'case': {
        const i = col(t, step.column);
        for (const r of t.rows) if (typeof r[i] === 'string') {
          const s = r[i] as string;
          r[i] = step.to === 'lower' ? s.toLowerCase() : step.to === 'upper' ? s.toUpperCase() : s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
        }
        log.push(`${n}. Set "${step.column}" to ${step.to} case.`);
        break;
      }
      case 'replace': {
        const i = col(t, step.column);
        let changed = 0;
        for (const r of t.rows) if (typeof r[i] === 'string' && (r[i] as string).includes(step.find)) {
          r[i] = (r[i] as string).split(step.find).join(step.with);
          changed += 1;
        }
        log.push(`${n}. Replaced "${step.find}" with "${step.with}" in ${changed} cell(s) of "${step.column}".`);
        break;
      }
      case 'toNumber': {
        for (const c of step.columns) {
          const i = col(t, c);
          let bad = 0;
          for (const r of t.rows) {
            const v = toNumber(r[i]!);
            if (typeof v !== 'number' && v !== null) bad += 1;
            r[i] = v;
          }
          log.push(`${n}. Read "${c}" as numbers${bad ? `; ${bad} value(s) were not numbers and were left as written` : ''}.`);
        }
        break;
      }
      case 'toDate': {
        const i = col(t, step.column);
        let bad = 0;
        for (const r of t.rows) {
          const v = toIsoDate(r[i]!, step.order);
          if (v !== null && !(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))) bad += 1;
          r[i] = v;
        }
        log.push(`${n}. Normalised "${step.column}" to YYYY-MM-DD (read as ${step.order})${bad ? `; ${bad} value(s) were not dates and were left as written` : ''}.`);
        break;
      }
      case 'dropEmpty': {
        const idx = step.columns.map((c) => col(t, c));
        t.rows = t.rows.filter((r) => idx.every((i) => r[i] !== null && r[i] !== ''));
        log.push(`${n}. Removed ${before - t.rows.length} row(s) missing ${step.columns.join(' or ')}.`);
        break;
      }
      case 'dedupe': {
        const idx = step.columns === '*' ? t.columns.map((_, i) => i) : step.columns.map((c) => col(t, c));
        const seen = new Set<string>();
        t.rows = t.rows.filter((r) => {
          const key = JSON.stringify(idx.map((i) => (typeof r[i] === 'string' ? (r[i] as string).toLowerCase() : r[i])));
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        log.push(`${n}. Removed ${before - t.rows.length} duplicate row(s) by ${step.columns === '*' ? 'every column' : step.columns.join(', ')}.`);
        break;
      }
      case 'filter': {
        const i = col(t, step.column);
        const want = step.value;
        t.rows = t.rows.filter((r) => {
          const v = r[i]!;
          switch (step.test) {
            case 'empty': return v === null;
            case 'notEmpty': return v !== null;
            case 'contains': return v !== null && String(v).toLowerCase().includes(String(want ?? '').toLowerCase());
            case 'eq': return v !== null && String(v).toLowerCase() === String(want ?? '').toLowerCase();
            case 'ne': return v === null || String(v).toLowerCase() !== String(want ?? '').toLowerCase();
            default: {
              const a = typeof v === 'number' ? v : Number(v);
              const b = Number(want);
              if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
              return step.test === 'gt' ? a > b : step.test === 'lt' ? a < b : step.test === 'ge' ? a >= b : a <= b;
            }
          }
        });
        log.push(`${n}. Kept rows where "${step.column}" ${step.test}${want !== undefined ? ` ${want}` : ''}: removed ${before - t.rows.length}.`);
        break;
      }
      case 'fill': {
        const i = col(t, step.column);
        let filled = 0;
        for (const r of t.rows) if (r[i] === null) {
          r[i] = step.value;
          filled += 1;
        }
        log.push(`${n}. Filled ${filled} empty "${step.column}" value(s) with ${JSON.stringify(step.value)}.`);
        break;
      }
      case 'derive': {
        if (t.columns.includes(step.column)) throw new PipelineError(`Step ${n}: a column "${step.column}" already exists.`);
        const read = (operand: string | number, r: Value[]): Value => (typeof operand === 'number' ? operand : r[col(t, operand)]!);
        let blanks = 0;
        const values = t.rows.map((r) => {
          const a = read(step.a, r);
          const b = read(step.b, r);
          if (step.operator === 'concat') return `${a ?? ''}${b ?? ''}`;
          if (typeof a !== 'number' || typeof b !== 'number' || (step.operator === 'divide' && b === 0)) {
            blanks += 1;
            return null;
          }
          const v = step.operator === 'add' ? a + b : step.operator === 'subtract' ? a - b : step.operator === 'multiply' ? a * b : a / b;
          return Math.round(v * 1e10) / 1e10;
        });
        t.columns.push(step.column);
        t.rows.forEach((r, j) => r.push(values[j]!));
        log.push(`${n}. Added "${step.column}" = ${step.a} ${step.operator} ${step.b}${blanks ? `; ${blanks} row(s) left blank (missing or non-numeric input, or division by zero)` : ''}.`);
        break;
      }
      case 'group': {
        const by = step.by.map((c) => col(t, c));
        const groups = new Map<string, { key: Value[]; rows: Value[][] }>();
        for (const r of t.rows) {
          const key = by.map((i) => r[i]!);
          const k = JSON.stringify(key);
          const g = groups.get(k) ?? { key, rows: [] };
          g.rows.push(r);
          groups.set(k, g);
        }
        const aggs = step.aggregates.map((a) => ({ ...a, i: a.fn === 'count' && a.column === '*' ? -1 : col(t, a.column) }));
        const rows = [...groups.values()].map((g) => [
          ...g.key,
          ...aggs.map((a) => {
            if (a.fn === 'count') return a.i < 0 ? g.rows.length : g.rows.filter((r) => r[a.i] !== null).length;
            const nums = g.rows.map((r) => r[a.i]).filter((v): v is number => typeof v === 'number');
            if (nums.length === 0) return null;
            const v = a.fn === 'sum' ? nums.reduce((s, x) => s + x, 0) : a.fn === 'avg' ? nums.reduce((s, x) => s + x, 0) / nums.length : a.fn === 'min' ? Math.min(...nums) : Math.max(...nums);
            return Math.round(v * 1e10) / 1e10;
          }),
        ]);
        t = { columns: [...step.by, ...step.aggregates.map((a) => a.as)], rows };
        log.push(`${n}. Grouped ${before} row(s) by ${step.by.join(', ')} into ${rows.length} group(s).`);
        break;
      }
      case 'sort': {
        const i = col(t, step.column);
        t.rows.sort((a, b) => (step.order === 'asc' ? compare(a[i]!, b[i]!) : -compare(a[i]!, b[i]!)));
        log.push(`${n}. Sorted by "${step.column}" ${step.order === 'asc' ? 'ascending' : 'descending'}.`);
        break;
      }
      case 'datePart': {
        if (t.columns.includes(step.column)) throw new PipelineError(`Step ${n}: a column "${step.column}" already exists.`);
        const i = col(t, step.from);
        let blanks = 0;
        const values = t.rows.map((r) => {
          const v = r[i];
          const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-\d{2}$/.exec(v) : null;
          if (!m) {
            blanks += 1;
            return null;
          }
          const month = Number(m[2]);
          return step.part === 'year' ? Number(m[1]) : step.part === 'month' ? month : step.part === 'quarter' ? `${m[1]}-Q${Math.ceil(month / 3)}` : `${m[1]}-${m[2]}`;
        });
        t.columns.push(step.column);
        t.rows.forEach((r, j) => r.push(values[j]!));
        log.push(`${n}. Added "${step.column}" as the ${step.part} of "${step.from}"${blanks ? `; ${blanks} row(s) had no YYYY-MM-DD date and were left blank` : ''}.`);
        break;
      }
      case 'append': {
        const other = files(step.file, step.sheet);
        const map = t.columns.map((c) => other.columns.indexOf(c));
        const missing = t.columns.filter((_, j) => map[j]! < 0);
        if (missing.length === t.columns.length) throw new PipelineError(`Step ${n}: ${step.file} shares no columns with the table.`);
        t.rows.push(...other.rows.map((r) => map.map((j) => (j < 0 ? null : r[j]!))));
        if (t.rows.length > MAX_SOURCE_ROWS) throw new PipelineError(`Step ${n}: the table would have more than ${MAX_SOURCE_ROWS} rows.`);
        log.push(`${n}. Appended ${other.rows.length} row(s) from ${step.file}${missing.length ? `; it has no ${missing.join(', ')}` : ''}.`);
        break;
      }
    }
  }
  log.push(`Result: ${t.rows.length} row(s), ${t.columns.length} column(s).`);
  return { table: t, log };
}

export interface FileContext {
  /** The client's files, by name, as Brain downloaded and stored them. */
  files: Map<string, Buffer>;
}

export type ColumnType = 'string' | 'number' | 'integer' | 'boolean' | 'date';

export interface ResolvedDataset {
  columns: { name: string; type: ColumnType }[];
  rows: Value[][];
  /** What the steps did, line by line; null for literal data. */
  log: string[] | null;
}

function inferType(values: Value[]): ColumnType {
  const present = values.filter((v) => v !== null);
  if (present.length === 0) return 'string';
  if (present.every((v) => typeof v === 'boolean')) return 'boolean';
  if (present.every((v) => typeof v === 'number')) return present.every((v) => Number.isInteger(v)) ? 'integer' : 'number';
  if (present.every((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))) return 'date';
  return 'string';
}

/** A dataset spec as the concrete table it stands for. Throws PipelineError for a step that cannot run. */
export function resolveDataset(
  spec: { columns?: { name: string; type: ColumnType }[]; rows?: Value[][]; source?: DataSource; steps?: Step[] },
  context: FileContext | undefined,
): ResolvedDataset {
  if (!spec.source) return { columns: spec.columns ?? [], rows: spec.rows ?? [], log: null };
  const files = context?.files ?? new Map<string, Buffer>();
  const load = (name: string, sheet?: string, headerRow?: number): Table => {
    const bytes = files.get(name) ?? [...files.entries()].find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
    if (!bytes) throw new PipelineError(`The client sent no file named "${name}"; the files are ${[...files.keys()].join(', ') || 'none'}.`);
    return loadTable(name, bytes, sheet, headerRow);
  };
  const { table, log } = runPipeline(load(spec.source.file, spec.source.sheet, spec.source.headerRow), spec.steps ?? [], (n, sh) => load(n, sh));
  return {
    columns: table.columns.map((name, i) => ({ name, type: inferType(table.rows.map((r) => r[i]!)) })),
    rows: table.rows,
    log,
  };
}
