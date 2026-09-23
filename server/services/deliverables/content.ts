/**
 * What a worker submits for a deliverable, and every rule it is held to.
 *
 * The worker never uploads a file. It submits the *content* — sections and
 * paragraphs, or sheets and rows — each piece citing the claims it rests on,
 * and Brain renders the file itself (`docx.ts`, `xlsx.ts`). That split is the
 * whole answer to "a file stranded in a worker's environment": there is no
 * file there to strand, and the bytes a person opens are bytes Brain wrote from
 * content Brain validated.
 *
 * The same validator runs twice, deliberately. The bin's completion contract
 * calls it while the worker still holds the lease, so a problem comes back as
 * RETRY with the reason and the worker repairs it in the same session; and the
 * ingest calls it again before anything is rendered, because a lease can expire
 * and be retaken and the claims it cites can change underneath it.
 *
 * Four rules carry the weight, and each refuses the whole submission:
 *
 *  - **Every cited id is a citable claim of this project, now.** Re-read from
 *    rows, never trusted from the submission. A citation is a fact about the
 *    archive, not a claim about it.
 *  - **Every factual block cites.** A paragraph with no citation is allowed only
 *    as `framing`, and framing may not carry a figure.
 *  - **Every figure traces.** A number in cited text must appear in at least one
 *    of the claims it cites. A figure no cited source states is an invented
 *    figure, however plausible — and that is the failure a report is least able
 *    to recover from, because nobody re-checks a number that looks sourced.
 *  - **Every required content is covered or declared a gap.** A gap is an honest
 *    answer — *the archive does not settle this* — and it is carried into the
 *    file's limitations. Silently dropping one is not.
 */
import type { DeliverableKind, DeliverableSpec } from '../../domain/deliverables.ts';

/** One claim as the deliverable pipeline sees it. */
export interface EvidenceClaim {
  id: string;
  claim: string;
  sourceUrl: string;
  sourceTitle: string | null;
  sourcePublisher: string | null;
  sourceDate: string | null;
  excerpt: string | null;
  locator: string | null;
}

/** Resolves ids to citable claims of the project the deliverable belongs to. */
export type ClaimResolver = (ids: readonly string[]) => Promise<Map<string, EvidenceClaim>>;

/* =========================================================================
 * The written shape
 * ====================================================================== */

export interface CitedText {
  text: string;
  cites: string[];
  framing?: boolean;
}

export type WrittenBlock =
  | { type: 'paragraph'; text: string; cites: string[]; framing?: boolean }
  | { type: 'bullets'; items: CitedText[] }
  | { type: 'table'; columns: string[]; rows: string[][]; cites: string[] };

export interface WrittenSection {
  heading: string;
  covers: number[];
  blocks: WrittenBlock[];
}

export interface DeclaredGap {
  requiredContent: number;
  reason: string;
}

export interface WrittenContent {
  title: string;
  subtitle: string | null;
  summary: CitedText[];
  sections: WrittenSection[];
  gaps: DeclaredGap[];
  limitations: string[];
}

/* =========================================================================
 * The structured shape
 * ====================================================================== */

export const COLUMN_TYPES = ['text', 'number', 'currency', 'percent', 'date', 'url'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export const TOTAL_FUNCTIONS = ['SUM', 'COUNT', 'AVERAGE', 'MIN', 'MAX'] as const;
export type TotalFunction = (typeof TOTAL_FUNCTIONS)[number];

export interface SheetColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export type CellValue = string | number | null;

export interface SheetRow {
  values: Record<string, CellValue>;
  cites: string[];
}

export interface Sheet {
  name: string;
  covers: number[];
  columns: SheetColumn[];
  rows: SheetRow[];
  totals: Array<{ column: string; function: TotalFunction }>;
}

export interface StructuredContent {
  title: string;
  description: string;
  sheets: Sheet[];
  gaps: DeclaredGap[];
  notes: string[];
}

export type DeliverableContent =
  | { kind: 'WRITTEN'; content: WrittenContent }
  | { kind: 'STRUCTURED'; content: StructuredContent };

/* =========================================================================
 * Limits, stated once so the manifest renders them from here
 * ====================================================================== */

export const CONTENT_LIMITS = {
  title: 200,
  heading: 200,
  paragraph: 4_000,
  sections: 40,
  blocksPerSection: 60,
  sheets: 8,
  columns: 30,
  rowsPerSheet: 500,
  cell: 1_000,
  sheetName: 31,
  gapReason: 600,
  limitation: 600,
} as const;

/**
 * Integers this small are allowed without a source.
 *
 * A count of the rows in a table, an ordinal, "three counties" — these are
 * facts about the deliverable rather than about the world, and requiring a
 * source to state them would force the worker to reword ordinary English.
 * Anything larger, and anything with a decimal point, currency or percent,
 * must trace.
 */
export const UNSOURCED_INTEGER_CEILING = 12;

/* =========================================================================
 * Figures
 * ====================================================================== */

const NUMBER_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

/** Every number in a string, in one canonical spelling. */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const raw = match[0].replace(/,/g, '').replace(/\.$/, '');
    const value = Number(raw);
    if (Number.isFinite(value)) out.push(String(value));
  }
  return out;
}

/** Whether a number needs a source to state it. */
export function needsSource(canonical: string): boolean {
  const value = Number(canonical);
  return !(Number.isInteger(value) && value >= 0 && value <= UNSOURCED_INTEGER_CEILING);
}

function claimNumbers(claims: readonly EvidenceClaim[]): Set<string> {
  const all = new Set<string>();
  for (const claim of claims) {
    for (const n of numbersIn(`${claim.claim} ${claim.excerpt ?? ''} ${claim.locator ?? ''} ${claim.sourceDate ?? ''} ${claim.sourceTitle ?? ''}`)) {
      all.add(n);
    }
  }
  return all;
}

/* =========================================================================
 * Parsing
 * ====================================================================== */

export type ContentResult =
  | { ok: true; value: DeliverableContent; citedClaimIds: string[]; claims: Map<string, EvidenceClaim> }
  | { ok: false; problems: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function extraKeys(body: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(body).filter((key) => !allowed.includes(key));
}

function citesOf(value: unknown, where: string, problems: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((one) => typeof one !== 'string')) {
    problems.push(`${where}.cites must be an array of claim ids.`);
    return [];
  }
  return [...new Set((value as string[]).map((one) => one.trim()).filter(Boolean))];
}

function coversOf(value: unknown, where: string, count: number, problems: string[]): number[] {
  if (!Array.isArray(value)) {
    problems.push(`${where}.covers must be an array of required-content numbers (0-based).`);
    return [];
  }
  const out: number[] = [];
  for (const one of value) {
    if (typeof one !== 'number' || !Number.isInteger(one) || one < 0 || one >= count) {
      problems.push(`${where}.covers names ${JSON.stringify(one)}, which is not a required content (0 to ${count - 1}).`);
    } else out.push(one);
  }
  return out;
}

function gapsOf(value: unknown, count: number, problems: string[]): DeclaredGap[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push('"gaps" must be an array.');
    return [];
  }
  const out: DeclaredGap[] = [];
  value.forEach((entry, index) => {
    if (!isObject(entry)) {
      problems.push(`gaps[${index}] is not an object.`);
      return;
    }
    const n = entry['requiredContent'];
    const reason = str(entry['reason'], CONTENT_LIMITS.gapReason);
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= count) {
      problems.push(`gaps[${index}].requiredContent must be a required-content number (0 to ${count - 1}).`);
      return;
    }
    if (!reason) {
      problems.push(`gaps[${index}].reason must say why the evidence does not settle it.`);
      return;
    }
    out.push({ requiredContent: n, reason });
  });
  return out;
}

function stringList(value: unknown, where: string, max: number, problems: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${where} must be an array of strings.`);
    return [];
  }
  const out: string[] = [];
  value.forEach((one, index) => {
    const text = str(one, max);
    if (!text) problems.push(`${where}[${index}] must be a non-empty string of at most ${max} characters.`);
    else out.push(text);
  });
  return out;
}

function parseCitedText(
  value: unknown,
  where: string,
  problems: string[],
): CitedText | null {
  if (!isObject(value)) {
    problems.push(`${where} is not an object with "text" and "cites".`);
    return null;
  }
  const extra = extraKeys(value, ['text', 'cites', 'framing']);
  if (extra.length) problems.push(`${where} carries field(s) this contract does not define: ${extra.join(', ')}.`);
  const text = str(value['text'], CONTENT_LIMITS.paragraph);
  if (!text) {
    problems.push(`${where}.text must be non-empty and at most ${CONTENT_LIMITS.paragraph} characters.`);
    return null;
  }
  const framing = value['framing'] === true;
  return { text, cites: citesOf(value['cites'], where, problems), ...(framing ? { framing } : {}) };
}

function parseWritten(body: Record<string, unknown>, spec: DeliverableSpec, problems: string[]): WrittenContent | null {
  const extra = extraKeys(body, ['title', 'subtitle', 'summary', 'sections', 'gaps', 'limitations']);
  if (extra.length) problems.push(`The submission carries field(s) this contract does not define: ${extra.join(', ')}.`);
  const title = str(body['title'], CONTENT_LIMITS.title);
  if (!title) problems.push('"title" must be a non-empty string.');
  const subtitle = body['subtitle'] === undefined || body['subtitle'] === null ? null : str(body['subtitle'], CONTENT_LIMITS.title);

  const summaryRaw = body['summary'];
  const summary: CitedText[] = [];
  if (!Array.isArray(summaryRaw) || summaryRaw.length === 0) {
    problems.push('"summary" must be a non-empty array of {text, cites} paragraphs — what the reader needs first.');
  } else {
    summaryRaw.forEach((one, index) => {
      const parsed = parseCitedText(one, `summary[${index}]`, problems);
      if (parsed) summary.push(parsed);
    });
  }

  const sectionsRaw = body['sections'];
  const sections: WrittenSection[] = [];
  if (!Array.isArray(sectionsRaw) || sectionsRaw.length === 0) {
    problems.push('"sections" must be a non-empty array.');
  } else if (sectionsRaw.length > CONTENT_LIMITS.sections) {
    problems.push(`At most ${CONTENT_LIMITS.sections} sections.`);
  } else {
    sectionsRaw.forEach((raw, s) => {
      const where = `sections[${s}]`;
      if (!isObject(raw)) {
        problems.push(`${where} is not an object.`);
        return;
      }
      const ex = extraKeys(raw, ['heading', 'covers', 'blocks']);
      if (ex.length) problems.push(`${where} carries field(s) this contract does not define: ${ex.join(', ')}.`);
      const heading = str(raw['heading'], CONTENT_LIMITS.heading);
      if (!heading) problems.push(`${where}.heading must be a non-empty string.`);
      const covers = coversOf(raw['covers'], where, spec.requiredContents.length, problems);
      const blocksRaw = raw['blocks'];
      const blocks: WrittenBlock[] = [];
      if (!Array.isArray(blocksRaw) || blocksRaw.length === 0) {
        problems.push(`${where}.blocks must be a non-empty array.`);
      } else if (blocksRaw.length > CONTENT_LIMITS.blocksPerSection) {
        problems.push(`${where} has more than ${CONTENT_LIMITS.blocksPerSection} blocks.`);
      } else {
        blocksRaw.forEach((block, b) => {
          const at = `${where}.blocks[${b}]`;
          if (!isObject(block)) {
            problems.push(`${at} is not an object.`);
            return;
          }
          const type = block['type'];
          if (type === 'paragraph') {
            const ex2 = extraKeys(block, ['type', 'text', 'cites', 'framing']);
            if (ex2.length) problems.push(`${at} carries field(s) this contract does not define: ${ex2.join(', ')}.`);
            const text = str(block['text'], CONTENT_LIMITS.paragraph);
            if (!text) problems.push(`${at}.text must be non-empty and at most ${CONTENT_LIMITS.paragraph} characters.`);
            else blocks.push({ type: 'paragraph', text, cites: citesOf(block['cites'], at, problems), ...(block['framing'] === true ? { framing: true } : {}) });
          } else if (type === 'bullets') {
            const ex2 = extraKeys(block, ['type', 'items']);
            if (ex2.length) problems.push(`${at} carries field(s) this contract does not define: ${ex2.join(', ')}.`);
            const items = block['items'];
            if (!Array.isArray(items) || items.length === 0) {
              problems.push(`${at}.items must be a non-empty array of {text, cites}.`);
            } else {
              const parsed = items
                .map((item, i) => parseCitedText(item, `${at}.items[${i}]`, problems))
                .filter((one): one is CitedText => one !== null);
              blocks.push({ type: 'bullets', items: parsed });
            }
          } else if (type === 'table') {
            const ex2 = extraKeys(block, ['type', 'columns', 'rows', 'cites']);
            if (ex2.length) problems.push(`${at} carries field(s) this contract does not define: ${ex2.join(', ')}.`);
            const columns = block['columns'];
            const rows = block['rows'];
            if (!Array.isArray(columns) || columns.length === 0 || columns.some((c) => typeof c !== 'string' || !c.trim())) {
              problems.push(`${at}.columns must be a non-empty array of strings.`);
              return;
            }
            if (!Array.isArray(rows) || rows.length === 0) {
              problems.push(`${at}.rows must be a non-empty array of string arrays.`);
              return;
            }
            const clean: string[][] = [];
            rows.forEach((row, r) => {
              if (!Array.isArray(row) || row.length !== columns.length || row.some((c) => typeof c !== 'string' || c.length > CONTENT_LIMITS.cell)) {
                problems.push(`${at}.rows[${r}] must be ${columns.length} strings, one per column.`);
              } else clean.push((row as string[]).map((c) => c.trim()));
            });
            blocks.push({
              type: 'table',
              columns: (columns as string[]).map((c) => c.trim()),
              rows: clean,
              cites: citesOf(block['cites'], at, problems),
            });
          } else {
            problems.push(`${at}.type is ${JSON.stringify(type)}; it must be "paragraph", "bullets" or "table".`);
          }
        });
      }
      if (heading) sections.push({ heading, covers, blocks });
    });
  }

  const gaps = gapsOf(body['gaps'], spec.requiredContents.length, problems);
  const limitations = stringList(body['limitations'], 'limitations', CONTENT_LIMITS.limitation, problems);
  if (!title) return null;
  return { title, subtitle, summary, sections, gaps, limitations };
}

function parseStructured(body: Record<string, unknown>, spec: DeliverableSpec, problems: string[]): StructuredContent | null {
  const extra = extraKeys(body, ['title', 'description', 'sheets', 'gaps', 'notes']);
  if (extra.length) problems.push(`The submission carries field(s) this contract does not define: ${extra.join(', ')}.`);
  const title = str(body['title'], CONTENT_LIMITS.title);
  if (!title) problems.push('"title" must be a non-empty string.');
  const description = str(body['description'], CONTENT_LIMITS.paragraph);
  if (!description) problems.push('"description" must say what the workbook contains and how to use it.');

  const sheetsRaw = body['sheets'];
  const sheets: Sheet[] = [];
  if (!Array.isArray(sheetsRaw) || sheetsRaw.length === 0) {
    problems.push('"sheets" must be a non-empty array.');
  } else if (sheetsRaw.length > CONTENT_LIMITS.sheets) {
    problems.push(`At most ${CONTENT_LIMITS.sheets} data sheets.`);
  } else {
    const names = new Set<string>();
    sheetsRaw.forEach((raw, s) => {
      const where = `sheets[${s}]`;
      if (!isObject(raw)) {
        problems.push(`${where} is not an object.`);
        return;
      }
      const ex = extraKeys(raw, ['name', 'covers', 'columns', 'rows', 'totals']);
      if (ex.length) problems.push(`${where} carries field(s) this contract does not define: ${ex.join(', ')}.`);
      const name = str(raw['name'], CONTENT_LIMITS.sheetName);
      if (!name || /[\\/?*[\]:]/.test(name)) {
        problems.push(`${where}.name must be 1-${CONTENT_LIMITS.sheetName} characters with none of \\ / ? * [ ] :.`);
        return;
      }
      if (['sources', 'about'].includes(name.toLowerCase()) || names.has(name.toLowerCase())) {
        problems.push(`${where}.name "${name}" is taken (Brain adds "About" and "Sources" itself; names must be unique).`);
        return;
      }
      names.add(name.toLowerCase());
      const covers = coversOf(raw['covers'], where, spec.requiredContents.length, problems);
      const columnsRaw = raw['columns'];
      const columns: SheetColumn[] = [];
      if (!Array.isArray(columnsRaw) || columnsRaw.length === 0 || columnsRaw.length > CONTENT_LIMITS.columns) {
        problems.push(`${where}.columns must be 1-${CONTENT_LIMITS.columns} {key, label, type} objects.`);
        return;
      }
      const keys = new Set<string>();
      columnsRaw.forEach((col, c) => {
        if (!isObject(col)) {
          problems.push(`${where}.columns[${c}] is not an object.`);
          return;
        }
        const key = str(col['key'], 60);
        const label = str(col['label'], 120);
        const type = col['type'];
        if (!key || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || keys.has(key)) {
          problems.push(`${where}.columns[${c}].key must be a unique identifier.`);
          return;
        }
        if (key === 'sources') {
          problems.push(`${where}.columns[${c}].key "sources" is reserved; Brain adds the sources column itself.`);
          return;
        }
        if (!label) problems.push(`${where}.columns[${c}].label must be a non-empty string.`);
        if (typeof type !== 'string' || !(COLUMN_TYPES as readonly string[]).includes(type)) {
          problems.push(`${where}.columns[${c}].type must be one of ${COLUMN_TYPES.join(', ')}.`);
          return;
        }
        keys.add(key);
        columns.push({ key, label: label ?? key, type: type as ColumnType });
      });

      const rowsRaw = raw['rows'];
      const rows: SheetRow[] = [];
      if (!Array.isArray(rowsRaw) || rowsRaw.length === 0 || rowsRaw.length > CONTENT_LIMITS.rowsPerSheet) {
        problems.push(`${where}.rows must be 1-${CONTENT_LIMITS.rowsPerSheet} {values, cites} objects.`);
      } else {
        rowsRaw.forEach((row, r) => {
          const at = `${where}.rows[${r}]`;
          if (!isObject(row) || !isObject(row['values'])) {
            problems.push(`${at} must be {values: {columnKey: value}, cites: [claimId]}.`);
            return;
          }
          const ex2 = extraKeys(row, ['values', 'cites']);
          if (ex2.length) problems.push(`${at} carries field(s) this contract does not define: ${ex2.join(', ')}.`);
          const values: Record<string, CellValue> = {};
          const given = row['values'] as Record<string, unknown>;
          for (const key of Object.keys(given)) {
            if (!keys.has(key)) problems.push(`${at}.values.${key} is not a declared column.`);
          }
          for (const col of columns) {
            const v = given[col.key];
            if (v === undefined || v === null || v === '') {
              values[col.key] = null;
            } else if (col.type === 'number' || col.type === 'currency' || col.type === 'percent') {
              if (typeof v !== 'number' || !Number.isFinite(v)) {
                problems.push(`${at}.values.${col.key} must be a number (column type ${col.type}), or null when unknown.`);
              } else values[col.key] = v;
            } else if (typeof v !== 'string' || v.length > CONTENT_LIMITS.cell) {
              problems.push(`${at}.values.${col.key} must be a string of at most ${CONTENT_LIMITS.cell} characters.`);
            } else {
              values[col.key] = v.trim();
            }
          }
          rows.push({ values, cites: citesOf(row['cites'], at, problems) });
        });
      }

      const totalsRaw = raw['totals'];
      const totals: Sheet['totals'] = [];
      if (totalsRaw !== undefined) {
        if (!Array.isArray(totalsRaw)) problems.push(`${where}.totals must be an array.`);
        else
          totalsRaw.forEach((t, i) => {
            if (!isObject(t)) {
              problems.push(`${where}.totals[${i}] is not an object.`);
              return;
            }
            const column = t['column'];
            const fn = t['function'];
            const col = columns.find((one) => one.key === column);
            if (!col) {
              problems.push(`${where}.totals[${i}].column must name a declared column.`);
              return;
            }
            if (typeof fn !== 'string' || !(TOTAL_FUNCTIONS as readonly string[]).includes(fn)) {
              problems.push(`${where}.totals[${i}].function must be one of ${TOTAL_FUNCTIONS.join(', ')}.`);
              return;
            }
            if (fn !== 'COUNT' && col.type !== 'number' && col.type !== 'currency' && col.type !== 'percent') {
              problems.push(`${where}.totals[${i}] applies ${fn} to a ${col.type} column; only COUNT works on that.`);
              return;
            }
            if (totals.some((one) => one.column === col.key)) {
              problems.push(`${where}.totals[${i}] is a second total on "${col.key}"; a totals row has one cell per column.`);
              return;
            }
            totals.push({ column: col.key, function: fn as TotalFunction });
          });
      }
      sheets.push({ name, covers, columns, rows, totals });
    });
  }
  const gaps = gapsOf(body['gaps'], spec.requiredContents.length, problems);
  const notes = stringList(body['notes'], 'notes', CONTENT_LIMITS.limitation, problems);
  if (!title || !description) return null;
  return { title, description, sheets, gaps, notes };
}

/* =========================================================================
 * The rules that need the archive
 * ====================================================================== */

interface CitedPiece {
  where: string;
  text: string;
  cites: string[];
  framing: boolean;
}

function writtenPieces(content: WrittenContent): CitedPiece[] {
  const pieces: CitedPiece[] = [];
  content.summary.forEach((one, i) =>
    pieces.push({ where: `summary[${i}]`, text: one.text, cites: one.cites, framing: one.framing === true }),
  );
  content.sections.forEach((section, s) =>
    section.blocks.forEach((block, b) => {
      const at = `sections[${s}].blocks[${b}]`;
      if (block.type === 'paragraph') {
        pieces.push({ where: at, text: block.text, cites: block.cites, framing: block.framing === true });
      } else if (block.type === 'bullets') {
        block.items.forEach((item, i) =>
          pieces.push({ where: `${at}.items[${i}]`, text: item.text, cites: item.cites, framing: item.framing === true }),
        );
      } else {
        pieces.push({
          where: at,
          text: [block.columns.join(' '), ...block.rows.map((row) => row.join(' '))].join(' '),
          cites: block.cites,
          framing: false,
        });
      }
    }),
  );
  return pieces;
}

function structuredPieces(content: StructuredContent): CitedPiece[] {
  const pieces: CitedPiece[] = [];
  content.sheets.forEach((sheet, s) =>
    sheet.rows.forEach((row, r) => {
      const text = sheet.columns
        .map((col) => {
          const v = row.values[col.key];
          if (v === null || v === undefined) return '';
          // A URL is an address, and the digits in one are not figures.
          if (col.type === 'url') return '';
          return String(v);
        })
        .join(' ');
      pieces.push({ where: `sheets[${s}].rows[${r}]`, text, cites: row.cites, framing: false });
    }),
  );
  return pieces;
}

/** Strip URLs so the digits inside an address are never read as figures. */
function withoutUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, ' ');
}

/**
 * Validate a submission against the spec and against the archive.
 *
 * `resolve` answers which of the cited ids are citable claims of the
 * deliverable's own project right now; an id it does not return is refused,
 * whatever the submission says about it.
 */
export async function validateContent(input: {
  raw: string;
  kind: DeliverableKind;
  spec: DeliverableSpec;
  resolve: ClaimResolver;
}): Promise<ContentResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    return { ok: false, problems: ['The submission was not valid JSON.'] };
  }
  if (!isObject(parsed)) return { ok: false, problems: ['The submission was not a structured object.'] };

  const problems: string[] = [];
  const value: DeliverableContent | null =
    input.kind === 'WRITTEN'
      ? (() => {
          const c = parseWritten(parsed, input.spec, problems);
          return c ? { kind: 'WRITTEN' as const, content: c } : null;
        })()
      : (() => {
          const c = parseStructured(parsed, input.spec, problems);
          return c ? { kind: 'STRUCTURED' as const, content: c } : null;
        })();
  if (!value || problems.length > 0) return { ok: false, problems: problems.length ? problems : ['The submission could not be read.'] };

  const pieces = value.kind === 'WRITTEN' ? writtenPieces(value.content) : structuredPieces(value.content);
  const cited = [...new Set(pieces.flatMap((one) => one.cites))];
  if (cited.length === 0) {
    return { ok: false, problems: ['Nothing in the submission cites a claim. A deliverable Brain delivers is source-backed.'] };
  }
  const claims = await input.resolve(cited);
  const unknown = cited.filter((id) => !claims.has(id));
  if (unknown.length > 0) {
    problems.push(
      `These cited ids are not citable claims of this project: ${unknown.slice(0, 12).join(', ')}` +
        `${unknown.length > 12 ? ` and ${unknown.length - 12} more` : ''}. Cite only ids from the evidence in the manifest.`,
    );
  }

  for (const piece of pieces) {
    if (piece.cites.length === 0) {
      if (!piece.framing) {
        problems.push(`${piece.where} cites nothing. Cite the claims it rests on, or mark it "framing": true if it states no fact.`);
        continue;
      }
      const figures = numbersIn(withoutUrls(piece.text)).filter(needsSource);
      if (figures.length > 0) {
        problems.push(`${piece.where} is framing but states figure(s) ${figures.join(', ')}; a figure needs a citation.`);
      }
      continue;
    }
    const mine = piece.cites.map((id) => claims.get(id)).filter((one): one is EvidenceClaim => Boolean(one));
    if (mine.length === 0) continue;
    const supported = claimNumbers(mine);
    const untraced = [...new Set(numbersIn(withoutUrls(piece.text)).filter(needsSource))].filter((n) => !supported.has(n));
    if (untraced.length > 0) {
      problems.push(
        `${piece.where} states ${untraced.join(', ')}, which none of its cited claims (${piece.cites.join(', ')}) states. ` +
          'Every figure must appear in a cited claim, its passage or its locator.',
      );
    }
  }

  // Coverage.
  const covered = new Set<number>();
  if (value.kind === 'WRITTEN') value.content.sections.forEach((one) => one.covers.forEach((n) => covered.add(n)));
  else value.content.sheets.forEach((one) => one.covers.forEach((n) => covered.add(n)));
  const gapped = new Set(value.content.gaps.map((one) => one.requiredContent));
  input.spec.requiredContents.forEach((required, n) => {
    if (!covered.has(n) && !gapped.has(n)) {
      problems.push(
        `Required content ${n} ("${required.slice(0, 120)}") is neither covered by a ` +
          `${value.kind === 'WRITTEN' ? 'section' : 'sheet'} nor declared in "gaps" with a reason.`,
      );
    }
  });

  // A URL column must hold addresses, because the workbook links them.
  if (value.kind === 'STRUCTURED') {
    value.content.sheets.forEach((sheet, s) =>
      sheet.rows.forEach((row, r) =>
        sheet.columns
          .filter((col) => col.type === 'url')
          .forEach((col) => {
            const v = row.values[col.key];
            if (typeof v === 'string' && !/^https?:\/\/\S+$/.test(v)) {
              problems.push(`sheets[${s}].rows[${r}].values.${col.key} is in a url column and is not an http(s) address.`);
            }
          }),
      ),
    );
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value, citedClaimIds: cited, claims };
}
