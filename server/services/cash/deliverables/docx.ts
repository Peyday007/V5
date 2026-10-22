/**
 * Word documents, PDFs and Markdown from one document spec.
 *
 * Headings use Word's own Heading 1-3 styles, so a client's table of contents
 * and navigation pane work. Lists are real Word lists, tables are real tables,
 * and a chart is a PNG drawn by `chart.ts` and embedded inline. Inline
 * `**bold**` and `*italic*` are the only markup a paragraph carries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Block, TableSpec } from './spec.ts';
import { chartSvg } from './chart.ts';
import { svgToPng } from './raster.ts';
import { esc, XML_HEAD } from './xml.ts';
import { coreProps } from './xlsx.ts';
import { zip } from './zip.ts';

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts');

export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** `**bold**` and `*italic*`, and nothing else. An unmatched marker is text. */
export function runs(text: string): Run[] {
  const out: Run[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false, italic: false });
    out.push(m[1] !== undefined ? { text: m[1], bold: true, italic: false } : { text: m[2]!, bold: false, italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false, italic: false });
  return out;
}

export function plain(text: string): string {
  return runs(text).map((r) => r.text).join('');
}

function wRuns(text: string, bold = false): string {
  return runs(text)
    .map((r) => `<w:r>${r.bold || r.italic || bold ? `<w:rPr>${r.bold || bold ? '<w:b/>' : ''}${r.italic ? '<w:i/>' : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`)
    .join('');
}

const EMU_PER_PX = 9525;

export interface DocInput {
  title: string;
  subtitle?: string;
  blocks: Block[];
}

export function renderDocx(doc: DocInput): { bytes: Buffer; images: number } {
  const body: string[] = [];
  const media: { name: string; data: Buffer }[] = [];
  const rels: string[] = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
  ];
  body.push(`<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${wRuns(doc.title)}</w:p>`);
  if (doc.subtitle) body.push(`<w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr>${wRuns(doc.subtitle)}</w:p>`);
  let numbered = 0;
  for (const block of doc.blocks) {
    switch (block.type) {
      case 'heading':
        body.push(`<w:p><w:pPr><w:pStyle w:val="Heading${block.level}"/></w:pPr>${wRuns(block.text)}</w:p>`);
        break;
      case 'paragraph':
        body.push(`<w:p>${wRuns(block.text)}</w:p>`);
        break;
      case 'bullets':
        for (const item of block.items) body.push(`<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${wRuns(item)}</w:p>`);
        break;
      case 'numbered': {
        numbered += 1;
        const numId = 1 + numbered; // each numbered list restarts at 1
        for (const item of block.items) body.push(`<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${wRuns(item)}</w:p>`);
        break;
      }
      case 'table':
        body.push(wordTable(block.table));
        break;
      case 'chart': {
        const image = svgToPng(chartSvg(block.chart), 960);
        const n = media.length + 1;
        media.push({ name: `word/media/chart${n}.png`, data: image.png });
        const rid = `rIdImg${n}`;
        rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart${n}.png"/>`);
        const cx = 576 * EMU_PER_PX;
        const cy = Math.round((576 * image.height) / image.width) * EMU_PER_PX;
        body.push(
          `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Chart ${n}" descr="${esc(block.chart.title ?? 'Chart')}"/>` +
            '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
            `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="chart${n}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
            `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
            `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
            '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
        );
        break;
      }
      case 'pagebreak':
        body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
        break;
    }
  }
  const document =
    `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const style = (id: string, name: string, size: number, extra = '', color = '1F2A44') =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/>${extra}</w:pPr><w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const styles =
    `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    style('Title', 'Title', 44) +
    style('Subtitle', 'Subtitle', 26, '', '5A6578') +
    style('Heading1', 'heading 1', 32, '<w:outlineLvl w:val="0"/>') +
    style('Heading2', 'heading 2', 27, '<w:outlineLvl w:val="1"/>') +
    style('Heading3', 'heading 3', 24, '<w:outlineLvl w:val="2"/>') +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:spacing w:after="60"/></w:pPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="A0A8B8"/><w:left w:val="single" w:sz="4" w:color="A0A8B8"/><w:bottom w:val="single" w:sz="4" w:color="A0A8B8"/><w:right w:val="single" w:sz="4" w:color="A0A8B8"/><w:insideH w:val="single" w:sz="4" w:color="A0A8B8"/><w:insideV w:val="single" w:sz="4" w:color="A0A8B8"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '</w:styles>';
  const abstract = (id: number, fmt: string, text: string) =>
    `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`;
  const numberingNums = ['<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'];
  for (let i = 1; i <= numbered; i += 1) {
    numberingNums.push(`<w:num w:numId="${i + 1}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`);
  }
  const numbering =
    `${XML_HEAD}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${abstract(0, 'bullet', '•')}${abstract(1, 'decimal', '%1.')}${numberingNums.join('')}</w:numbering>`;
  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
  const rootRels =
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
  const bytes = zip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rootRels) },
    { name: 'docProps/core.xml', data: Buffer.from(coreProps(doc.title)) },
    { name: 'word/document.xml', data: Buffer.from(document) },
    { name: 'word/styles.xml', data: Buffer.from(styles) },
    { name: 'word/numbering.xml', data: Buffer.from(numbering) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`) },
    ...media,
  ]);
  return { bytes, images: media.length };
}

function wordTable(table: TableSpec): string {
  const cols = table.header.length;
  const width = Math.floor(9360 / cols);
  const cell = (text: string, header: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="DCE4F2"/>' : ''}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${wRuns(text, header)}</w:p></w:tc>`;
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9360" w:type="dxa"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="' + width + '"/>'.repeat(cols)}</w:tblGrid>` +
    `<w:tr><w:trPr><w:tblHeader/></w:trPr>${table.header.map((h) => cell(h, true)).join('')}</w:tr>` +
    table.rows.map((row) => `<w:tr>${row.map((c) => cell(c, false)).join('')}</w:tr>`).join('') +
    '</w:tbl><w:p/>'
  );
}

/* =========================================================================
 * Markdown
 * ====================================================================== */

export function renderMarkdown(doc: DocInput): string {
  const out: string[] = [`# ${doc.title}`, ''];
  if (doc.subtitle) out.push(`_${doc.subtitle}_`, '');
  for (const block of doc.blocks) {
    switch (block.type) {
      case 'heading':
        out.push(`${'#'.repeat(block.level + 1)} ${block.text}`, '');
        break;
      case 'paragraph':
        out.push(block.text, '');
        break;
      case 'bullets':
        out.push(...block.items.map((i) => `- ${i}`), '');
        break;
      case 'numbered':
        out.push(...block.items.map((i, n) => `${n + 1}. ${i}`), '');
        break;
      case 'table': {
        const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        out.push(`| ${block.table.header.map(cell).join(' | ')} |`, `| ${block.table.header.map(() => '---').join(' | ')} |`);
        out.push(...block.table.rows.map((r) => `| ${r.map(cell).join(' | ')} |`), '');
        break;
      }
      case 'chart': {
        const c = block.chart;
        out.push(`**${c.title ?? 'Chart'}** (${c.type})`, '', `| Category | ${c.series.map((s) => s.name).join(' | ')} |`, `| --- | ${c.series.map(() => '---').join(' | ')} |`);
        out.push(...c.categories.map((cat, i) => `| ${cat} | ${c.series.map((s) => s.values[i]).join(' | ')} |`), '');
        break;
      }
      case 'pagebreak':
        out.push('---', '');
        break;
    }
  }
  return `${out.join('\n').trim()}\n`;
}

/* =========================================================================
 * PDF
 * ====================================================================== */

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 64;

class Typesetter {
  page!: PDFPage;
  y = 0;
  pages = 0;
  constructor(
    readonly pdf: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.newPage();
  }
  newPage(): void {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pages += 1;
    this.y = PAGE_H - MARGIN;
  }
  need(height: number): void {
    if (this.y - height < MARGIN) this.newPage();
  }
  /** Fonts here carry Latin and much else; a glyph they lack is replaced, not dropped silently. */
  clean(text: string, font: PDFFont): string {
    const chars = font.getCharacterSet();
    return [...text].map((ch) => (chars.includes(ch.codePointAt(0)!) || ch === ' ' ? ch : '?')).join('');
  }
  lines(text: string, font: PDFFont, size: number, width: number): string[] {
    const words = this.clean(text, font).split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
    return out.length ? out : [''];
  }
  paragraph(text: string, opts: { size?: number; bold?: boolean; indent?: number; colour?: [number, number, number]; after?: number; prefix?: string } = {}): void {
    const size = opts.size ?? 11;
    const indent = opts.indent ?? 0;
    const width = PAGE_W - 2 * MARGIN - indent;
    // Words keep the weight of the run they came from, so **bold** survives.
    // There is no italic face bundled, so *italic* is set upright.
    const words: { text: string; font: PDFFont }[] = [];
    for (const run of runs(text)) {
      const font = opts.bold || run.bold ? this.bold : this.regular;
      for (const word of this.clean(run.text, font).split(/\s+/).filter(Boolean)) words.push({ text: word, font });
    }
    const space = (font: PDFFont) => font.widthOfTextAtSize(' ', size);
    const lines: { text: string; font: PDFFont }[][] = [];
    let line: { text: string; font: PDFFont }[] = [];
    let used = 0;
    for (const word of words) {
      const w = word.font.widthOfTextAtSize(word.text, size);
      const add = line.length ? space(word.font) + w : w;
      if (line.length && used + add > width) {
        lines.push(line);
        line = [word];
        used = w;
      } else {
        line.push(word);
        used += add;
      }
    }
    if (line.length || lines.length === 0) lines.push(line);
    lines.forEach((words, i) => {
      this.need(size * 1.45);
      this.y -= size * 1.35;
      if (i === 0 && opts.prefix) this.page.drawText(opts.prefix, { x: MARGIN + indent - 14, y: this.y, size, font: this.regular });
      let x = MARGIN + indent;
      words.forEach((word, j) => {
        if (j > 0) x += space(word.font);
        this.page.drawText(word.text, { x, y: this.y, size, font: word.font, color: rgb(...(opts.colour ?? [0.1, 0.12, 0.16])) });
        x += word.font.widthOfTextAtSize(word.text, size);
      });
    });
    this.y -= opts.after ?? size * 0.6;
  }
  table(table: TableSpec): void {
    const cols = table.header.length;
    const colW = (PAGE_W - 2 * MARGIN) / cols;
    const size = 9;
    const drawRow = (cells: string[], header: boolean) => {
      const wrapped = cells.map((c) => this.lines(c, header ? this.bold : this.regular, size, colW - 8));
      const h = Math.max(...wrapped.map((w) => w.length)) * size * 1.3 + 8;
      this.need(h);
      if (header) this.page.drawRectangle({ x: MARGIN, y: this.y - h, width: colW * cols, height: h, color: rgb(0.86, 0.89, 0.95) });
      wrapped.forEach((lines, ci) => {
        lines.forEach((line, li) => {
          this.page.drawText(line, { x: MARGIN + ci * colW + 4, y: this.y - 4 - size - li * size * 1.3, size, font: header ? this.bold : this.regular });
        });
        this.page.drawRectangle({ x: MARGIN + ci * colW, y: this.y - h, width: colW, height: h, borderColor: rgb(0.63, 0.66, 0.72), borderWidth: 0.5 });
      });
      this.y -= h;
    };
    drawRow(table.header, true);
    for (const row of table.rows) drawRow(row, false);
    this.y -= 12;
  }
}

export async function renderPdf(doc: DocInput): Promise<{ bytes: Buffer; pages: number }> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(doc.title);
  pdf.setProducer('Brain');
  pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const regular = await pdf.embedFont(fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans.ttf')), { subset: true });
  const bold = await pdf.embedFont(fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')), { subset: true });
  const t = new Typesetter(pdf, regular, bold);
  t.paragraph(doc.title, { size: 22, bold: true, after: 6 });
  if (doc.subtitle) t.paragraph(doc.subtitle, { size: 13, colour: [0.35, 0.4, 0.47], after: 14 });
  for (const block of doc.blocks) {
    switch (block.type) {
      case 'heading':
        t.need(40);
        t.y -= 6;
        t.paragraph(block.text, { size: block.level === 1 ? 16 : block.level === 2 ? 13.5 : 12, bold: true, colour: [0.12, 0.16, 0.27], after: 4 });
        break;
      case 'paragraph':
        t.paragraph(block.text);
        break;
      case 'bullets':
        for (const item of block.items) t.paragraph(item, { indent: 18, prefix: '•', after: 2 });
        t.y -= 6;
        break;
      case 'numbered':
        block.items.forEach((item, i) => t.paragraph(item, { indent: 22, prefix: `${i + 1}.`, after: 2 }));
        t.y -= 6;
        break;
      case 'table':
        t.table(block.table);
        break;
      case 'chart': {
        const image = svgToPng(chartSvg(block.chart), 960);
        const png = await pdf.embedPng(image.png);
        const w = PAGE_W - 2 * MARGIN;
        const h = (w * image.height) / image.width;
        t.need(h + 10);
        t.page.drawImage(png, { x: MARGIN, y: t.y - h, width: w, height: h });
        t.y -= h + 12;
        break;
      }
      case 'pagebreak':
        t.newPage();
        break;
    }
  }
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  return { bytes, pages: t.pages };
}
