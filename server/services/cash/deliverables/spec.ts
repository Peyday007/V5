/**
 * What a worker may hand Brain as a finished deliverable.
 *
 * A worker never uploads a file. It submits a *specification* — the cells, the
 * slides, the paragraphs, the SVG, the primitives — and Brain renders the file
 * itself, deterministically, then verifies the bytes it produced (`verify.ts`).
 * That split is §8 at a new artifact: a model proposes, the server decides, and
 * nothing a worker sends is executed. Code is carried as text and parsed, never
 * run, on the production server.
 *
 * The validator is zero-trust in the usual way: an unknown field, an unknown
 * kind or a value outside its bounds refuses the whole specification with every
 * problem named, so the next attempt can be a correction rather than a guess.
 */

import { MAX_STEPS, STEP_OPS, type DataSource, type Step } from './pipeline.ts';

export const DELIVERABLE_KINDS = [
  'SPREADSHEET',
  'DOCUMENT',
  'PRESENTATION',
  'DATASET',
  'WEBSITE',
  'CODE',
  'GRAPHIC',
  'MODEL_3D',
] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

/** What each kind is called where a person or a question reads it. */
export const DELIVERABLE_LABEL: Record<DeliverableKind, string> = {
  SPREADSHEET: 'spreadsheet',
  DOCUMENT: 'business document',
  PRESENTATION: 'presentation',
  DATASET: 'data operations',
  WEBSITE: 'website',
  CODE: 'programming',
  GRAPHIC: 'graphic design',
  MODEL_3D: '3D model',
};

export type CellFormat = 'general' | 'integer' | 'decimal' | 'currency' | 'percent' | 'date' | 'text';
export const CELL_FORMATS: readonly CellFormat[] = ['general', 'integer', 'decimal', 'currency', 'percent', 'date', 'text'];

export interface CellObject {
  v?: string | number | boolean;
  f?: string;
  bold?: boolean;
  fmt?: CellFormat;
  fill?: string;
  color?: string;
  align?: 'left' | 'center' | 'right';
}
export type Cell = null | string | number | boolean | CellObject;

export interface Sheet {
  name: string;
  columnWidths?: number[];
  rows: Cell[][];
  freezeRows?: number;
}

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie';
  title?: string;
  categories: string[];
  series: { name: string; values: number[] }[];
}

export interface TableSpec {
  header: string[];
  rows: string[][];
}

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'numbered'; items: string[] }
  | { type: 'table'; table: TableSpec }
  | { type: 'chart'; chart: ChartSpec }
  | { type: 'pagebreak' };

export interface Slide {
  layout: 'title' | 'section' | 'bullets' | 'two-column' | 'chart' | 'table';
  title: string;
  subtitle?: string;
  bullets?: string[];
  left?: string[];
  right?: string[];
  chart?: ChartSpec;
  table?: TableSpec;
}

export interface ProjectFile {
  path: string;
  content: string;
}

export interface Part3D {
  name: string;
  shape: 'box' | 'cylinder' | 'sphere' | 'cone';
  /** box: [x, y, z]; cylinder/cone: [radius, height]; sphere: [radius]. */
  size: number[];
  position: [number, number, number];
  rotation?: [number, number, number];
  color: string;
}

export type DeliverableSpec =
  | { kind: 'SPREADSHEET'; filename: string; sheets: Sheet[] }
  | {
      kind: 'DOCUMENT';
      filename: string;
      title: string;
      subtitle?: string;
      blocks: Block[];
      formats: ('docx' | 'pdf' | 'md')[];
    }
  | { kind: 'PRESENTATION'; filename: string; title: string; accent?: string; slides: Slide[] }
  | {
      kind: 'DATASET';
      filename: string;
      /** Literal data, for a dataset the worker compiled itself... */
      columns?: { name: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'date' }[];
      rows?: (string | number | boolean | null)[][];
      /** ...or a client file and the steps Brain runs over it (`pipeline.ts`). */
      source?: DataSource;
      steps?: Step[];
      formats: ('csv' | 'xlsx' | 'json')[];
    }
  | { kind: 'WEBSITE'; filename: string; files: ProjectFile[] }
  | {
      kind: 'CODE';
      filename: string;
      language: 'python' | 'javascript';
      entry: string;
      files: ProjectFile[];
    }
  | { kind: 'GRAPHIC'; filename: string; width: number; height: number; svg: string; formats: ('svg' | 'png' | 'pdf')[] }
  | { kind: 'MODEL_3D'; filename: string; units: 'mm' | 'cm' | 'm'; parts: Part3D[]; formats: ('obj' | 'stl' | 'gltf')[] };

export interface Submission {
  /** One spec per deliverable kind the job asks for, in that order. */
  specs: DeliverableSpec[];
  /** What to tell the client with the files. Optional; Brain has a default. */
  message: string | null;
}

export type SpecResult = { ok: true; submission: Submission } | { ok: false; problems: string[] };

const HEX = /^#[0-9a-fA-F]{6}$/;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;
const MAX_TEXT = 20_000;

class Checker {
  readonly problems: string[] = [];

  object(value: unknown, at: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.problems.push(`${at} must be an object.`);
      return null;
    }
    const body = value as Record<string, unknown>;
    const extra = Object.keys(body).filter((key) => !allowed.includes(key));
    if (extra.length) this.problems.push(`${at} has field(s) this contract does not define: ${extra.join(', ')}.`);
    for (const key of required) if (body[key] === undefined) this.problems.push(`${at}.${key} is required.`);
    return body;
  }

  string(value: unknown, at: string, max = MAX_TEXT, optional = false): string | undefined {
    if (value === undefined && optional) return undefined;
    if (typeof value !== 'string' || value.trim().length === 0) {
      this.problems.push(`${at} must be a non-empty string.`);
      return undefined;
    }
    if (value.length > max) this.problems.push(`${at} is ${value.length} characters; the limit is ${max}.`);
    return value;
  }

  number(value: unknown, at: string, min = -1e15, max = 1e15): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.problems.push(`${at} must be a finite number.`);
      return undefined;
    }
    if (value < min || value > max) this.problems.push(`${at} must be between ${min} and ${max}.`);
    return value;
  }

  array(value: unknown, at: string, min: number, max: number): unknown[] {
    if (!Array.isArray(value)) {
      this.problems.push(`${at} must be an array.`);
      return [];
    }
    if (value.length < min) this.problems.push(`${at} needs at least ${min} item(s).`);
    if (value.length > max) this.problems.push(`${at} has ${value.length} items; the limit is ${max}.`);
    return value.slice(0, max);
  }

  oneOf<T extends string>(value: unknown, at: string, options: readonly T[]): T | undefined {
    if (typeof value !== 'string' || !options.includes(value as T)) {
      this.problems.push(`${at} must be one of ${options.join(', ')}.`);
      return undefined;
    }
    return value as T;
  }

  formats<T extends string>(value: unknown, at: string, options: readonly T[]): void {
    const list = this.array(value, at, 1, options.length);
    for (const [i, one] of list.entries()) this.oneOf(one, `${at}[${i}]`, options);
    if (new Set(list).size !== list.length) this.problems.push(`${at} repeats a format.`);
  }

  color(value: unknown, at: string, optional = false): void {
    if (value === undefined && optional) return;
    if (typeof value !== 'string' || !HEX.test(value)) this.problems.push(`${at} must be a #RRGGBB colour.`);
  }

  strings(value: unknown, at: string, min: number, max: number, each = 2000): void {
    for (const [i, one] of this.array(value, at, min, max).entries()) this.string(one, `${at}[${i}]`, each);
  }
}

function checkChart(c: Checker, value: unknown, at: string): void {
  const chart = c.object(value, at, ['type', 'title', 'categories', 'series'], ['type', 'categories', 'series']);
  if (!chart) return;
  c.oneOf(chart.type, `${at}.type`, ['bar', 'line', 'pie'] as const);
  c.string(chart.title, `${at}.title`, 200, true);
  const categories = c.array(chart.categories, `${at}.categories`, 1, 40);
  for (const [i, one] of categories.entries()) c.string(one, `${at}.categories[${i}]`, 60);
  const series = c.array(chart.series, `${at}.series`, 1, chart.type === 'pie' ? 1 : 6);
  for (const [i, one] of series.entries()) {
    const s = c.object(one, `${at}.series[${i}]`, ['name', 'values'], ['name', 'values']);
    if (!s) continue;
    c.string(s.name, `${at}.series[${i}].name`, 80);
    const values = c.array(s.values, `${at}.series[${i}].values`, categories.length, categories.length);
    for (const [j, v] of values.entries()) c.number(v, `${at}.series[${i}].values[${j}]`, chart.type === 'pie' ? 0 : -1e15);
  }
}

function checkTable(c: Checker, value: unknown, at: string): void {
  const table = c.object(value, at, ['header', 'rows'], ['header', 'rows']);
  if (!table) return;
  const header = c.array(table.header, `${at}.header`, 1, 12);
  for (const [i, one] of header.entries()) c.string(one, `${at}.header[${i}]`, 200);
  for (const [i, row] of c.array(table.rows, `${at}.rows`, 1, 200).entries()) {
    const cells = c.array(row, `${at}.rows[${i}]`, header.length, header.length);
    for (const [j, one] of cells.entries()) {
      if (typeof one !== 'string') c.problems.push(`${at}.rows[${i}][${j}] must be a string ("" for empty).`);
      else if (one.length > 1000) c.problems.push(`${at}.rows[${i}][${j}] is too long.`);
    }
  }
}

function checkCell(c: Checker, value: unknown, at: string): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > 5000) c.problems.push(`${at} is too long.`);
    return;
  }
  if (typeof value === 'number') {
    c.number(value, at);
    return;
  }
  const cell = c.object(value, at, ['v', 'f', 'bold', 'fmt', 'fill', 'color', 'align'], []);
  if (!cell) return;
  if (cell.v !== undefined && !['string', 'number', 'boolean'].includes(typeof cell.v)) c.problems.push(`${at}.v must be a string, number or boolean.`);
  if (cell.f !== undefined) {
    if (typeof cell.f !== 'string' || !cell.f.trim()) c.problems.push(`${at}.f must be a formula string.`);
    else if (cell.f.length > 2000) c.problems.push(`${at}.f is too long.`);
    if (cell.v !== undefined) c.problems.push(`${at} has both "v" and "f"; Brain computes a formula's value itself.`);
  }
  if (cell.bold !== undefined && typeof cell.bold !== 'boolean') c.problems.push(`${at}.bold must be true or false.`);
  if (cell.fmt !== undefined) c.oneOf(cell.fmt, `${at}.fmt`, CELL_FORMATS);
  c.color(cell.fill, `${at}.fill`, true);
  c.color(cell.color, `${at}.color`, true);
  if (cell.align !== undefined) c.oneOf(cell.align, `${at}.align`, ['left', 'center', 'right'] as const);
}

const WEB_EXTENSIONS = /\.(html|css|js|svg|json|txt|md|xml|ico)$/i;
const CODE_EXTENSIONS = /\.(py|js|mjs|cjs|json|md|txt|toml|cfg|ini|csv|yml|yaml)$/i;

function checkFiles(c: Checker, value: unknown, at: string, pattern: RegExp, maxFiles: number): ProjectFile[] {
  const files: ProjectFile[] = [];
  const seen = new Set<string>();
  for (const [i, one] of c.array(value, at, 1, maxFiles).entries()) {
    const file = c.object(one, `${at}[${i}]`, ['path', 'content'], ['path', 'content']);
    if (!file) continue;
    const path = typeof file.path === 'string' ? file.path : '';
    if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,120}$/.test(path) || path.split('/').some((p) => p === '..' || p === '' || p === '.')) {
      c.problems.push(`${at}[${i}].path ${JSON.stringify(file.path)} is not a safe relative path.`);
      continue;
    }
    if (!pattern.test(path)) c.problems.push(`${at}[${i}].path ${path} has a file type this deliverable does not carry.`);
    if (seen.has(path)) c.problems.push(`${at}[${i}].path ${path} appears twice.`);
    seen.add(path);
    if (typeof file.content !== 'string') c.problems.push(`${at}[${i}].content must be a string.`);
    else if (file.content.length > 60_000) c.problems.push(`${at}[${i}].content is too long.`);
    else files.push({ path, content: file.content });
  }
  return files;
}

const STEP_FIELDS: Record<(typeof STEP_OPS)[number], { allowed: string[]; required: string[] }> = {
  select: { allowed: ['columns'], required: ['columns'] },
  rename: { allowed: ['from', 'to'], required: ['from', 'to'] },
  trim: { allowed: ['columns'], required: ['columns'] },
  case: { allowed: ['column', 'to'], required: ['column', 'to'] },
  replace: { allowed: ['column', 'find', 'with'], required: ['column', 'find', 'with'] },
  toNumber: { allowed: ['columns'], required: ['columns'] },
  toDate: { allowed: ['column', 'order'], required: ['column', 'order'] },
  dropEmpty: { allowed: ['columns'], required: ['columns'] },
  dedupe: { allowed: ['columns'], required: ['columns'] },
  filter: { allowed: ['column', 'test', 'value'], required: ['column', 'test'] },
  fill: { allowed: ['column', 'value'], required: ['column', 'value'] },
  derive: { allowed: ['column', 'a', 'operator', 'b'], required: ['column', 'a', 'operator', 'b'] },
  group: { allowed: ['by', 'aggregates'], required: ['by', 'aggregates'] },
  sort: { allowed: ['column', 'order'], required: ['column', 'order'] },
  append: { allowed: ['file', 'sheet'], required: ['file'] },
  datePart: { allowed: ['column', 'from', 'part'], required: ['column', 'from', 'part'] },
};

function checkPipeline(c: Checker, source: unknown, steps: unknown): void {
  const src = c.object(source, 'spec.source', ['file', 'sheet', 'headerRow'], ['file']);
  if (src) {
    c.string(src.file, 'spec.source.file', 200);
    c.string(src.sheet, 'spec.source.sheet', 100, true);
    if (src.headerRow !== undefined) c.number(src.headerRow, 'spec.source.headerRow', 0, 50);
  }
  for (const [i, raw] of c.array(steps, 'spec.steps', 0, MAX_STEPS).entries()) {
    const at = `spec.steps[${i}]`;
    const op = (raw as { op?: unknown } | null)?.op;
    if (typeof op !== 'string' || !(STEP_OPS as readonly string[]).includes(op)) {
      c.problems.push(`${at}.op must be one of ${STEP_OPS.join(', ')}.`);
      continue;
    }
    const fields = STEP_FIELDS[op as (typeof STEP_OPS)[number]];
    const step = c.object(raw, at, ['op', ...fields.allowed], ['op', ...fields.required]);
    if (!step) continue;
    if (step.columns !== undefined && step.columns !== '*') c.strings(step.columns, `${at}.columns`, 1, 100, 200);
    for (const key of ['column', 'from', 'to', 'file', 'sheet']) if (step[key] !== undefined && key !== 'to') c.string(step[key], `${at}.${key}`, 200);
    if (op === 'case') c.oneOf(step.to, `${at}.to`, ['lower', 'upper', 'title'] as const);
    else if (op === 'rename') c.string(step.to, `${at}.to`, 200);
    if (op === 'datePart') {
      c.string(step.from, `${at}.from`, 200);
      c.oneOf(step.part, `${at}.part`, ['year', 'month', 'yearMonth', 'quarter'] as const);
    }
    if (op === 'toDate') c.oneOf(step.order, `${at}.order`, ['YMD', 'DMY', 'MDY'] as const);
    if (op === 'sort') c.oneOf(step.order, `${at}.order`, ['asc', 'desc'] as const);
    if (op === 'filter') {
      c.oneOf(step.test, `${at}.test`, ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'contains', 'empty', 'notEmpty'] as const);
      if (!['empty', 'notEmpty'].includes(String(step.test)) && step.value === undefined) c.problems.push(`${at}.value is required for ${String(step.test)}.`);
    }
    if (op === 'derive') {
      c.oneOf(step.operator, `${at}.operator`, ['add', 'subtract', 'multiply', 'divide', 'concat'] as const);
      for (const key of ['a', 'b']) if (typeof step[key] !== 'string' && typeof step[key] !== 'number') c.problems.push(`${at}.${key} must be a column name or a number.`);
    }
    if ((op === 'fill' || op === 'replace') && typeof step.value !== 'string' && typeof step.value !== 'number' && op === 'fill') c.problems.push(`${at}.value must be a string or number.`);
    if (op === 'replace') {
      c.string(step.find, `${at}.find`, 500);
      if (typeof step.with !== 'string') c.problems.push(`${at}.with must be a string ("" to delete).`);
    }
    if (op === 'group') {
      c.strings(step.by, `${at}.by`, 1, 10, 200);
      for (const [j, a] of c.array(step.aggregates, `${at}.aggregates`, 1, 20).entries()) {
        const agg = c.object(a, `${at}.aggregates[${j}]`, ['column', 'fn', 'as'], ['column', 'fn', 'as']);
        if (!agg) continue;
        c.string(agg.column, `${at}.aggregates[${j}].column`, 200);
        c.oneOf(agg.fn, `${at}.aggregates[${j}].fn`, ['sum', 'avg', 'count', 'min', 'max'] as const);
        c.string(agg.as, `${at}.aggregates[${j}].as`, 200);
      }
    }
  }
}

function checkSpec(c: Checker, raw: unknown): void {
  const base = c.object(raw, 'spec', ['kind', 'filename', 'sheets', 'title', 'subtitle', 'blocks', 'formats', 'accent', 'slides', 'columns', 'rows', 'source', 'steps', 'files', 'language', 'entry', 'width', 'height', 'svg', 'units', 'parts'], ['kind', 'filename']);
  if (!base) return;
  const kind = c.oneOf(base.kind, 'spec.kind', DELIVERABLE_KINDS);
  if (typeof base.filename !== 'string' || !FILENAME.test(base.filename) || /\.[a-z0-9]{2,5}$/i.test(base.filename)) {
    c.problems.push('spec.filename must be a plain name of letters, digits, spaces, dots, dashes or underscores, without an extension (Brain adds the extensions).');
  }
  const allowed: Record<DeliverableKind, string[]> = {
    SPREADSHEET: ['sheets'],
    DOCUMENT: ['title', 'subtitle', 'blocks', 'formats'],
    PRESENTATION: ['title', 'accent', 'slides'],
    DATASET: ['columns', 'rows', 'source', 'steps', 'formats'],
    WEBSITE: ['files'],
    CODE: ['language', 'entry', 'files'],
    GRAPHIC: ['width', 'height', 'svg', 'formats'],
    MODEL_3D: ['units', 'parts', 'formats'],
  };
  if (!kind) return;
  const stray = Object.keys(base).filter((key) => key !== 'kind' && key !== 'filename' && !allowed[kind].includes(key));
  if (stray.length) c.problems.push(`spec of kind ${kind} does not carry: ${stray.join(', ')}.`);

  switch (kind) {
    case 'SPREADSHEET': {
      const names = new Set<string>();
      for (const [i, one] of c.array(base.sheets, 'spec.sheets', 1, 12).entries()) {
        const sheet = c.object(one, `spec.sheets[${i}]`, ['name', 'columnWidths', 'rows', 'freezeRows'], ['name', 'rows']);
        if (!sheet) continue;
        const name = c.string(sheet.name, `spec.sheets[${i}].name`, 31);
        if (name && /[\\/?*[\]:]/.test(name)) c.problems.push(`spec.sheets[${i}].name may not contain \\ / ? * [ ] :`);
        if (name && names.has(name.toLowerCase())) c.problems.push(`spec.sheets[${i}].name repeats ${name}.`);
        if (name) names.add(name.toLowerCase());
        if (sheet.columnWidths !== undefined) {
          for (const [j, w] of c.array(sheet.columnWidths, `spec.sheets[${i}].columnWidths`, 0, 60).entries()) c.number(w, `spec.sheets[${i}].columnWidths[${j}]`, 2, 120);
        }
        if (sheet.freezeRows !== undefined) c.number(sheet.freezeRows, `spec.sheets[${i}].freezeRows`, 0, 20);
        for (const [r, row] of c.array(sheet.rows, `spec.sheets[${i}].rows`, 1, 2000).entries()) {
          for (const [col, cell] of c.array(row, `spec.sheets[${i}].rows[${r}]`, 0, 60).entries()) checkCell(c, cell, `spec.sheets[${i}].rows[${r}][${col}]`);
        }
      }
      break;
    }
    case 'DOCUMENT': {
      c.string(base.title, 'spec.title', 200);
      c.string(base.subtitle, 'spec.subtitle', 300, true);
      c.formats(base.formats, 'spec.formats', ['docx', 'pdf', 'md'] as const);
      for (const [i, one] of c.array(base.blocks, 'spec.blocks', 1, 600).entries()) {
        const at = `spec.blocks[${i}]`;
        const type = (one as Record<string, unknown> | null)?.type;
        switch (type) {
          case 'heading': {
            const b = c.object(one, at, ['type', 'level', 'text'], ['type', 'level', 'text']);
            if (b) {
              c.oneOf(String(b.level), `${at}.level`, ['1', '2', '3'] as const);
              c.string(b.text, `${at}.text`, 300);
            }
            break;
          }
          case 'paragraph': {
            const b = c.object(one, at, ['type', 'text'], ['type', 'text']);
            if (b) c.string(b.text, `${at}.text`, 6000);
            break;
          }
          case 'bullets':
          case 'numbered': {
            const b = c.object(one, at, ['type', 'items'], ['type', 'items']);
            if (b) c.strings(b.items, `${at}.items`, 1, 60);
            break;
          }
          case 'table': {
            const b = c.object(one, at, ['type', 'table'], ['type', 'table']);
            if (b) checkTable(c, b.table, `${at}.table`);
            break;
          }
          case 'chart': {
            const b = c.object(one, at, ['type', 'chart'], ['type', 'chart']);
            if (b) checkChart(c, b.chart, `${at}.chart`);
            break;
          }
          case 'pagebreak':
            c.object(one, at, ['type'], ['type']);
            break;
          default:
            c.problems.push(`${at}.type must be heading, paragraph, bullets, numbered, table, chart or pagebreak.`);
        }
      }
      break;
    }
    case 'PRESENTATION': {
      c.string(base.title, 'spec.title', 200);
      c.color(base.accent, 'spec.accent', true);
      for (const [i, one] of c.array(base.slides, 'spec.slides', 1, 60).entries()) {
        const at = `spec.slides[${i}]`;
        const s = c.object(one, at, ['layout', 'title', 'subtitle', 'bullets', 'left', 'right', 'chart', 'table'], ['layout', 'title']);
        if (!s) continue;
        const layout = c.oneOf(s.layout, `${at}.layout`, ['title', 'section', 'bullets', 'two-column', 'chart', 'table'] as const);
        c.string(s.title, `${at}.title`, 150);
        c.string(s.subtitle, `${at}.subtitle`, 300, true);
        if (s.bullets !== undefined) c.strings(s.bullets, `${at}.bullets`, 1, 8, 300);
        if (s.left !== undefined) c.strings(s.left, `${at}.left`, 1, 8, 300);
        if (s.right !== undefined) c.strings(s.right, `${at}.right`, 1, 8, 300);
        if (layout === 'bullets' && s.bullets === undefined) c.problems.push(`${at} uses layout bullets and carries no bullets.`);
        if (layout === 'two-column' && (s.left === undefined || s.right === undefined)) c.problems.push(`${at} uses layout two-column and needs left and right.`);
        if (layout === 'chart') s.chart === undefined ? c.problems.push(`${at} uses layout chart and carries no chart.`) : checkChart(c, s.chart, `${at}.chart`);
        else if (s.chart !== undefined) c.problems.push(`${at}.chart belongs only on a chart slide.`);
        if (layout === 'table') s.table === undefined ? c.problems.push(`${at} uses layout table and carries no table.`) : checkTable(c, s.table, `${at}.table`);
        else if (s.table !== undefined) c.problems.push(`${at}.table belongs only on a table slide.`);
      }
      break;
    }
    case 'DATASET': {
      c.formats(base.formats, 'spec.formats', ['csv', 'xlsx', 'json'] as const);
      if (base.source !== undefined || base.steps !== undefined) {
        if (base.columns !== undefined || base.rows !== undefined) c.problems.push('spec carries both literal rows and a source; send one.');
        checkPipeline(c, base.source, base.steps);
        break;
      }
      const columns = c.array(base.columns, 'spec.columns', 1, 60);
      const types: string[] = [];
      for (const [i, one] of columns.entries()) {
        const col = c.object(one, `spec.columns[${i}]`, ['name', 'type'], ['name', 'type']);
        if (!col) continue;
        c.string(col.name, `spec.columns[${i}].name`, 100);
        types.push(c.oneOf(col.type, `spec.columns[${i}].type`, ['string', 'number', 'integer', 'boolean', 'date'] as const) ?? 'string');
      }
      for (const [r, row] of c.array(base.rows, 'spec.rows', 1, 20_000).entries()) {
        const cells = c.array(row, `spec.rows[${r}]`, columns.length, columns.length);
        cells.forEach((value, j) => {
          if (value === null) return;
          const type = types[j];
          const at = `spec.rows[${r}][${j}]`;
          if (type === 'string' && typeof value !== 'string') c.problems.push(`${at} must be a string or null.`);
          if ((type === 'number' || type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value))) c.problems.push(`${at} must be a number or null.`);
          if (type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) c.problems.push(`${at} must be a whole number.`);
          if (type === 'boolean' && typeof value !== 'boolean') c.problems.push(`${at} must be true, false or null.`);
          if (type === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))) c.problems.push(`${at} must be a YYYY-MM-DD date or null.`);
          if (typeof value === 'string' && value.length > 5000) c.problems.push(`${at} is too long.`);
        });
      }
      break;
    }
    case 'WEBSITE': {
      const files = checkFiles(c, base.files, 'spec.files', WEB_EXTENSIONS, 30);
      if (files.length && !files.some((f) => f.path === 'index.html')) c.problems.push('spec.files must include index.html at the top level.');
      break;
    }
    case 'CODE': {
      c.oneOf(base.language, 'spec.language', ['python', 'javascript'] as const);
      const files = checkFiles(c, base.files, 'spec.files', CODE_EXTENSIONS, 30);
      const entry = c.string(base.entry, 'spec.entry', 120);
      if (entry && !files.some((f) => f.path === entry)) c.problems.push(`spec.entry ${entry} is not one of the files.`);
      if (files.length && !files.some((f) => /^readme\.md$/i.test(f.path))) c.problems.push('spec.files must include README.md saying how to run it.');
      break;
    }
    case 'GRAPHIC': {
      c.number(base.width, 'spec.width', 16, 8000);
      c.number(base.height, 'spec.height', 16, 8000);
      c.string(base.svg, 'spec.svg', 58_000);
      c.formats(base.formats, 'spec.formats', ['svg', 'png', 'pdf'] as const);
      break;
    }
    case 'MODEL_3D': {
      c.oneOf(base.units, 'spec.units', ['mm', 'cm', 'm'] as const);
      c.formats(base.formats, 'spec.formats', ['obj', 'stl', 'gltf'] as const);
      for (const [i, one] of c.array(base.parts, 'spec.parts', 1, 200).entries()) {
        const at = `spec.parts[${i}]`;
        const p = c.object(one, at, ['name', 'shape', 'size', 'position', 'rotation', 'color'], ['name', 'shape', 'size', 'position', 'color']);
        if (!p) continue;
        c.string(p.name, `${at}.name`, 60);
        const shape = c.oneOf(p.shape, `${at}.shape`, ['box', 'cylinder', 'sphere', 'cone'] as const);
        const want = shape === 'box' ? 3 : shape === 'sphere' ? 1 : 2;
        for (const [j, v] of c.array(p.size, `${at}.size`, want, want).entries()) c.number(v, `${at}.size[${j}]`, 1e-6, 1e6);
        for (const [j, v] of c.array(p.position, `${at}.position`, 3, 3).entries()) c.number(v, `${at}.position[${j}]`, -1e6, 1e6);
        if (p.rotation !== undefined) for (const [j, v] of c.array(p.rotation, `${at}.rotation`, 3, 3).entries()) c.number(v, `${at}.rotation[${j}]`, -360, 360);
        c.color(p.color, `${at}.color`);
      }
      break;
    }
  }
}

/**
 * A message Brain sends with a deliverable is sent under the owner's name, so a
 * worker's message is refused for carrying contact details, a payment channel
 * or a link, never rewritten.
 */
export function messageProblems(text: string): string[] {
  const problems: string[] = [];
  if (text.length > 3000) problems.push('The message is longer than 3000 characters.');
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text)) problems.push('The message carries an email address; contact details stay off the platform.');
  if (/(\+?\d[\d\s().-]{8,}\d)/.test(text)) problems.push('The message carries what looks like a phone number.');
  if (/\b(whatsapp|telegram|skype|discord|paypal|venmo|wise\.com|bank transfer|off[- ]platform)\b/i.test(text)) {
    problems.push('The message points the client off the platform.');
  }
  if (/https?:\/\//i.test(text)) problems.push('The message carries a link; deliverables travel as attachments.');
  return problems;
}

export function validateSubmission(raw: string): SpecResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ['The submission was not valid JSON.'] };
  }
  const c = new Checker();
  const body = c.object(parsed, 'submission', ['spec', 'specs', 'message'], []);
  if (!body) return { ok: false, problems: c.problems };
  let specs: unknown[] = [];
  if (body.spec !== undefined && body.specs !== undefined) c.problems.push('submission carries both "spec" and "specs"; send one.');
  else if (body.spec !== undefined) specs = [body.spec];
  else specs = c.array(body.specs, 'submission.specs', 1, 3);
  if (specs.length === 0 && body.spec === undefined && body.specs === undefined) c.problems.push('submission.spec (or "specs") is required.');
  const before = c.problems.length;
  specs.forEach((one, i) => {
    const mark = c.problems.length;
    checkSpec(c, one);
    if (specs.length > 1) for (let j = mark; j < c.problems.length; j += 1) c.problems[j] = `specs[${i}]: ${c.problems[j]}`;
  });
  const names = specs.map((one) => (one as { filename?: unknown })?.filename);
  if (c.problems.length === before && new Set(names).size !== names.length) c.problems.push('Two specs share a filename; give each deliverable its own.');
  let message: string | null = null;
  if (body.message !== undefined && body.message !== null) {
    const text = c.string(body.message, 'submission.message', 3000);
    if (text) {
      c.problems.push(...messageProblems(text));
      message = text;
    }
  }
  if (c.problems.length) return { ok: false, problems: c.problems.slice(0, 60) };
  return { ok: true, submission: { specs: specs as DeliverableSpec[], message } };
}
