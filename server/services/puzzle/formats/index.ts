/**
 * The formats this repository can actually produce or check.
 *
 * ---------------------------------------------------------------------------
 * A registry is a reading, never a taxonomy
 * ---------------------------------------------------------------------------
 *
 * This is **not** the list of puzzle formats that exist. That list is
 * `puzzle_formats`, it is built from gated claims and a person's seeds, and
 * §38 settled why a constant must not hold it: a hardcoded taxonomy answers
 * the question the kernel exists to ask, and is wrong about everything the
 * trade has taken up since somebody typed it.
 *
 * What this holds is the answer to a different question — *which of them can
 * this repository generate, and which can it check* — and that genuinely is a
 * fact about code rather than about the world. It is read by
 * `services/puzzle/maturity.ts`, which is what makes GENERATABLE and
 * VALIDATABLE unreachable for a format with nothing here: a rung above what
 * the code can do cannot be claimed, because the thing that would claim it is
 * an absence in this file.
 *
 * The gap between the two lists is therefore the most useful reading in the
 * kernel. Forty formats on the map and four here is not an embarrassment; it
 * is the work queue, stated honestly, in a place a person can see it.
 */
import { CROSSWORD } from './crossword.ts';
import { CRYPTOGRAM } from './cryptogram.ts';
import { MAZE } from './maze.ts';
import { SUDOKU } from './sudoku.ts';
import { WORD_SEARCH } from './wordsearch.ts';
import { formatKey } from '../../../domain/puzzle.ts';
import type { PuzzleFormat } from './engine.ts';

export * from './engine.ts';
export { CROSSWORD, CRYPTOGRAM, MAZE, SUDOKU, WORD_SEARCH };

const ALL: readonly PuzzleFormat[] = Object.freeze([SUDOKU, WORD_SEARCH, MAZE, CRYPTOGRAM, CROSSWORD]);

const BY_KEY: ReadonlyMap<string, PuzzleFormat> = new Map(
  ALL.map((one) => [formatKey(one.key), one] as const),
);

/** The implementation for a format name, matched the way every other row is. */
export function formatFor(name: string): PuzzleFormat | null {
  return BY_KEY.get(formatKey(name)) ?? null;
}

export function implementedFormats(): readonly PuzzleFormat[] {
  return ALL;
}

/** Whether Brain can produce this format at all, as opposed to check one. */
export function canGenerate(name: string): boolean {
  return formatFor(name)?.render !== null && formatFor(name) !== null;
}

export function canValidate(name: string): boolean {
  return formatFor(name) !== null;
}
