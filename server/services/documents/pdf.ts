/**
 * PDF extraction.
 *
 * pdfjs gives us positioned text items rather than paragraphs, so the work here
 * is reconstructing reading order: group items into lines by baseline, lines into
 * columns by x-position, columns left-to-right, and lines into blocks by vertical
 * gaps and font size.
 *
 * The important discipline is section 5: a non-empty extraction is NOT proof of
 * success. Every page carries the signals that let the quality gate decide
 * whether what we read is trustworthy.
 */
import type { BlockType } from '../../domain/types.ts';

export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtractedBlock {
  pageNumber: number;
  blockType: BlockType;
  text: string;
  bbox: [number, number, number, number] | null;
  /** Per-block problems, e.g. replacement glyphs. */
  warnings: string[];
}

export interface ExtractedPage {
  pageNumber: number;
  blocks: ExtractedBlock[];
  characterCount: number;
  /** Text items found before layout reconstruction; 0 means an image-only page. */
  itemCount: number;
  width: number;
  height: number;
  /** Signals for the quality gate, not decisions. */
  signals: PageSignals;
}

export interface PageSignals {
  /** Characters per thousand square points; very low suggests a scan. */
  characterDensity: number;
  columnCount: number;
  hasReplacementGlyphs: boolean;
  /** Very short pages that are almost certainly not real content. */
  nearlyEmpty: boolean;
}

export interface PdfExtraction {
  pages: ExtractedPage[];
  pageCount: number;
  /** Producer/creator when the file declares them; useful when diagnosing a bad extraction. */
  producer: string | null;
  encrypted: boolean;
}

export class PdfUnreadableError extends Error {
  readonly reason: string;
  readonly recovery: string;

  constructor(reason: string, recovery: string) {
    super(reason);
    this.name = 'PdfUnreadableError';
    this.reason = reason;
    this.recovery = recovery;
  }
}

/** U+FFFD and the private-use glyphs a broken font mapping produces. */
const REPLACEMENT_RE = /[�-]/;

/** Items on roughly the same baseline belong to the same line. */
const LINE_TOLERANCE = 2.2;

interface Line {
  y: number;
  x0: number;
  x1: number;
  height: number;
  items: PdfTextItem[];
  text: string;
}

function buildLines(items: PdfTextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const item of sorted) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= LINE_TOLERANCE);
    if (line) {
      line.items.push(item);
      line.x0 = Math.min(line.x0, item.x);
      line.x1 = Math.max(line.x1, item.x + item.width);
      line.height = Math.max(line.height, item.height);
    } else {
      lines.push({
        y: item.y,
        x0: item.x,
        x1: item.x + item.width,
        height: item.height,
        items: [item],
        text: '',
      });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    // pdfjs already emits spacing as separate items in most producers; join and
    // collapse rather than guessing at inter-item gaps.
    line.text = line.items
      .map((item) => item.text)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return lines.filter((line) => line.text.length > 0);
}

/**
 * Detect columns by looking for a vertical corridor with no text in it.
 *
 * A two-column page read straight down the middle produces interleaved nonsense,
 * which is one of the failure modes section 5 names explicitly.
 */
function detectColumns(lines: Line[], pageWidth: number): number[] {
  if (lines.length < 6) return [0, pageWidth];

  // Sample occupancy across the page in narrow bands.
  const bands = 60;
  const bandWidth = pageWidth / bands;
  const occupied = new Array<number>(bands).fill(0);
  for (const line of lines) {
    const from = Math.max(0, Math.floor(line.x0 / bandWidth));
    const to = Math.min(bands - 1, Math.floor(line.x1 / bandWidth));
    for (let band = from; band <= to; band += 1) occupied[band] = (occupied[band] ?? 0) + 1;
  }

  // A gutter is a run of empty bands away from the margins.
  const marginBands = Math.floor(bands * 0.15);
  let gutterStart = -1;
  let bestGutter: { start: number; end: number } | null = null;
  for (let band = marginBands; band < bands - marginBands; band += 1) {
    if ((occupied[band] ?? 0) === 0) {
      if (gutterStart === -1) gutterStart = band;
    } else if (gutterStart !== -1) {
      const width = band - gutterStart;
      if (width >= 2 && (bestGutter === null || width > bestGutter.end - bestGutter.start)) {
        bestGutter = { start: gutterStart, end: band };
      }
      gutterStart = -1;
    }
  }
  if (!bestGutter) return [0, pageWidth];

  const split = ((bestGutter.start + bestGutter.end) / 2) * bandWidth;
  return [0, split, pageWidth];
}

function assignColumn(line: Line, boundaries: number[]): number {
  const centre = (line.x0 + line.x1) / 2;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    if (centre >= (boundaries[index] ?? 0) && centre < (boundaries[index + 1] ?? Infinity)) {
      return index;
    }
  }
  return 0;
}

/** A short line noticeably larger than the body text reads as a heading. */
function isHeading(line: Line, bodyHeight: number): boolean {
  return line.height >= bodyHeight * 1.15 && line.text.length <= 120;
}

const LIST_RE = /^\s*(?:[-*•‣◦·]|\(?\d{1,3}[.)]|[a-z][.)])\s+/i;

function classify(line: Line, bodyHeight: number): BlockType {
  if (LIST_RE.test(line.text)) return 'LIST_ITEM';
  if (isHeading(line, bodyHeight)) return 'HEADING';
  return 'PARAGRAPH';
}

/** Median line height stands in for body text size. */
function medianHeight(lines: Line[]): number {
  if (lines.length === 0) return 10;
  const heights = lines.map((line) => line.height).sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)] ?? 10;
}

/**
 * Group lines into blocks: a blank-ish vertical gap, a change of block type or a
 * heading all start a new one.
 */
function buildBlocks(lines: Line[], pageNumber: number, bodyHeight: number): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  let current: { type: BlockType; lines: Line[] } | null = null;

  const flush = (): void => {
    if (!current || current.lines.length === 0) return;
    const text = current.lines.map((line) => line.text).join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > 0) {
      const x0 = Math.min(...current.lines.map((line) => line.x0));
      const x1 = Math.max(...current.lines.map((line) => line.x1));
      const y0 = Math.min(...current.lines.map((line) => line.y));
      const y1 = Math.max(...current.lines.map((line) => line.y + line.height));
      blocks.push({
        pageNumber,
        blockType: current.type,
        text,
        bbox: [x0, y0, x1, y1],
        warnings: REPLACEMENT_RE.test(text)
          ? ['Contains replacement or private-use glyphs; the font mapping may be broken.']
          : [],
      });
    }
    current = null;
  };

  for (const [index, line] of lines.entries()) {
    const type = classify(line, bodyHeight);
    const previous = lines[index - 1];
    const gap = previous ? previous.y - line.y : 0;
    const paragraphBreak = previous !== undefined && gap > bodyHeight * 1.8;

    if (!current || current.type !== type || paragraphBreak || type === 'HEADING') {
      flush();
      current = { type, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return blocks;
}

/** Turn one page's positioned items into ordered blocks plus quality signals. */
export function layoutPage(
  pageNumber: number,
  items: PdfTextItem[],
  width: number,
  height: number,
): ExtractedPage {
  const lines = buildLines(items);
  const bodyHeight = medianHeight(lines);
  const boundaries = detectColumns(lines, width);
  const columnCount = boundaries.length - 1;

  // Read each column top-to-bottom, columns left-to-right.
  const ordered: Line[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    ordered.push(
      ...lines
        .filter((line) => assignColumn(line, boundaries) === column)
        .sort((a, b) => b.y - a.y || a.x0 - b.x0),
    );
  }

  const blocks = buildBlocks(ordered, pageNumber, bodyHeight);
  const characterCount = blocks.reduce((total, block) => total + block.text.length, 0);
  const area = Math.max(1, width * height);

  return {
    pageNumber,
    blocks,
    characterCount,
    itemCount: items.length,
    width,
    height,
    signals: {
      characterDensity: (characterCount / area) * 1000,
      columnCount,
      hasReplacementGlyphs: blocks.some((block) => block.warnings.length > 0),
      nearlyEmpty: characterCount < 40,
    },
  };
}

/**
 * Repeated page headers and footers.
 *
 * A line that appears in the same position on most pages is furniture, not
 * content. It is relabelled rather than deleted, so nothing is lost.
 */
export function markRepeatedFurniture(pages: ExtractedPage[]): void {
  if (pages.length < 3) return;
  const threshold = Math.max(2, Math.ceil(pages.length * 0.6));

  const counts = new Map<string, number>();
  const key = (block: ExtractedBlock, page: ExtractedPage): string => {
    const top = (block.bbox?.[3] ?? 0) > page.height * 0.9;
    const bottom = (block.bbox?.[1] ?? page.height) < page.height * 0.1;
    if (!top && !bottom) return '';
    // Page numbers differ per page; compare with digits masked out.
    return `${top ? 'H' : 'F'}:${block.text.replace(/\d+/g, '#')}`;
  };

  for (const page of pages) {
    for (const block of page.blocks) {
      const id = key(block, page);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  for (const page of pages) {
    for (const block of page.blocks) {
      const id = key(block, page);
      if (!id) continue;
      if ((counts.get(id) ?? 0) >= threshold) {
        block.blockType = id.startsWith('H') ? 'PAGE_HEADER' : 'PAGE_FOOTER';
      }
    }
  }
}

/**
 * Read a PDF page by page.
 *
 * Encrypted, malformed and unsupported files raise `PdfUnreadableError` with the
 * reason and the recovery action, rather than returning an empty string that the
 * auditor would mistake for content.
 */
export async function extractPdf(buffer: Buffer): Promise<PdfExtraction> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfDocumentProxy> };
  };

  let doc: PdfDocumentProxy;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      // Keep parsing local and inert: no eval, no network font fetches.
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password|encrypt/i.test(message)) {
      throw new PdfUnreadableError(
        'The PDF is password-protected or encrypted, so its text cannot be read.',
        'Save an unprotected copy and import that. The original file is preserved unchanged.',
      );
    }
    throw new PdfUnreadableError(
      `The PDF could not be parsed: ${message}`,
      'The file may be truncated or corrupt. Re-export it from the source and import again.',
    );
  }

  const pageCount = doc.numPages;
  if (pageCount === 0) {
    throw new PdfUnreadableError(
      'The PDF reports zero pages.',
      'Re-export the document from its source and import again.',
    );
  }

  let producer: string | null = null;
  try {
    const metadata = await doc.getMetadata();
    const info = metadata.info as { Producer?: string; Creator?: string } | undefined;
    producer = info?.Producer ?? info?.Creator ?? null;
  } catch {
    // Metadata is a nicety; its absence is not a failure.
  }

  const pages: ExtractedPage[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    try {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = content.items
        .filter((item): item is TextItem => typeof (item as TextItem).str === 'string')
        .map((item) => ({
          text: item.str,
          x: item.transform[4] ?? 0,
          y: item.transform[5] ?? 0,
          width: item.width ?? 0,
          height: item.height ?? 0,
        }))
        .filter((item) => item.text.length > 0);
      pages.push(layoutPage(pageNumber, items, viewport.width, viewport.height));
    } catch (error) {
      // One bad page must not lose the other forty-nine; record it as failed and
      // let the quality gate decide whether the document is still usable.
      pages.push({
        pageNumber,
        blocks: [],
        characterCount: 0,
        itemCount: 0,
        width: 612,
        height: 792,
        signals: {
          characterDensity: 0,
          columnCount: 1,
          hasReplacementGlyphs: false,
          nearlyEmpty: true,
        },
      });
    }
  }

  markRepeatedFurniture(pages);
  return { pages, pageCount, producer, encrypted: false };
}

// Minimal structural types for the parts of pdfjs we use.
interface TextItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
}

interface PdfPageProxy {
  getViewport(options: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: unknown[] }>;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  getMetadata(): Promise<{ info: unknown }>;
}
