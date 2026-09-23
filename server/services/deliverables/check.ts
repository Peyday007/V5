/**
 * Open the file Brain wrote, with readers that did not write it, and check it.
 *
 * "It rendered" is a claim about the renderer. What this establishes is a set
 * of facts about the *bytes*: that a ZIP reader opens them, that every XML part
 * is well formed, that a Word reader (`mammoth`) turns the document into pages
 * whose headings, paragraphs, tables and sources are all there, that every
 * citation number resolves to a claim that is still citable now and whose link
 * is the one in the file — and, for a workbook, that every cell read back is
 * the value that was specified and every formula's cached value is what the
 * formula actually computes over the cells it names.
 *
 * Each result is a `CheckItem` with a severity, so a failure becomes a finding
 * the repair loop can act on rather than a sentence in a log. The rendered view
 * it produces (`previewHtml`) is stored beside the file, and it is what the
 * independent reviewer reads — so the reviewer judges the pages a person will
 * see rather than the content the worker meant.
 *
 * This runs in the deployed Brain, which has no office suite and no browser.
 * Reading the pages through mammoth and recomputing the formulas here are the
 * native checks available there; nothing about them is simulated.
 */
import JSZip from 'jszip';
import type { CheckItem, CheckReport, DeliverableSpec, FindingSeverity } from '../../domain/deliverables.ts';
import type { DeliverableContent, EvidenceClaim, StructuredContent, WrittenContent } from './content.ts';
import { columnLetter, evaluateTotal, formulaFunction } from './xlsx.ts';

export interface CheckInput {
  bytes: Buffer;
  content: DeliverableContent;
  claims: Map<string, EvidenceClaim>;
  referenceOrder: readonly string[];
  spec: DeliverableSpec;
  unmetNeeds: readonly string[];
}

export interface CheckOutcome {
  report: CheckReport;
  previewHtml: string;
  passed: boolean;
}

function item(code: string, passed: boolean, severity: FindingSeverity, detail: string): CheckItem {
  return { code, passed, severity, detail };
}

/** Normalise text so a comparison survives whitespace and quote rendering. */
export function norm(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * A structural well-formedness check: every element that opens, closes, in
 * order. Not a validating parser — it asks the one question a reader fails on
 * first, and it is independent of the writer.
 */
export function wellFormed(source: string): string | null {
  const body = source.replace(/^<\?xml[^>]*\?>/, '');
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  let last = 0;
  while ((match = tag.exec(body)) !== null) {
    const between = body.slice(last, match.index);
    if (/[<>]/.test(between)) return 'a stray angle bracket between elements';
    last = tag.lastIndex;
    const [, closing, name, , selfClosing] = match;
    if (selfClosing) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) return `</${name}> closes <${open ?? 'nothing'}>`;
    } else stack.push(name!);
  }
  if (stack.length) return `<${stack[stack.length - 1]}> is never closed`;
  return null;
}

async function openZip(bytes: Buffer, items: CheckItem[]): Promise<JSZip | null> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    items.push(item('OPENS_AS_PACKAGE', true, 'BLOCKER', `A ZIP reader opened it: ${Object.keys(zip.files).length} parts.`));
    return zip;
  } catch (error) {
    items.push(item('OPENS_AS_PACKAGE', false, 'BLOCKER', `A ZIP reader could not open it: ${error instanceof Error ? error.message : String(error)}`));
    return null;
  }
}

async function checkXmlParts(zip: JSZip, required: readonly string[], items: CheckItem[]): Promise<Map<string, string>> {
  const parts = new Map<string, string>();
  const missing = required.filter((name) => !zip.file(name));
  items.push(
    item('PARTS_PRESENT', missing.length === 0, 'BLOCKER', missing.length ? `Missing part(s): ${missing.join(', ')}.` : `All ${required.length} required parts are present.`),
  );
  const broken: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const text = await zip.file(name)!.async('string');
    parts.set(name, text);
    const problem = wellFormed(text);
    if (problem) broken.push(`${name}: ${problem}`);
  }
  items.push(item('XML_WELL_FORMED', broken.length === 0, 'BLOCKER', broken.length ? broken.join('; ') : `${parts.size} XML parts are well formed.`));
  return parts;
}

/* =========================================================================
 * Written
 * ====================================================================== */

async function checkDocx(input: CheckInput, content: WrittenContent, items: CheckItem[], measures: Record<string, number>): Promise<string> {
  const zip = await openZip(input.bytes, items);
  if (!zip) return '';
  const parts = await checkXmlParts(zip, ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels'], items);

  type Mammoth = {
    convertToHtml: (i: { buffer: Buffer }, o?: { styleMap: string[] }) => Promise<{ value: string; messages: Array<{ type: string; message: string }> }>;
    extractRawText: (i: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  let html = '';
  let raw = '';
  try {
    const loaded = (await import('mammoth')) as unknown as Partial<Mammoth> & { default?: Mammoth };
    const reader: Mammoth = typeof loaded.convertToHtml === 'function' ? (loaded as Mammoth) : loaded.default!;
    const converted = await reader.convertToHtml(
      { buffer: input.bytes },
      {
        // The document's own named styles, told to the reader so a title does
        // not read as a heading and an unknown style is not reported as lost.
        styleMap: [
          "p[style-name='Title'] => p.title:fresh",
          "p[style-name='Subtitle'] => p.subtitle:fresh",
          "p[style-name='Source'] => p.source:fresh",
        ],
      },
    );
    html = converted.value;
    raw = (await reader.extractRawText({ buffer: input.bytes })).value;
    const warnings = converted.messages.filter((m) => m.type === 'warning' || m.type === 'error');
    measures['readerWarnings'] = warnings.length;
    items.push(
      item('OPENS_IN_WORD_READER', html.length > 0, 'BLOCKER', `mammoth rendered ${html.length} characters of HTML${warnings.length ? ` with ${warnings.length} warning(s): ${warnings.slice(0, 3).map((w) => w.message).join('; ')}` : ' with no warnings'}.`),
    );
  } catch (error) {
    items.push(item('OPENS_IN_WORD_READER', false, 'BLOCKER', `mammoth could not read it: ${error instanceof Error ? error.message : String(error)}`));
    return '';
  }
  const text = norm(raw);
  const headings = [...html.matchAll(/<h1>(.*?)<\/h1>/g)].map((m) => norm(unescapeXml(m[1]!.replace(/<[^>]+>/g, ''))));
  const expected = ['summary', ...content.sections.map((s) => norm(s.heading)), 'sources'];
  const missingHeadings = expected.filter((h) => !headings.includes(h));
  items.push(
    item('SECTIONS_RENDERED', missingHeadings.length === 0, 'BLOCKER', missingHeadings.length ? `Heading(s) not rendered as headings: ${missingHeadings.join(', ')}.` : `${headings.length} headings rendered, including every section.`),
  );
  items.push(item('TITLE_RENDERED', text.includes(norm(content.title)), 'MAJOR', `The title ${text.includes(norm(content.title)) ? 'is' : 'is not'} on the first page.`));

  const pieces: string[] = [
    ...content.summary.map((p) => p.text),
    ...content.sections.flatMap((s) =>
      s.blocks.flatMap((b) => (b.type === 'paragraph' ? [b.text] : b.type === 'bullets' ? b.items.map((i) => i.text) : b.rows.flat().filter(Boolean))),
    ),
  ];
  const lost = pieces.filter((p) => !text.includes(norm(p)));
  items.push(item('TEXT_COMPLETE', lost.length === 0, 'BLOCKER', lost.length ? `${lost.length} passage(s) are not in the rendered text, e.g. "${lost[0]!.slice(0, 80)}".` : `All ${pieces.length} passages and table cells are in the rendered text.`));

  const tables = content.sections.flatMap((s) => s.blocks).filter((b) => b.type === 'table').length;
  const renderedTables = (html.match(/<table>/g) ?? []).length;
  items.push(item('TABLES_RENDERED', renderedTables === tables, 'MAJOR', `${renderedTables} of ${tables} table(s) rendered as tables.`));

  // Citations.
  const unresolved = input.referenceOrder.filter((id) => !input.claims.has(id));
  const markers = [...raw.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const outOfRange = markers.filter((n) => n < 1 || n > input.referenceOrder.length);
  const neverCited = input.referenceOrder.map((_id, i) => i + 1).filter((n) => !markers.includes(n));
  items.push(
    item(
      'CITATIONS_RESOLVE',
      unresolved.length === 0 && outOfRange.length === 0 && neverCited.length === 0,
      'BLOCKER',
      unresolved.length
        ? `${unresolved.length} cited claim(s) are no longer citable: ${unresolved.join(', ')}.`
        : outOfRange.length
          ? `Reference number(s) with no source: ${[...new Set(outOfRange)].join(', ')}.`
          : neverCited.length
            ? `Source(s) listed but never cited: ${neverCited.join(', ')}.`
            : `${markers.length} citation marks resolve to ${input.referenceOrder.length} sources, each a citable claim now.`,
    ),
  );
  const sourcesListed = input.referenceOrder.filter((id) => text.includes(norm(id))).length;
  items.push(item('SOURCES_LISTED', sourcesListed === input.referenceOrder.length, 'BLOCKER', `${sourcesListed} of ${input.referenceOrder.length} sources are listed with their claim id.`));

  const rels = parts.get('word/_rels/document.xml.rels') ?? '';
  const targets = [...rels.matchAll(/Id="rIdSrc(\d+)"[^>]*Target="([^"]+)"/g)].map((m) => ({ n: Number(m[1]), url: unescapeXml(m[2]!) }));
  const wrong = input.referenceOrder.filter((id, i) => targets.find((t) => t.n === i + 1)?.url !== input.claims.get(id)?.sourceUrl);
  items.push(item('LINKS_MATCH_SOURCES', wrong.length === 0, 'MAJOR', wrong.length ? `${wrong.length} source link(s) do not point at their claim's URL.` : `${targets.length} source links point at their claims' URLs.`));

  const limits = [...content.gaps.map((g) => g.reason), ...content.limitations, ...input.unmetNeeds];
  const dropped = limits.filter((l) => !text.includes(norm(l)));
  items.push(item('LIMITATIONS_CARRIED', dropped.length === 0, 'MAJOR', dropped.length ? `${dropped.length} limitation(s) are not in the file.` : `${limits.length} limitation(s) and gap(s) are stated in the file.`));

  measures['words'] = raw.split(/\s+/).filter(Boolean).length;
  measures['sections'] = content.sections.length;
  measures['sources'] = input.referenceOrder.length;
  measures['citationMarks'] = markers.length;
  measures['tables'] = tables;
  return `<article class="deliverable-preview">${html}</article>`;
}

/* =========================================================================
 * Structured
 * ====================================================================== */

export interface ParsedCell {
  ref: string;
  value: string | number | null;
  formula: string | null;
  error: string | null;
}

/** Read a worksheet's cells back, independently of how they were written. */
export function parseSheetCells(sheetXml: string, shared: readonly string[] = []): Map<string, ParsedCell> {
  const cells = new Map<string, ParsedCell>();
  const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = cellPattern.exec(sheetXml)) !== null) {
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
    const formula = /<f>([\s\S]*?)<\/f>/.exec(inner)?.[1] ?? null;
    const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
    let value: string | number | null = null;
    let error: string | null = null;
    if (type === 'inlineStr') {
      value = unescapeXml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
    } else if (type === 's') {
      value = shared[Number(v)] ?? null;
    } else if (type === 'e') {
      error = v ? unescapeXml(v) : '#ERROR';
    } else if (type === 'str') {
      value = v === undefined ? null : unescapeXml(v);
    } else if (v !== undefined) {
      value = Number(v);
    }
    cells.set(ref, { ref, value, formula: formula ? unescapeXml(formula) : null, error });
  }
  return cells;
}

async function checkXlsx(input: CheckInput, content: StructuredContent, items: CheckItem[], measures: Record<string, number>): Promise<string> {
  const zip = await openZip(input.bytes, items);
  if (!zip) return '';
  const parts = await checkXmlParts(zip, ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml'], items);

  const workbook = parts.get('xl/workbook.xml') ?? '';
  const workbookRels = parts.get('xl/_rels/workbook.xml.rels') ?? '';
  const sheetRefs = [...workbook.matchAll(/<sheet name="([^"]+)" sheetId="\d+" r:id="([^"]+)"\/>/g)].map((m) => ({
    name: unescapeXml(m[1]!),
    target: new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"`).exec(workbookRels)?.[1] ?? '',
  }));
  const expectedNames = ['About', ...content.sheets.map((s) => s.name), 'Sources'];
  const namesMatch = JSON.stringify(sheetRefs.map((s) => s.name)) === JSON.stringify(expectedNames);
  items.push(item('SHEETS_PRESENT', namesMatch, 'BLOCKER', namesMatch ? `Sheets in order: ${expectedNames.join(', ')}.` : `Sheets read back as ${sheetRefs.map((s) => s.name).join(', ')}; expected ${expectedNames.join(', ')}.`));

  const sheetXml = (name: string): string => {
    const ref = sheetRefs.find((s) => s.name === name);
    return ref ? parts.get(`xl/${ref.target.replace(/^\/?xl\//, '')}`) ?? '' : '';
  };

  const preview: string[] = [];
  let mismatches = 0;
  let formulaProblems: string[] = [];
  let formulas = 0;
  let cellCount = 0;
  for (const sheet of content.sheets) {
    const cells = parseSheetCells(sheetXml(sheet.name));
    cellCount += cells.size;
    sheet.rows.forEach((row, r) => {
      sheet.columns.forEach((col, c) => {
        const got = cells.get(`${columnLetter(c)}${r + 2}`)?.value ?? null;
        const want = row.values[col.key] ?? null;
        if (want === null ? got !== null : typeof want === 'number' ? got !== want : got !== want) mismatches += 1;
      });
      const sourcesCell = cells.get(`${columnLetter(sheet.columns.length)}${r + 2}`)?.value;
      if (sourcesCell !== row.cites.join('; ')) mismatches += 1;
    });
    // Formulas: recompute from the cells read back, never from the content.
    const totalsRow = sheet.rows.length + 2;
    sheet.totals.forEach((total) => {
      const c = sheet.columns.findIndex((col) => col.key === total.column);
      const cell = cells.get(`${columnLetter(c)}${totalsRow}`);
      formulas += 1;
      const m = cell?.formula ? /^(SUM|COUNT|COUNTA|AVERAGE|MIN|MAX)\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)$/.exec(cell.formula) : null;
      if (!cell || !m) {
        formulaProblems.push(`${sheet.name}!${columnLetter(c)}${totalsRow} has no readable formula`);
        return;
      }
      const [, fn, fromCol, fromRow, toCol, toRow] = m;
      const col = sheet.columns[c]!;
      const numeric = col.type === 'number' || col.type === 'currency' || col.type === 'percent';
      if (fn !== formulaFunction(total.function, numeric) || fromCol !== toCol || fromCol !== columnLetter(c) || Number(fromRow) !== 2 || Number(toRow) !== totalsRow - 1) {
        formulaProblems.push(`${sheet.name}!${columnLetter(c)}${totalsRow} reads ${cell.formula}, which does not span the column's data rows`);
        return;
      }
      const values: Array<string | number | null> = [];
      for (let n = Number(fromRow); n <= Number(toRow); n += 1) values.push(cells.get(`${fromCol}${n}`)?.value ?? null);
      const computed = evaluateTotal(fn as 'SUM', values);
      const cached = cell.error ? 'DIV0' : cell.value;
      const agrees = computed === 'DIV0' ? cell.error === '#DIV/0!' : typeof cached === 'number' && Math.abs(cached - computed) < 1e-6;
      if (!agrees) formulaProblems.push(`${sheet.name}!${columnLetter(c)}${totalsRow}: ${cell.formula} computes ${computed} but the file shows ${String(cached)}`);
    });

    // Preview: the calculated cells as a person would see them.
    const head = [...sheet.columns.map((c) => c.label), 'Sources'];
    const body = sheet.rows.map((_row, r) =>
      head.map((_h, c) => {
        const v = cells.get(`${columnLetter(c)}${r + 2}`)?.value;
        return v === null || v === undefined ? '' : String(v);
      }),
    );
    if (sheet.totals.length) {
      body.push(head.map((_h, c) => {
        const cell = cells.get(`${columnLetter(c)}${totalsRow}`);
        return cell ? (cell.error ?? String(cell.value ?? '')) : '';
      }));
    }
    preview.push(
      `<h2>${escapeHtml(sheet.name)}</h2><table><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>` +
        `<tbody>${body.map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
    );
  }
  items.push(item('CELLS_MATCH', mismatches === 0, 'BLOCKER', mismatches ? `${mismatches} cell(s) read back differently from what was specified.` : `Every data cell and sources cell reads back as specified (${cellCount} cells).`));
  items.push(item('FORMULAS_CALCULATE', formulaProblems.length === 0, 'BLOCKER', formulaProblems.length ? formulaProblems.join('; ') : `${formulas} formula(s) recomputed from the cells they name and agree with the values shown.`));

  // Sources.
  const sources = parseSheetCells(sheetXml('Sources'));
  const unresolved = input.referenceOrder.filter((id) => !input.claims.has(id));
  const listed = input.referenceOrder.filter((id, i) => sources.get(`A${i + 2}`)?.value === id && sources.get(`F${i + 2}`)?.value === input.claims.get(id)?.sourceUrl);
  items.push(
    item('CITATIONS_RESOLVE', unresolved.length === 0 && listed.length === input.referenceOrder.length, 'BLOCKER',
      unresolved.length ? `${unresolved.length} cited claim(s) are no longer citable: ${unresolved.join(', ')}.` : `${listed.length} of ${input.referenceOrder.length} cited claims are on the Sources sheet with their URL, each citable now.`),
  );
  const sourcesIndex = sheetRefs.findIndex((s) => s.name === 'Sources');
  const sourceRels = parts.get(`xl/worksheets/_rels/sheet${sourcesIndex + 1}.xml.rels`) ?? '';
  const linkTargets = [...sourceRels.matchAll(/Target="([^"]+)"/g)].map((m) => unescapeXml(m[1]!));
  const linksOk = input.referenceOrder.every((id, i) => linkTargets[i] === input.claims.get(id)?.sourceUrl);
  items.push(item('LINKS_MATCH_SOURCES', linksOk, 'MAJOR', linksOk ? `${linkTargets.length} source links point at their claims' URLs.` : 'The Sources sheet links do not match the claims.'));

  const about = parseSheetCells(sheetXml('About'));
  const aboutText = norm([...about.values()].map((c) => String(c.value ?? '')).join(' '));
  const limits = [...content.gaps.map((g) => g.reason), ...content.notes, ...input.unmetNeeds];
  const dropped = limits.filter((l) => !aboutText.includes(norm(l)));
  items.push(item('LIMITATIONS_CARRIED', dropped.length === 0, 'MAJOR', dropped.length ? `${dropped.length} limitation(s) are not on the About sheet.` : `${limits.length} limitation(s), gap(s) and note(s) are on the About sheet.`));

  measures['sheets'] = content.sheets.length;
  measures['rows'] = content.sheets.reduce((n, s) => n + s.rows.length, 0);
  measures['formulas'] = formulas;
  measures['sources'] = input.referenceOrder.length;
  return `<article class="deliverable-preview"><h1>${escapeHtml(content.title)}</h1><p>${escapeHtml(content.description)}</p>${preview.join('')}</article>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function checkDeliverable(input: CheckInput): Promise<CheckOutcome> {
  const items: CheckItem[] = [];
  const measures: Record<string, number> = { bytes: input.bytes.length };
  const previewHtml =
    input.content.kind === 'WRITTEN'
      ? await checkDocx(input, input.content.content, items, measures)
      : await checkXlsx(input, input.content.content, items, measures);
  const readers = input.content.kind === 'WRITTEN' ? ['jszip 3.10.1', 'mammoth'] : ['jszip 3.10.1', 'Brain cell reader and formula evaluator'];
  const passed = items.every((one) => one.passed || one.severity === 'MINOR');
  return { report: { readers, items, measures }, previewHtml, passed };
}
