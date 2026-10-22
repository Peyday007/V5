/**
 * Excel workbooks: written from a spreadsheet spec, read back from bytes.
 *
 * The writer computes every formula with `formula.ts` and stores the result as
 * the cell's cached value, and asks Excel to recalculate on open, so the file
 * shows numbers everywhere and is still a live model. The reader handles both
 * Brain's own files and a client's (shared strings, inline strings), and is
 * what `verify.ts` and attachment reading use.
 */
import { colLetters, colIndex, Evaluator, formulaProblem, isError, type FValue, type Workbook } from './formula.ts';
import type { Cell, CellFormat, CellObject, Sheet } from './spec.ts';
import { esc, textOf, unesc, XML_HEAD } from './xml.ts';
import { unzip, zip } from './zip.ts';

interface StyleKey {
  bold: boolean;
  fmt: CellFormat;
  fill: string | null;
  color: string | null;
  align: string | null;
}

const NUMFMT: Record<CellFormat, number> = {
  general: 0,
  integer: 3,
  decimal: 4,
  currency: 164,
  percent: 165,
  date: 166,
  text: 49,
};

function asObject(cell: Cell): CellObject | null {
  if (cell === null) return null;
  if (typeof cell === 'object') return cell;
  return { v: cell };
}

/** Days since 1899-12-30, which is how a spreadsheet stores a date. */
export function dateSerial(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000) + 25569;
}

export interface RenderedWorkbook {
  bytes: Buffer;
  /** Every formula with its computed value, for the verifier and the report. */
  formulas: { sheet: string; ref: string; formula: string; value: FValue }[];
  problems: string[];
}

export function specWorkbook(sheets: readonly Sheet[]): Workbook {
  const byName = new Map(sheets.map((s) => [s.name, s]));
  return {
    sheets: sheets.map((s) => s.name),
    cell(sheet, row, col) {
      const raw = byName.get(sheet)?.rows[row]?.[col];
      const obj = raw === undefined ? null : asObject(raw);
      if (!obj) return undefined;
      if (obj.f !== undefined) return { formula: obj.f };
      let v: FValue = obj.v ?? null;
      if (obj.fmt === 'date' && typeof v === 'string') v = dateSerial(v) ?? v;
      return { value: v };
    },
  };
}

export function renderXlsx(sheets: readonly Sheet[]): RenderedWorkbook {
  const evaluator = new Evaluator(specWorkbook(sheets));
  const problems: string[] = [];
  const formulas: RenderedWorkbook['formulas'] = [];
  const styles: StyleKey[] = [{ bold: false, fmt: 'general', fill: null, color: null, align: null }];
  const styleIndex = (key: StyleKey): number => {
    const found = styles.findIndex((s) => s.bold === key.bold && s.fmt === key.fmt && s.fill === key.fill && s.color === key.color && s.align === key.align);
    if (found >= 0) return found;
    styles.push(key);
    return styles.length - 1;
  };

  const sheetXml = sheets.map((sheet) => {
    const rows: string[] = [];
    sheet.rows.forEach((row, r) => {
      const cells: string[] = [];
      row.forEach((raw, c) => {
        const obj = asObject(raw);
        if (!obj) return;
        const ref = `${colLetters(c)}${r + 1}`;
        const s = styleIndex({
          bold: obj.bold ?? false,
          fmt: obj.fmt ?? 'general',
          fill: obj.fill?.toUpperCase() ?? null,
          color: obj.color?.toUpperCase() ?? null,
          align: obj.align ?? null,
        });
        const sAttr = s ? ` s="${s}"` : '';
        if (obj.f !== undefined) {
          const formula = obj.f.replace(/^=/, '');
          const parseProblem = formulaProblem(formula);
          const value = evaluator.value(sheet.name, r, c);
          formulas.push({ sheet: sheet.name, ref, formula, value });
          if (parseProblem) problems.push(`${sheet.name}!${ref} =${formula} ${parseProblem}.`);
          else if (isError(value)) problems.push(`${sheet.name}!${ref} =${formula} evaluates to ${value.error}.`);
          if (typeof value === 'string') cells.push(`<c r="${ref}"${sAttr} t="str"><f>${esc(formula)}</f><v>${esc(value)}</v></c>`);
          else if (typeof value === 'boolean') cells.push(`<c r="${ref}"${sAttr} t="b"><f>${esc(formula)}</f><v>${value ? 1 : 0}</v></c>`);
          else if (typeof value === 'number') cells.push(`<c r="${ref}"${sAttr}><f>${esc(formula)}</f><v>${value}</v></c>`);
          else cells.push(`<c r="${ref}"${sAttr}><f>${esc(formula)}</f></c>`);
          return;
        }
        let v = obj.v;
        if (obj.fmt === 'date' && typeof v === 'string') v = dateSerial(v) ?? v;
        if (v === undefined || v === null) {
          if (s) cells.push(`<c r="${ref}"${sAttr}/>`);
        } else if (typeof v === 'number') cells.push(`<c r="${ref}"${sAttr}><v>${v}</v></c>`);
        else if (typeof v === 'boolean') cells.push(`<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`);
        else cells.push(`<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`);
      });
      if (cells.length) rows.push(`<row r="${r + 1}">${cells.join('')}</row>`);
    });
    const freeze = sheet.freezeRows
      ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    const cols = sheet.columnWidths?.length
      ? `<cols>${sheet.columnWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
      : '';
    return (
      `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `${freeze}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows.join('')}</sheetData></worksheet>`
    );
  });

  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
  const xfs = styles.map((s) => {
    let fillId = 0;
    if (s.fill) {
      fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${s.fill.slice(1)}"/><bgColor indexed="64"/></patternFill></fill>`);
      fillId = fills.length - 1;
    }
    let fontId = 0;
    if (s.bold || s.color) {
      fonts.push(`<font>${s.bold ? '<b/>' : ''}<sz val="11"/>${s.color ? `<color rgb="FF${s.color.slice(1)}"/>` : ''}<name val="Calibri"/></font>`);
      fontId = fonts.length - 1;
    }
    const numFmtId = NUMFMT[s.fmt];
    const align = s.align ? `<alignment horizontal="${s.align}"/>` : '';
    return `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${align ? ' applyAlignment="1">' + align + '</xf>' : '/>'}`;
  });
  const stylesXml =
    `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    '<numFmts count="3"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="yyyy-mm-dd"/></numFmts>' +
    `<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills>` +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  const workbook =
    `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
    '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
  const workbookRels =
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
  const rootRels =
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';

  const bytes = zip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rootRels) },
    { name: 'docProps/core.xml', data: Buffer.from(coreProps('Workbook')) },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels) },
    { name: 'xl/styles.xml', data: Buffer.from(stylesXml) },
    ...sheetXml.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(xml) })),
  ]);
  return { bytes, formulas, problems };
}

export function coreProps(title: string): string {
  return (
    `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${esc(title)}</dc:title><dc:creator>Brain</dc:creator>` +
    '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>'
  );
}

/* =========================================================================
 * Reading
 * ====================================================================== */

export interface ReadCell {
  value: FValue;
  formula?: string;
}

export interface ReadSheet {
  name: string;
  cells: Map<string, ReadCell>; // "row,col"
  maxRow: number;
  maxCol: number;
}

/** Read every sheet of a workbook. Throws on anything that is not one. */
export function readXlsx(bytes: Buffer): ReadSheet[] {
  const files = unzip(bytes);
  const workbook = files.get('xl/workbook.xml')?.toString('utf8');
  if (!workbook) throw new Error('Not a workbook: xl/workbook.xml is missing.');
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const shared: string[] = [];
  const sst = files.get('xl/sharedStrings.xml')?.toString('utf8');
  if (sst) for (const si of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(`<x>${si[1]}</x>`, 't').join('') || textOf(si[0], 't').join(''));
  const out: ReadSheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = unesc(/name="([^"]*)"/.exec(m[0])?.[1] ?? '');
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? '';
    const path = `xl/${targets.get(rid) ?? ''}`;
    const xml = files.get(path)?.toString('utf8');
    if (!xml) throw new Error(`Sheet ${name} has no part at ${path}.`);
    const cells = new Map<string, ReadCell>();
    let maxRow = -1;
    let maxCol = -1;
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
      if (!ref) continue;
      const row = Number(ref[2]) - 1;
      const col = colIndex(ref[1]!);
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const inner = c[2] ?? '';
      const formula = /<f[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value: FValue = null;
      if (type === 'inlineStr') value = textOf(inner, 't').join('');
      else if (type === 's' && raw !== undefined) value = shared[Number(raw)] ?? null;
      else if (type === 'b' && raw !== undefined) value = raw === '1';
      else if (type === 'str' && raw !== undefined) value = unesc(raw);
      else if (type === 'e' && raw !== undefined) value = { error: unesc(raw) };
      else if (raw !== undefined) value = Number(raw);
      if (value === null && formula === undefined) continue;
      cells.set(`${row},${col}`, formula !== undefined ? { value, formula: unesc(formula) } : { value });
      maxRow = Math.max(maxRow, row);
      maxCol = Math.max(maxCol, col);
    }
    out.push({ name, cells, maxRow, maxCol });
  }
  return out;
}

/** A sheet as plain text rows, for a worker to read a client's spreadsheet. */
export function sheetAsText(sheet: ReadSheet, maxRows = 200): string {
  const lines: string[] = [];
  for (let r = 0; r <= Math.min(sheet.maxRow, maxRows - 1); r += 1) {
    const cells: string[] = [];
    for (let c = 0; c <= sheet.maxCol; c += 1) {
      const cell = sheet.cells.get(`${r},${c}`);
      const v = cell?.value;
      const shown = v === null || v === undefined ? '' : isError(v) ? v.error : String(v);
      cells.push(cell?.formula ? `${shown} [=${cell.formula}]` : shown);
    }
    lines.push(cells.join('\t'));
  }
  if (sheet.maxRow >= maxRows) lines.push(`… ${sheet.maxRow + 1 - maxRows} more row(s)`);
  return lines.join('\n');
}
