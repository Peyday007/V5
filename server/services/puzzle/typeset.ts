/**
 * A validated sudoku catalog laid out as a print-ready book interior.
 *
 * `TYPESET_FOR_PRINT` read MISSING: a puzzle rendered as text, which proves it
 * and cannot be sold as a book. This is the smallest version that removes that
 * gap for one format. It produces an 8.5" × 11" interior with no bleed, which is
 * a standard Amazon KDP paperback trim. It is also a printable PDF a buyer can
 * use as it is.
 *
 * What makes the output acceptable to KDP is checked here rather than assumed.
 *
 * - **Margins.** KDP publishes its minimums by page count: an inside (gutter)
 *   margin of 0.375" for 24–150 pages, 0.5" for 151–300 and 0.625" for
 *   301–500, and at least 0.25" on the other three sides without bleed
 *   (kdp.amazon.com, "Set Trim Size, Bleed, and Margins", read 2026-10-18).
 *   This layout uses 0.75" inside and 0.5" elsewhere, and refuses a page count
 *   whose minimum gutter would exceed that.
 * - **Fonts.** KDP rejects an interior whose fonts are not embedded, and
 *   pdf-lib's standard fonts are referenced rather than embedded. DejaVu Sans is
 *   bundled (`server/assets/fonts`, Bitstream Vera licence) and embedded as a
 *   subset.
 * - **Page count.** KDP's paperback minimum is 24 pages, so a book that would
 *   be shorter is refused rather than padded with blank pages.
 *
 * Nothing here judges a puzzle. Every puzzle handed in must already carry a
 * VALID verdict from the format's own validator, which reads the printed grid
 * and nothing else. The book prints exactly the grid and answer key that the
 * validator saw.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { PuzzleArtifact, PuzzleVerdict } from './formats/engine.ts';

const INCH = 72;
export const TRIM = { width: 8.5 * INCH, height: 11 * INCH } as const;
export const MARGIN = { inside: 0.75 * INCH, outside: 0.5 * INCH, top: 0.5 * INCH, bottom: 0.5 * INCH } as const;

/** KDP's published minimum gutter by page count, in inches. */
export function minimumGutterInches(pages: number): number | null {
  if (pages < 24) return null;
  if (pages <= 150) return 0.375;
  if (pages <= 300) return 0.5;
  if (pages <= 500) return 0.625;
  if (pages <= 700) return 0.75;
  if (pages <= 828) return 0.875;
  return null;
}

export const KDP_MINIMUM_PAGES = 24;

export interface BookPuzzle {
  artifact: PuzzleArtifact;
  verdict: PuzzleVerdict;
}

export interface BookInput {
  title: string;
  subtitle: string;
  /** Printed on the copyright page, verbatim. */
  rightsNotice: string;
  puzzles: readonly BookPuzzle[];
  /** STANDARD prints two puzzles a page; LARGE_PRINT prints one, with larger digits. */
  layout?: 'STANDARD' | 'LARGE_PRINT';
}

export interface TypesetBook {
  bytes: Uint8Array;
  pages: number;
}

export class TypesetRefusal extends Error {}

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');

const DIFFICULTY_LABEL: Record<string, string> = {
  EASY: 'Easy',
  MEDIUM: 'Medium',
  HARD: 'Hard',
  EXPERT: 'Expert',
};

function contentBox(pageIndex: number) {
  // Recto pages (odd page numbers, so even indices) have the gutter on the left.
  const recto = pageIndex % 2 === 0;
  const left = recto ? MARGIN.inside : MARGIN.outside;
  const right = TRIM.width - (recto ? MARGIN.outside : MARGIN.inside);
  return { left, right, top: TRIM.height - MARGIN.top, bottom: MARGIN.bottom, width: right - left };
}

function centred(page: PDFPage, font: PDFFont, text: string, size: number, y: number, box: ReturnType<typeof contentBox>) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: box.left + (box.width - width) / 2, y, size, font, color: rgb(0, 0, 0) });
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** One 9×9 grid with heavier box lines; `cells` are rows of digits or '.'. */
function drawSudoku(
  page: PDFPage,
  font: PDFFont,
  cells: readonly string[],
  x: number,
  y: number,
  size: number,
  givens: readonly string[] | null,
) {
  const cell = size / 9;
  for (let i = 0; i <= 9; i += 1) {
    const thickness = i % 3 === 0 ? 2 : 0.6;
    page.drawLine({ start: { x: x + i * cell, y }, end: { x: x + i * cell, y: y + size }, thickness });
    page.drawLine({ start: { x, y: y + i * cell }, end: { x: x + size, y: y + i * cell }, thickness });
  }
  const fontSize = cell * 0.55;
  for (let r = 0; r < 9; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      const ch = cells[r]![c]!;
      if (ch === '.') continue;
      // On the answer page, the digits the solver had to find are printed lighter.
      const given = givens ? givens[r]![c] !== '.' : true;
      const w = font.widthOfTextAtSize(ch, fontSize);
      page.drawText(ch, {
        x: x + c * cell + (cell - w) / 2,
        y: y + (8 - r) * cell + (cell - fontSize * 0.72) / 2,
        size: fontSize,
        font,
        color: given ? rgb(0, 0, 0) : rgb(0.45, 0.45, 0.45),
      });
    }
  }
}

export async function typesetSudokuBook(input: BookInput): Promise<TypesetBook> {
  if (input.puzzles.length === 0) throw new TypesetRefusal('A book needs at least one puzzle.');
  for (const [index, one] of input.puzzles.entries()) {
    if (one.artifact.formatKey !== 'sudoku') {
      throw new TypesetRefusal(`Puzzle ${index + 1} is ${one.artifact.formatKey}; only sudoku is typeset here.`);
    }
    if (one.verdict.state !== 'VALID') {
      throw new TypesetRefusal(`Puzzle ${index + 1} did not pass its validator, so it cannot be printed.`);
    }
  }

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans.ttf')), { subset: true });
  const bold = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')), { subset: true });
  doc.setTitle(input.title);
  doc.setSubject(input.subtitle);
  doc.setCreator('Brain puzzle kernel');
  doc.setProducer('pdf-lib');
  // Fixed, so the same puzzles always make the same bytes and the manifest's
  // sha-256 can be checked by re-running.
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));

  let pageNumber = 0;
  const addPage = (numbered: boolean) => {
    const page = doc.addPage([TRIM.width, TRIM.height]);
    const box = contentBox(pageNumber);
    pageNumber += 1;
    if (numbered) centred(page, regular, String(pageNumber), 9, MARGIN.bottom - 2, box);
    return { page, box };
  };

  // Title page.
  {
    const { page, box } = addPage(false);
    const titleLines = wrap(bold, input.title, 30, box.width);
    let y = TRIM.height * 0.62;
    for (const line of titleLines) {
      centred(page, bold, line, 30, y, box);
      y -= 38;
    }
    y -= 6;
    for (const line of wrap(regular, input.subtitle, 14, box.width)) {
      centred(page, regular, line, 14, y, box);
      y -= 20;
    }
  }
  // Copyright and rights page.
  {
    const { page, box } = addPage(false);
    let y = box.top - 20;
    for (const line of wrap(regular, input.rightsNotice, 10, box.width)) {
      page.drawText(line, { x: box.left, y, size: 10, font: regular });
      y -= 14;
    }
  }
  // How to play.
  {
    const { page, box } = addPage(true);
    page.drawText('How to play', { x: box.left, y: box.top - 30, size: 20, font: bold });
    let y = box.top - 64;
    for (const line of wrap(regular, input.puzzles[0]!.artifact.instructions, 12, box.width)) {
      page.drawText(line, { x: box.left, y, size: 12, font: regular });
      y -= 18;
    }
    y -= 10;
    const note =
      'Every puzzle in this book was checked by a solver that read only the printed grid, and has ' +
      'exactly one solution. Difficulty is measured by solving rather than estimated. Solutions ' +
      'are at the back of the book.';
    for (const line of wrap(regular, note, 12, box.width)) {
      page.drawText(line, { x: box.left, y, size: 12, font: regular });
      y -= 18;
    }
  }

  // Puzzles: two per page, or one per page in large print.
  const perPage = input.layout === 'LARGE_PRINT' ? 1 : 2;
  const gridSize = perPage === 1 ? 6.8 * INCH : 4.1 * INCH;
  for (let i = 0; i < input.puzzles.length; i += perPage) {
    const { page, box } = addPage(true);
    for (let j = 0; j < perPage && i + j < input.puzzles.length; j += 1) {
      const one = input.puzzles[i + j]!;
      const label = `Puzzle ${i + j + 1}  ·  ${DIFFICULTY_LABEL[one.verdict.measuredDifficulty ?? ''] ?? 'Unrated'}`;
      const slotTop = j === 0 ? box.top : box.top - (box.top - box.bottom) / 2;
      const labelSize = perPage === 1 ? 18 : 12;
      page.drawText(label, { x: box.left + (box.width - gridSize) / 2, y: slotTop - labelSize - 6, size: labelSize, font: bold });
      drawSudoku(page, regular, one.artifact.grid, box.left + (box.width - gridSize) / 2, slotTop - labelSize - 18 - gridSize, gridSize, null);
    }
  }

  // Solutions, six per page.
  const small = 2.25 * INCH;
  for (let i = 0; i < input.puzzles.length; i += 6) {
    const { page, box } = addPage(true);
    if (i === 0) page.drawText('Solutions', { x: box.left, y: box.top - 18, size: 16, font: bold });
    const top = box.top - 40;
    const gapX = (box.width - 2 * small) / 3;
    for (let j = 0; j < 6 && i + j < input.puzzles.length; j += 1) {
      const one = input.puzzles[i + j]!;
      const col = j % 2;
      const row = Math.floor(j / 2);
      const x = box.left + gapX + col * (small + gapX);
      const y = top - 16 - row * (small + 34) - small;
      page.drawText(`Puzzle ${i + j + 1}`, { x, y: y + small + 4, size: 9, font: bold });
      drawSudoku(page, regular, one.artifact.answerKey, x, y, small, one.artifact.grid);
    }
  }

  const pages = doc.getPageCount();
  if (pages < KDP_MINIMUM_PAGES) {
    throw new TypesetRefusal(`The book is ${pages} pages; KDP's paperback minimum is ${KDP_MINIMUM_PAGES}. Add puzzles.`);
  }
  const gutter = minimumGutterInches(pages);
  if (gutter === null || gutter * INCH > MARGIN.inside) {
    throw new TypesetRefusal(`At ${pages} pages KDP needs a wider gutter than this layout's ${MARGIN.inside / INCH}".`);
  }
  return { bytes: await doc.save({ useObjectStreams: false }), pages };
}
