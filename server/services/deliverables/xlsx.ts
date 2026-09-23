/**
 * A structured deliverable, rendered as an Excel workbook Brain wrote itself.
 *
 * Three kinds of sheet, and only one of them is the worker's:
 *
 *  - **About**, first, says what the workbook is for, who it is for, which
 *    version this is, and every gap, note and unmet need — so the limitations
 *    travel inside the file rather than in a message somebody may not keep.
 *  - **The data sheets** the worker specified. Every row ends with a Sources
 *    cell naming the claim ids it rests on, and a totals row is a real formula
 *    (`SUM`, `AVERAGE`, …) with Brain's computed value cached beside it, so the
 *    file reads correctly before a spreadsheet recalculates and the native check
 *    can confirm the formula and the value agree.
 *  - **Sources**, last, one row per cited claim: the statement, the publisher,
 *    the date, a live link and the passage.
 *
 * Deterministic for a given content, version and claim set.
 */
import type { DeliverableSpec } from '../../domain/deliverables.ts';
import type { CellValue, EvidenceClaim, Sheet, StructuredContent, TotalFunction } from './content.ts';
import { safeFilename, type RenderMeta, type RenderedFile } from './docx.ts';
import { writeZip, xml } from './zip.ts';

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Style indexes into `cellXfs` below. */
const STYLE = { plain: 0, header: 1, currency: 2, percent: 3, wrap: 4, totalCurrency: 5, totalNumber: 6, bold: 7, number: 8, totalPercent: 9 } as const;

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** What a totals formula evaluates to, by the semantics a spreadsheet uses. */
export function evaluateTotal(fn: TotalFunction | 'COUNTA', values: readonly CellValue[]): number | 'DIV0' {
  const numbers = values.filter((v): v is number => typeof v === 'number');
  switch (fn) {
    case 'SUM':
      return round(numbers.reduce((a, b) => a + b, 0));
    case 'COUNT':
      return numbers.length;
    case 'COUNTA':
      return values.filter((v) => v !== null && v !== '').length;
    case 'AVERAGE':
      return numbers.length === 0 ? 'DIV0' : round(numbers.reduce((a, b) => a + b, 0) / numbers.length);
    case 'MIN':
      return numbers.length === 0 ? 0 : Math.min(...numbers);
    case 'MAX':
      return numbers.length === 0 ? 0 : Math.max(...numbers);
  }
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** The formula a totals row writes, given whether the column holds numbers. */
export function formulaFunction(fn: TotalFunction, numeric: boolean): TotalFunction | 'COUNTA' {
  return fn === 'COUNT' && !numeric ? 'COUNTA' : fn;
}

function textCell(ref: string, text: string, style: number = STYLE.plain): string {
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

function numberCell(ref: string, value: number, style: number = STYLE.number): string {
  return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`;
}

interface SheetXml {
  name: string;
  xml: string;
  rels: string | null;
}

function worksheet(rows: string[], opts: { widths: number[]; freezeHeader: boolean; filterRef: string | null; hyperlinks: Array<{ ref: string; target: string }> }): { xml: string; rels: string | null } {
  const cols = opts.widths.length
    ? `<cols>${opts.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const views = opts.freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const links = opts.hyperlinks.length
    ? `<hyperlinks>${opts.hyperlinks.map((h, i) => `<hyperlink ref="${h.ref}" r:id="rIdL${i + 1}"/>`).join('')}</hyperlinks>`
    : '';
  const sheetXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `${views}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows.join('')}</sheetData>` +
    `${opts.filterRef ? `<autoFilter ref="${opts.filterRef}"/>` : ''}${links}</worksheet>`;
  const rels = opts.hyperlinks.length
    ? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      opts.hyperlinks
        .map(
          (h, i) =>
            `<Relationship Id="rIdL${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(h.target)}" TargetMode="External"/>`,
        )
        .join('') +
      '</Relationships>'
    : null;
  return { xml: sheetXml, rels };
}

function dataSheet(sheet: Sheet): SheetXml {
  const columns = [...sheet.columns, { key: 'sources', label: 'Sources (claim ids)', type: 'text' as const }];
  const rows: string[] = [];
  const hyperlinks: Array<{ ref: string; target: string }> = [];
  rows.push(`<row r="1">${columns.map((col, c) => textCell(`${columnLetter(c)}1`, col.label, STYLE.header)).join('')}</row>`);
  sheet.rows.forEach((row, r) => {
    const n = r + 2;
    const cells: string[] = [];
    sheet.columns.forEach((col, c) => {
      const ref = `${columnLetter(c)}${n}`;
      const v = row.values[col.key];
      if (v === null || v === undefined) return;
      if (typeof v === 'number') {
        cells.push(numberCell(ref, v, col.type === 'currency' ? STYLE.currency : col.type === 'percent' ? STYLE.percent : STYLE.number));
      } else {
        cells.push(textCell(ref, v, v.length > 60 ? STYLE.wrap : STYLE.plain));
        if (col.type === 'url') hyperlinks.push({ ref, target: v });
      }
    });
    cells.push(textCell(`${columnLetter(sheet.columns.length)}${n}`, row.cites.join('; ')));
    rows.push(`<row r="${n}">${cells.join('')}</row>`);
  });
  const lastData = sheet.rows.length + 1;
  if (sheet.totals.length > 0) {
    const n = lastData + 1;
    const cells: string[] = [];
    const totalled = new Map(sheet.totals.map((t) => [t.column, t.function]));
    let labelled = false;
    sheet.columns.forEach((col, c) => {
      const ref = `${columnLetter(c)}${n}`;
      const fn = totalled.get(col.key);
      if (fn) {
        const numeric = col.type === 'number' || col.type === 'currency' || col.type === 'percent';
        const f = formulaFunction(fn, numeric);
        const letter = columnLetter(c);
        const value = evaluateTotal(f, sheet.rows.map((row) => row.values[col.key] ?? null));
        const style = col.type === 'currency' && f !== 'COUNT' && f !== 'COUNTA' ? STYLE.totalCurrency : col.type === 'percent' && f !== 'COUNT' && f !== 'COUNTA' ? STYLE.totalPercent : STYLE.totalNumber;
        cells.push(
          value === 'DIV0'
            ? `<c r="${ref}" s="${style}" t="e"><f>${f}(${letter}2:${letter}${lastData})</f><v>#DIV/0!</v></c>`
            : `<c r="${ref}" s="${style}"><f>${f}(${letter}2:${letter}${lastData})</f><v>${value}</v></c>`,
        );
      } else if (!labelled) {
        cells.push(textCell(ref, `Totals (${sheet.totals.map((t) => t.function).join(', ')})`, STYLE.bold));
        labelled = true;
      }
    });
    rows.push(`<row r="${n}">${cells.join('')}</row>`);
  }
  const widths = columns.map((col) => (col.type === 'url' ? 45 : col.key === 'sources' ? 30 : Math.min(60, Math.max(12, col.label.length + 4))));
  const lastCol = columnLetter(columns.length - 1);
  const built = worksheet(rows, { widths, freezeHeader: true, filterRef: `A1:${lastCol}${lastData}`, hyperlinks });
  return { name: sheet.name, ...built };
}

function aboutSheet(content: StructuredContent, meta: RenderMeta, spec: DeliverableSpec): SheetXml {
  const lines: Array<[string, string]> = [
    ['Title', content.title],
    ['What this is', content.description],
    ['Prepared for', spec.audience],
    ['Purpose', spec.intendedUse],
    ['Project', meta.projectName],
    ['Version', String(meta.versionNumber)],
    ['Generated', `${meta.generatedAt} by Brain from the project's accepted research claims`],
    ['How to read it', 'Every data row ends with the claim ids it rests on; the Sources sheet resolves each id to its publisher, date, link and passage. Totals rows are live formulas.'],
  ];
  spec.requiredContents.forEach((one, i) => lines.push([`Required content ${i}`, one]));
  content.gaps.forEach((gap) =>
    lines.push(['Not settled by the evidence', `"${spec.requiredContents[gap.requiredContent] ?? ''}": ${gap.reason}`]),
  );
  content.notes.forEach((note) => lines.push(['Note', note]));
  meta.unmetNeeds.forEach((need) => lines.push(['Limitation', need]));
  const rows = lines.map(
    ([k, v], i) => `<row r="${i + 1}">${textCell(`A${i + 1}`, k, STYLE.bold)}${textCell(`B${i + 1}`, v, STYLE.wrap)}</row>`,
  );
  return { name: 'About', ...worksheet(rows, { widths: [26, 100], freezeHeader: false, filterRef: null, hyperlinks: [] }) };
}

function sourcesSheet(order: readonly string[], claims: Map<string, EvidenceClaim>): SheetXml {
  const header = ['Claim id', 'Statement', 'Publisher', 'Title', 'Date', 'Link', 'Passage', 'Locator'];
  const rows: string[] = [`<row r="1">${header.map((h, c) => textCell(`${columnLetter(c)}1`, h, STYLE.header)).join('')}</row>`];
  const hyperlinks: Array<{ ref: string; target: string }> = [];
  order.forEach((id, i) => {
    const claim = claims.get(id);
    if (!claim) return;
    const n = i + 2;
    const cells = [claim.id, claim.claim, claim.sourcePublisher ?? '', claim.sourceTitle ?? '', claim.sourceDate ?? '', claim.sourceUrl, (claim.excerpt ?? '').slice(0, 1000), claim.locator ?? ''];
    rows.push(`<row r="${n}">${cells.map((v, c) => (v ? textCell(`${columnLetter(c)}${n}`, v, c === 1 || c === 6 ? STYLE.wrap : STYLE.plain) : '')).join('')}</row>`);
    hyperlinks.push({ ref: `F${n}`, target: claim.sourceUrl });
  });
  return {
    name: 'Sources',
    ...worksheet(rows, { widths: [26, 70, 24, 30, 12, 45, 70, 20], freezeHeader: true, filterRef: `A1:H${order.length + 1}`, hyperlinks }),
  };
}

export function renderXlsx(content: StructuredContent, claims: Map<string, EvidenceClaim>, meta: RenderMeta): RenderedFile {
  const order: string[] = [];
  for (const sheet of content.sheets) for (const row of sheet.rows) for (const id of row.cites) if (!order.includes(id)) order.push(id);

  const sheets: SheetXml[] = [aboutSheet(content, meta, meta.spec), ...content.sheets.map(dataSheet), sourcesSheet(order, claims)];

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView activeTab="1"/></bookViews><sheets>' +
    sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rIdS${i + 1}"/>`).join('') +
    '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_s, i) =>
          `<Relationship Id="rIdS${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.0&quot;%&quot;"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF4"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="10">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
    '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets
      .map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>';

  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xml(content.title)}</dc:title><dc:creator>Brain</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${xml(meta.generatedAt.replace(/\.\d+Z$/, 'Z'))}</dcterms:created>` +
    '</cp:coreProperties>';

  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rootRels) },
    { name: 'docProps/core.xml', data: Buffer.from(core) },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels) },
    { name: 'xl/styles.xml', data: Buffer.from(styles) },
  ];
  sheets.forEach((sheet, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheet.xml) });
    if (sheet.rels) entries.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: Buffer.from(sheet.rels) });
  });

  return {
    bytes: writeZip(entries),
    filename: safeFilename(content.title, meta.versionNumber, 'xlsx'),
    contentType: XLSX_CONTENT_TYPE,
    referenceOrder: order,
  };
}
