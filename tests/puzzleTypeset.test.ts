/**
 * A sudoku interior a print-on-demand service will accept, made only from
 * puzzles the independent validator proved.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { SUDOKU, MAZE } from '../server/services/puzzle/formats/index.ts';
import {
  KDP_MINIMUM_PAGES,
  MARGIN,
  TRIM,
  TypesetRefusal,
  minimumGutterInches,
  typesetSudokuBook,
  type BookPuzzle,
} from '../server/services/puzzle/typeset.ts';
import { puzzleCapabilities } from '../server/services/puzzle/capabilities.ts';

function puzzles(count: number, prefix = 't'): BookPuzzle[] {
  return Array.from({ length: count }, (_, i) => {
    const artifact = SUDOKU.render!({
      formatKey: 'sudoku',
      corpusId: 'common-english-v1',
      seed: `${prefix}-${i}`,
      parameters: { difficulty: 'EASY' },
    });
    return { artifact, verdict: SUDOKU.validate(artifact) };
  });
}

const book = (list: BookPuzzle[]) =>
  typesetSudokuBook({ title: 'Test', subtitle: 'Sub', rightsNotice: 'Rights.', puzzles: list });

describe('a sudoku book interior', () => {
  it('is letter size, at least KDP minimum length, with every font embedded', async () => {
    const list = puzzles(40);
    expect(list.every((one) => one.verdict.state === 'VALID')).toBe(true);
    const out = await book(list);
    const doc = await PDFDocument.load(out.bytes);
    expect(out.pages).toBe(doc.getPageCount());
    expect(out.pages).toBeGreaterThanOrEqual(KDP_MINIMUM_PAGES);
    for (const page of doc.getPages()) {
      expect(page.getSize()).toEqual({ width: TRIM.width, height: TRIM.height });
    }
    const text = Buffer.from(out.bytes).toString('latin1');
    // Embedded TrueType programs, and no unembedded standard-14 font reference.
    expect(text).toContain('/FontFile2');
    expect(text).not.toMatch(/\/BaseFont \/(Helvetica|Times|Courier)/);
  }, 60_000);

  it('keeps margins at or above KDP minimums for its page count', () => {
    expect(MARGIN.outside).toBeGreaterThanOrEqual(0.25 * 72);
    expect(MARGIN.top).toBeGreaterThanOrEqual(0.25 * 72);
    expect(MARGIN.bottom).toBeGreaterThanOrEqual(0.25 * 72);
    expect(MARGIN.inside).toBeGreaterThanOrEqual(minimumGutterInches(150)! * 72);
    expect(minimumGutterInches(23)).toBeNull();
  });

  it('makes the same bytes from the same puzzles', async () => {
    const a = await book(puzzles(40, 'same'));
    const b = await book(puzzles(40, 'same'));
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  }, 60_000);

  it('refuses a puzzle the validator did not pass, a non-sudoku, and a book under 24 pages', async () => {
    const list = puzzles(40);
    const broken = { ...list[0]!, verdict: { ...list[0]!.verdict, state: 'INVALID' as const } };
    await expect(book([broken, ...list.slice(1)])).rejects.toBeInstanceOf(TypesetRefusal);

    const maze = MAZE.render!({ formatKey: 'maze', corpusId: 'common-english-v1', seed: 'm', parameters: {} });
    await expect(book([{ artifact: maze, verdict: MAZE.validate(maze) }, ...list])).rejects.toThrow(/only sudoku/);

    await expect(book(puzzles(4))).rejects.toThrow(/KDP's paperback minimum/);
  }, 60_000);

  it('prints one puzzle a page in large print, inside the same gutter rule', async () => {
    const list = puzzles(40, 'lp');
    const standard = await book(list);
    const large = await typesetSudokuBook({ title: 'T', subtitle: 'S', rightsNotice: 'R', puzzles: list, layout: 'LARGE_PRINT' });
    // 3 front pages + 40 puzzle pages + 7 solution pages.
    expect(large.pages).toBe(50);
    expect(large.pages).toBeGreaterThan(standard.pages);
  }, 60_000);

  it('reports typesetting as present, for sudoku only', () => {
    const typeset = puzzleCapabilities().find((one) => one.id === 'TYPESET_FOR_PRINT')!;
    expect(typeset.state).toBe('PRESENT');
    expect(typeset.reading).toMatch(/^Sudoku only/);
  });
});
